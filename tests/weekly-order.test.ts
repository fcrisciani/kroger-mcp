import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/kroger.js", () => ({
  getProductsByIds: vi.fn(),
  addItemsToCart: vi.fn(),
}));

import { addItemsToCart, getProductsByIds, type KrogerProduct } from "../src/kroger.js";
import { getUsualItems, recordOrderedItems, saveUsualItems, setDefaultLocationId } from "../src/storage.js";
import type { Env, UsualItem } from "../src/types.js";
import { runWeeklyOrder } from "../src/weekly-order.js";
import { makeEnv, MemoryKV } from "./helpers.js";

const milk: UsualItem = {
  productId: "0001111041700",
  name: "Whole Milk, 1 gal",
  defaultQty: 1,
  cadence: "weekly",
  timesOrdered: 0,
};

const bread: UsualItem = {
  productId: "0001111041800",
  name: "Sourdough Loaf",
  defaultQty: 1,
  cadence: "weekly",
  timesOrdered: 0,
};

function product(p: Partial<KrogerProduct> & Pick<KrogerProduct, "productId" | "upc" | "description">): KrogerProduct {
  return {
    onSale: false,
    ...p,
  };
}

describe("runWeeklyOrder", () => {
  let kv: MemoryKV;
  let env: Env;
  const getProducts = vi.mocked(getProductsByIds);
  const addCart = vi.mocked(addItemsToCart);

  beforeEach(() => {
    vi.clearAllMocks();
    kv = new MemoryKV();
    env = makeEnv({ KROGER_KV: kv as unknown as KVNamespace });
    addCart.mockResolvedValue(undefined);
  });

  it("regression: an item that doesn't resolve at the store keeps its lastOrdered untouched", async () => {
    // Seed two due usuals, both never ordered.
    await saveUsualItems(env, { items: [milk, bread], updatedAt: new Date(0).toISOString() });
    // The store has milk but not bread.
    const milkUpc = "0001111041700";
    getProducts.mockResolvedValue([product({ productId: milk.productId, upc: milkUpc, description: milk.name, regularPrice: 4.99 })]);

    const text = await runWeeklyOrder(env, {});

    // Cart received only the resolved item.
    expect(addCart).toHaveBeenCalledOnce();
    const cartArg = addCart.mock.calls[0]![1] as Array<{ upc: string }>;
    expect(cartArg.map((c) => c.upc)).toEqual([milkUpc]);

    // Bookkeeping: milk gets lastOrdered, bread does NOT.
    const after = await getUsualItems(env);
    const milkAfter = after.items.find((i) => i.productId === milk.productId);
    const breadAfter = after.items.find((i) => i.productId === bread.productId);
    expect(milkAfter?.lastOrdered).toBeTypeOf("string");
    expect(milkAfter?.timesOrdered).toBe(1);
    expect(breadAfter?.lastOrdered).toBeUndefined();
    expect(breadAfter?.timesOrdered).toBe(0);

    // Summary surfaces the skipped item up front.
    expect(text).toContain("1 of 2");
    expect(text).toContain("Skipped");
    expect(text).toContain(bread.name);
  });

  it("returns a clear message and skips both calls when nothing is due", async () => {
    const recent = new Date().toISOString();
    await saveUsualItems(env, {
      items: [{ ...milk, lastOrdered: recent, timesOrdered: 5 }],
      updatedAt: recent,
    });

    const text = await runWeeklyOrder(env, {});

    expect(text).toContain("No items are due");
    expect(getProducts).not.toHaveBeenCalled();
    expect(addCart).not.toHaveBeenCalled();
  });

  it("includeAll bypasses the cadence filter", async () => {
    const recent = new Date().toISOString();
    await saveUsualItems(env, {
      items: [{ ...milk, lastOrdered: recent, timesOrdered: 5 }],
      updatedAt: recent,
    });
    getProducts.mockResolvedValue([
      product({ productId: milk.productId, upc: "001", description: milk.name, regularPrice: 4.99 }),
    ]);

    await runWeeklyOrder(env, { includeAll: true });

    expect(addCart).toHaveBeenCalledOnce();
  });

  it("emits a warning in the summary when bookkeeping fails after a successful cart-add", async () => {
    await saveUsualItems(env, { items: [milk], updatedAt: new Date(0).toISOString() });
    getProducts.mockResolvedValue([
      product({ productId: milk.productId, upc: "001", description: milk.name, regularPrice: 4.99 }),
    ]);

    // Spy on recordOrderedItems by patching the KV's put to throw on the
    // usual_items key write that recordOrderedItems performs.
    const realPut = kv.put.bind(kv);
    kv.put = (async (key: string, value: string) => {
      if (key === "prefs:usual_items") throw new Error("kv unavailable");
      return realPut(key, value);
    }) as typeof kv.put;

    const text = await runWeeklyOrder(env, {});

    // Cart-add was still successful — the tool didn't throw.
    expect(addCart).toHaveBeenCalledOnce();
    expect(text).toContain("Items were added");
    expect(text).toContain("kv unavailable");
  });

  it("forwards the default location to getProductsByIds", async () => {
    await saveUsualItems(env, { items: [milk], updatedAt: new Date(0).toISOString() });
    await setDefaultLocationId(env, "01400376");
    getProducts.mockResolvedValue([
      product({ productId: milk.productId, upc: "001", description: milk.name }),
    ]);

    await runWeeklyOrder(env, {});

    expect(getProducts).toHaveBeenCalledWith(env, expect.objectContaining({ locationId: "01400376" }));
  });
});

describe("recordOrderedItems (sanity)", () => {
  it("only bumps items whose productIds are in the input set", async () => {
    const kv = new MemoryKV();
    const env = makeEnv({ KROGER_KV: kv as unknown as KVNamespace });
    await saveUsualItems(env, { items: [milk, bread], updatedAt: new Date(0).toISOString() });

    await recordOrderedItems(env, [milk.productId]);

    const after = await getUsualItems(env);
    expect(after.items.find((i) => i.productId === milk.productId)?.timesOrdered).toBe(1);
    expect(after.items.find((i) => i.productId === bread.productId)?.timesOrdered).toBe(0);
  });
});
