import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLocation, getProductsByIds } from "../src/kroger.js";
import type { Env } from "../src/types.js";
import { makeEnv, MemoryKV } from "./helpers.js";

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
    env = makeEnv({ KROGER_KV: kv as unknown as KVNamespace });
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

describe("getLocation", () => {
  let kv: MemoryKV;
  let env: Env;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    kv = new MemoryKV();
    env = makeEnv({ KROGER_KV: kv as unknown as KVNamespace });
    await kv.put(
      "kroger:cc_token",
      JSON.stringify({ accessToken: "test-token", expiresAt: Date.now() + 60_000 }),
    );
    fetchSpy = vi.spyOn(globalThis, "fetch") as unknown as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the location (including chain) on 200", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            locationId: "62000123",
            name: "King Soopers - Downtown",
            chain: "KINGSOOPERS",
            address: { addressLine1: "1 Main St", city: "Denver", state: "CO", zipCode: "80202" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const loc = await getLocation(env, "62000123");
    expect(loc?.locationId).toBe("62000123");
    expect(loc?.chain).toBe("KINGSOOPERS");
    expect(String(fetchSpy.mock.calls[0]![0])).toContain("/locations/62000123");
  });

  it("returns null on 404 instead of throwing", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("not found", { status: 404 }));
    expect(await getLocation(env, "00000000")).toBeNull();
  });

  it("throws on other non-2xx responses", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("upstream boom", { status: 502 }));
    await expect(getLocation(env, "62000123")).rejects.toThrow(/getLocation failed: 502/);
  });

  it("url-encodes the locationId", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("not found", { status: 404 }));
    await getLocation(env, "weird/id with space");
    expect(String(fetchSpy.mock.calls[0]![0])).toContain(encodeURIComponent("weird/id with space"));
  });
});
