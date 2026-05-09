import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProductsByIds } from "../src/kroger.js";
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
}

function makeEnv(kv: MemoryKV): Env {
  return {
    KROGER_KV: kv as unknown as KVNamespace,
    KROGER_CLIENT_ID: "test",
    KROGER_CLIENT_SECRET: "test",
  } as unknown as Env;
}

function fakeProductsResponse(productIds: string[]): Response {
  return new Response(
    JSON.stringify({
      data: productIds.map((id) => ({
        productId: id,
        upc: id,
        description: `Item ${id}`,
        items: [{ price: { regular: 1.99, promo: 0 } }],
      })),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("getProductsByIds", () => {
  let kv: MemoryKV;
  let env: Env;
  // Loose typing: vi.spyOn carries the source signature, which collides with
  // the mock-helpers we use below. The behavior we care about (mockResolvedValueOnce,
  // .mock.calls) is the same regardless.
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    kv = new MemoryKV();
    env = makeEnv(kv);
    // Pre-cache a fresh client_credentials token so we don't hit the auth
    // endpoint during the test — we only want to assert behavior on the
    // /products call(s).
    await kv.put(
      "kroger:cc_token",
      JSON.stringify({ accessToken: "test-token", expiresAt: Date.now() + 60_000 }),
    );
    fetchSpy = vi.spyOn(globalThis, "fetch") as unknown as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns [] without calling fetch when given no productIds", async () => {
    const out = await getProductsByIds(env, { productIds: [] });
    expect(out).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("issues a single request when the productId list fits in one chunk", async () => {
    const ids = Array.from({ length: 5 }, (_, i) => `id${i}`);
    fetchSpy.mockResolvedValueOnce(fakeProductsResponse(ids));

    const out = await getProductsByIds(env, { productIds: ids });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(5);
    expect(out.map((p) => p.productId)).toEqual(ids);
  });

  it("chunks productIds in 50-id batches and concatenates results", async () => {
    const ids = Array.from({ length: 75 }, (_, i) => `id${i.toString().padStart(3, "0")}`);
    const firstBatch = ids.slice(0, 50);
    const secondBatch = ids.slice(50);
    fetchSpy
      .mockResolvedValueOnce(fakeProductsResponse(firstBatch))
      .mockResolvedValueOnce(fakeProductsResponse(secondBatch));

    const out = await getProductsByIds(env, { productIds: ids });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(out).toHaveLength(75);
    expect(out.map((p) => p.productId)).toEqual(ids);

    const firstUrl = String(fetchSpy.mock.calls[0]![0]);
    const secondUrl = String(fetchSpy.mock.calls[1]![0]);
    expect(firstUrl).toContain(encodeURIComponent(firstBatch.join(",")));
    expect(firstUrl).toContain("filter.limit=50");
    expect(secondUrl).toContain(encodeURIComponent(secondBatch.join(",")));
    expect(secondUrl).toContain("filter.limit=25");
  });

  it("forwards locationId to every chunk", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `id${i}`);
    fetchSpy
      .mockResolvedValueOnce(fakeProductsResponse(ids.slice(0, 50)))
      .mockResolvedValueOnce(fakeProductsResponse(ids.slice(50)));

    await getProductsByIds(env, { productIds: ids, locationId: "01400376" });

    for (const call of fetchSpy.mock.calls) {
      expect(String(call[0])).toContain("filter.locationId=01400376");
    }
  });
});
