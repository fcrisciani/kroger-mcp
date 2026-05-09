import { beforeEach, describe, expect, it } from "vitest";
import { getUsualItems, patchUsualItem, upsertUsualItem } from "../src/storage.js";
import type { Env } from "../src/types.js";
import { makeEnv, MemoryKV } from "./helpers.js";

const milk = {
  productId: "0001111041700",
  name: "Whole Milk, 1 gal",
  defaultQty: 1,
  cadence: "weekly" as const,
  timesOrdered: 0,
};

describe("upsertUsualItem", () => {
  let kv: MemoryKV;
  let env: Env;
  beforeEach(() => {
    kv = new MemoryKV();
    env = makeEnv({ KROGER_KV: kv as unknown as KVNamespace });
  });

  it("stamps addedBy on creation", async () => {
    const saved = await upsertUsualItem(env, { ...milk, addedBy: "alice@example.com" });
    expect(saved.addedBy).toBe("alice@example.com");
  });

  it("preserves the original addedBy when another family member updates the item", async () => {
    await upsertUsualItem(env, { ...milk, addedBy: "alice@example.com" });
    const updated = await upsertUsualItem(env, {
      ...milk,
      defaultQty: 2,
      addedBy: "bob@example.com",
    });
    expect(updated.addedBy).toBe("alice@example.com");
    expect(updated.defaultQty).toBe(2);
  });

  it("loads pre-migration documents that have no addedBy", async () => {
    const legacy = {
      items: [{ ...milk }], // no addedBy
      updatedAt: "2026-01-01T00:00:00Z",
    };
    await kv.put("prefs:usual_items", JSON.stringify(legacy));
    const doc = await getUsualItems(env);
    expect(doc.items[0]?.addedBy).toBeUndefined();
    expect(doc.items[0]?.name).toBe("Whole Milk, 1 gal");
  });

  it("an update on a legacy item does not invent an addedBy", async () => {
    const legacy = {
      items: [{ ...milk }],
      updatedAt: "2026-01-01T00:00:00Z",
    };
    await kv.put("prefs:usual_items", JSON.stringify(legacy));
    const updated = await upsertUsualItem(env, { ...milk, defaultQty: 3 });
    expect(updated.addedBy).toBeUndefined();
    expect(updated.defaultQty).toBe(3);
  });

  it("preserves timesOrdered and lastOrdered when a tool updates an existing item", async () => {
    // Seed with a well-loved item that has order history.
    const seeded = {
      items: [
        {
          ...milk,
          timesOrdered: 12,
          lastOrdered: "2026-04-30T10:00:00Z",
          addedBy: "alice@example.com",
        },
      ],
      updatedAt: "2026-04-30T10:00:00Z",
    };
    await kv.put("prefs:usual_items", JSON.stringify(seeded));

    // Simulate an `add_usual_item` call from the tool layer, which always
    // passes timesOrdered: 0 (and never passes lastOrdered).
    const updated = await upsertUsualItem(env, {
      ...milk,
      defaultQty: 4,
      timesOrdered: 0,
      addedBy: "bob@example.com",
    });

    expect(updated.timesOrdered).toBe(12);
    expect(updated.lastOrdered).toBe("2026-04-30T10:00:00Z");
    expect(updated.defaultQty).toBe(4);
    expect(updated.addedBy).toBe("alice@example.com");
  });
});

describe("patchUsualItem", () => {
  let kv: MemoryKV;
  let env: Env;
  beforeEach(() => {
    kv = new MemoryKV();
    env = makeEnv({ KROGER_KV: kv as unknown as KVNamespace });
  });

  it("returns null when the productId doesn't exist", async () => {
    const result = await patchUsualItem(env, "nope", { defaultQty: 2 });
    expect(result).toBeNull();
  });

  it("applies a partial update without touching history or addedBy", async () => {
    const seeded = {
      items: [
        {
          ...milk,
          timesOrdered: 7,
          lastOrdered: "2026-04-15T12:00:00Z",
          addedBy: "alice@example.com",
          notes: "1% only",
        },
      ],
      updatedAt: "2026-04-15T12:00:00Z",
    };
    await kv.put("prefs:usual_items", JSON.stringify(seeded));

    const updated = await patchUsualItem(env, milk.productId, {
      defaultQty: 2,
      cadence: "biweekly",
    });

    expect(updated).not.toBeNull();
    expect(updated!.defaultQty).toBe(2);
    expect(updated!.cadence).toBe("biweekly");
    expect(updated!.notes).toBe("1% only");
    expect(updated!.timesOrdered).toBe(7);
    expect(updated!.lastOrdered).toBe("2026-04-15T12:00:00Z");
    expect(updated!.addedBy).toBe("alice@example.com");
  });
});
