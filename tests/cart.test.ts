import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/kroger.js", () => ({
  addItemsToCart: vi.fn(),
  getProductsByIds: vi.fn(),
  searchProducts: vi.fn(),
}));

import { buildCart } from "../src/cart.js";
import { addItemsToCart, getProductsByIds, searchProducts, type KrogerProduct } from "../src/kroger.js";
import { setDefaultLocationChain, setDefaultLocationId } from "../src/storage.js";
import { makeEnv, MemoryKV } from "./helpers.js";

function product(p: Partial<KrogerProduct> & Pick<KrogerProduct, "productId" | "upc" | "description">): KrogerProduct {
  return { onSale: false, ...p };
}

describe("buildCart", () => {
  const addCart = vi.mocked(addItemsToCart);
  const getProducts = vi.mocked(getProductsByIds);
  const search = vi.mocked(searchProducts);
  let kv: MemoryKV;

  beforeEach(() => {
    vi.clearAllMocks();
    kv = new MemoryKV();
    addCart.mockResolvedValue(undefined);
    getProducts.mockResolvedValue([]);
    search.mockResolvedValue([]);
  });

  function env() {
    return makeEnv({ KROGER_KV: kv as unknown as KVNamespace });
  }

  it("adds an explicit upc line as-is, no lookup", async () => {
    const r = await buildCart(env(), [{ upc: "0001111041700", quantity: 2 }]);
    expect(getProducts).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(addCart).toHaveBeenCalledOnce();
    expect(addCart.mock.calls[0]![1]).toEqual([{ upc: "0001111041700", quantity: 2, modality: undefined }]);
    expect(r.added).toEqual([{ from: "upc 0001111041700", upc: "0001111041700", quantity: 2, name: undefined, price: undefined }]);
    expect(r.skipped).toEqual([]);
  });

  it("resolves productId lines via one getProductsByIds call", async () => {
    getProducts.mockResolvedValueOnce([
      product({ productId: "P1", upc: "U1", description: "Whole Milk", regularPrice: 4.99 }),
      product({ productId: "P2", upc: "U2", description: "Sourdough", regularPrice: 3.49 }),
    ]);
    const r = await buildCart(env(), [
      { productId: "P1", quantity: 1 },
      { productId: "P2", quantity: 2 },
    ]);
    expect(getProducts).toHaveBeenCalledOnce();
    expect(getProducts.mock.calls[0]![1].productIds).toEqual(["P1", "P2"]);
    expect(addCart.mock.calls[0]![1]).toEqual([
      { upc: "U1", quantity: 1, modality: undefined },
      { upc: "U2", quantity: 2, modality: undefined },
    ]);
    expect(r.added.map((a) => a.name)).toEqual(["Whole Milk", "Sourdough"]);
    expect(r.added[0]?.price).toBe("$4.99");
  });

  it("skips a productId that doesn't resolve at this store, but still adds the rest", async () => {
    getProducts.mockResolvedValueOnce([product({ productId: "P1", upc: "U1", description: "Milk" })]);
    const r = await buildCart(env(), [{ productId: "P1" }, { productId: "PMISSING" }]);
    expect(addCart.mock.calls[0]![1]).toEqual([{ upc: "U1", quantity: 1, modality: undefined }]);
    expect(r.added).toHaveLength(1);
    expect(r.skipped).toEqual([{ from: "productId PMISSING", reason: expect.stringContaining("not available") }]);
  });

  it("resolves a query line to the top search match", async () => {
    search.mockResolvedValueOnce([
      product({ productId: "PB", upc: "UB", description: "Sweet Basil, bunch", regularPrice: 1.99 }),
      product({ productId: "PT", upc: "UT", description: "Thai Basil" }),
    ]);
    const r = await buildCart(env(), [{ query: "italian sweet basil", quantity: 1 }]);
    expect(search).toHaveBeenCalledOnce();
    expect(search.mock.calls[0]![1].term).toBe("italian sweet basil");
    expect(addCart.mock.calls[0]![1]).toEqual([{ upc: "UB", quantity: 1, modality: undefined }]);
    expect(r.added[0]?.name).toBe("Sweet Basil, bunch");
  });

  it("skips a query that matches nothing", async () => {
    search.mockResolvedValueOnce([]);
    const r = await buildCart(env(), [{ query: "asdfqwer" }]);
    expect(addCart).not.toHaveBeenCalled();
    expect(r.skipped).toEqual([{ from: '"asdfqwer"', reason: "no products matched" }]);
  });

  it("skips a line with no upc/productId/query", async () => {
    const r = await buildCart(env(), [{ quantity: 3 }]);
    expect(addCart).not.toHaveBeenCalled();
    expect(r.skipped[0]?.reason).toMatch(/no upc/i);
  });

  it("forwards the default locationId to product lookups and query searches", async () => {
    await setDefaultLocationId(makeEnv({ KROGER_KV: kv as unknown as KVNamespace }), "62000123");
    getProducts.mockResolvedValueOnce([product({ productId: "P1", upc: "U1", description: "X" })]);
    search.mockResolvedValueOnce([product({ productId: "P2", upc: "U2", description: "Y" })]);
    await buildCart(env(), [{ productId: "P1" }, { query: "y" }]);
    expect(getProducts.mock.calls[0]![1].locationId).toBe("62000123");
    expect(search.mock.calls[0]![1].locationId).toBe("62000123");
  });

  it("returns the banner-aware checkout URL", async () => {
    await setDefaultLocationChain(makeEnv({ KROGER_KV: kv as unknown as KVNamespace }), "KINGSOOPERS");
    const r = await buildCart(env(), [{ upc: "U1" }]);
    expect(r.checkoutUrl).toBe("https://www.kingsoopers.com/cart");
  });

  it("does one addItemsToCart call for a mixed bulk batch", async () => {
    getProducts.mockResolvedValueOnce([product({ productId: "P1", upc: "U1", description: "A" })]);
    search.mockResolvedValueOnce([product({ productId: "P2", upc: "U2", description: "B" })]);
    await buildCart(env(), [{ upc: "U0", quantity: 1 }, { productId: "P1", quantity: 2 }, { query: "b", quantity: 3 }]);
    expect(addCart).toHaveBeenCalledOnce();
    expect(addCart.mock.calls[0]![1]).toEqual([
      { upc: "U0", quantity: 1, modality: undefined },
      { upc: "U1", quantity: 2, modality: undefined },
      { upc: "U2", quantity: 3, modality: undefined },
    ]);
  });

  it("uses an explicitly-passed locationId without reading KV", async () => {
    getProducts.mockResolvedValueOnce([product({ productId: "P1", upc: "U1", description: "X" })]);
    search.mockResolvedValueOnce([product({ productId: "P2", upc: "U2", description: "Y" })]);
    // No default location set in KV, but we pass one explicitly.
    await buildCart(env(), [{ productId: "P1" }, { query: "y" }], "62000999");
    expect(getProducts.mock.calls[0]![1].locationId).toBe("62000999");
    expect(search.mock.calls[0]![1].locationId).toBe("62000999");
  });

  it("searches each distinct query only once, in one batch", async () => {
    search
      .mockResolvedValueOnce([product({ productId: "PM", upc: "UM", description: "Milk" })])
      .mockResolvedValueOnce([product({ productId: "PB", upc: "UB", description: "Bread" })]);
    const r = await buildCart(env(), [
      { query: "milk", quantity: 1 },
      { query: "milk", quantity: 2 },
      { query: "bread", quantity: 1 },
    ]);
    // two distinct queries → two searches, not three
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls.map((c) => c[1].term).sort()).toEqual(["bread", "milk"]);
    // both "milk" lines resolved to the same upc, separate cart lines
    expect(addCart.mock.calls[0]![1]).toEqual([
      { upc: "UM", quantity: 1, modality: undefined },
      { upc: "UM", quantity: 2, modality: undefined },
      { upc: "UB", quantity: 1, modality: undefined },
    ]);
    expect(r.added).toHaveLength(3);
  });
});
