import type { Env } from "../src/types.js";

// Minimal in-memory KVNamespace double for tests. Doesn't implement put options
// (TTL is irrelevant in tests since nothing measures wall-clock between get/put),
// but covers everything the code under test actually calls.
export class MemoryKV {
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

export function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    KROGER_KV: new MemoryKV() as unknown as KVNamespace,
    KROGER_CLIENT_ID: "test",
    KROGER_CLIENT_SECRET: "test",
    ...overrides,
  } as unknown as Env;
}
