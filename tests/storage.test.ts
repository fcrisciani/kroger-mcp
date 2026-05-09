import { beforeEach, describe, expect, it } from "vitest";
import { getUsualItems, upsertUsualItem } from "../src/storage.js";
import type { Env } from "../src/types.js";

class MemoryKV {
  private store = new Map<string, string>();
  async get(key: string, type?: "json"): Promise<unknown> {
    const v = this.store.get(key);
    if (v === undefined) return null;
    return type === "json" ? JSON.parse(v) : v;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  raw(key: string): string | undefined {
    return this.store.get(key);
  }
}

function makeEnv(kv: MemoryKV): Env {
  return { KROGER_KV: kv as unknown as KVNamespace } as unknown as Env;
}

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
    env = makeEnv(kv);
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
});
