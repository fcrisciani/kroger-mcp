import type {
  ClientCredentialsToken,
  Env,
  KrogerTokens,
  UsualItem,
  UsualItemsDoc,
} from "./types.js";
import { cartUrl } from "./util.js";

const K = {
  krogerTokens: "kroger:tokens",
  ccToken: "kroger:cc_token",
  defaultLocation: "prefs:default_location_id",
  // Banner/chain of the default store (e.g. "KINGSOOPERS"). Optional sibling
  // of defaultLocation; documents from before this was added simply won't have
  // it, in which case the checkout URL falls back to kroger.com.
  defaultLocationChain: "prefs:default_location_chain",
  usualItems: "prefs:usual_items",
} as const;

export async function getKrogerTokens(env: Env): Promise<KrogerTokens | null> {
  return env.KROGER_KV.get<KrogerTokens>(K.krogerTokens, "json");
}

export async function setKrogerTokens(env: Env, tokens: KrogerTokens): Promise<void> {
  await env.KROGER_KV.put(K.krogerTokens, JSON.stringify(tokens));
}

export async function clearKrogerTokens(env: Env): Promise<void> {
  await env.KROGER_KV.delete(K.krogerTokens);
}

export async function getCachedClientCredentialsToken(
  env: Env,
): Promise<ClientCredentialsToken | null> {
  return env.KROGER_KV.get<ClientCredentialsToken>(K.ccToken, "json");
}

export async function setCachedClientCredentialsToken(
  env: Env,
  token: ClientCredentialsToken,
): Promise<void> {
  // Store with TTL slightly shorter than expiry so KV evicts naturally.
  const ttl = Math.max(60, Math.floor((token.expiresAt - Date.now()) / 1000) - 30);
  await env.KROGER_KV.put(K.ccToken, JSON.stringify(token), { expirationTtl: ttl });
}

export async function getDefaultLocationId(env: Env): Promise<string | null> {
  return env.KROGER_KV.get(K.defaultLocation);
}

export async function setDefaultLocationId(env: Env, locationId: string): Promise<void> {
  await env.KROGER_KV.put(K.defaultLocation, locationId);
}

export async function getDefaultLocationChain(env: Env): Promise<string | null> {
  return env.KROGER_KV.get(K.defaultLocationChain);
}

export async function setDefaultLocationChain(env: Env, chain: string): Promise<void> {
  await env.KROGER_KV.put(K.defaultLocationChain, chain);
}

export async function clearDefaultLocationChain(env: Env): Promise<void> {
  await env.KROGER_KV.delete(K.defaultLocationChain);
}

// The kroger.com / kingsoopers.com / fredmeyer.com / … cart URL for the
// current default store's banner. Callers that already hold the chain (e.g.
// get_default_location) can pass it to skip the KV read. Never throws — a KV
// hiccup just falls back to kroger.com, which is a worse-but-harmless link.
export async function getCheckoutUrl(env: Env, chain?: string | null): Promise<string> {
  if (chain !== undefined) return cartUrl(chain);
  try {
    return cartUrl(await getDefaultLocationChain(env));
  } catch {
    return cartUrl(null);
  }
}

export async function getUsualItems(env: Env): Promise<UsualItemsDoc> {
  const doc = await env.KROGER_KV.get<UsualItemsDoc>(K.usualItems, "json");
  return doc ?? { items: [], updatedAt: new Date(0).toISOString() };
}

export async function saveUsualItems(env: Env, doc: UsualItemsDoc): Promise<void> {
  doc.updatedAt = new Date().toISOString();
  await env.KROGER_KV.put(K.usualItems, JSON.stringify(doc));
}

export async function upsertUsualItem(env: Env, item: UsualItem): Promise<UsualItem> {
  const doc = await getUsualItems(env);
  const idx = doc.items.findIndex((i) => i.productId === item.productId);
  if (idx >= 0) {
    // Updates from the user-facing tools must not clobber three derived/
    // historical fields:
    //   - addedBy:      tracks the original creator, not the latest editor
    //   - timesOrdered: bumped only by recordOrderedItems on real cart adds
    //   - lastOrdered:  same — set only when the item lands in a Kroger cart
    // add_usual_item hardcodes timesOrdered: 0, so without this stripping
    // an "update" call would silently reset every item's order history.
    const { addedBy: _a, timesOrdered: _t, lastOrdered: _l, ...updates } = item;
    doc.items[idx] = { ...doc.items[idx]!, ...updates };
  } else {
    doc.items.push(item);
  }
  await saveUsualItems(env, doc);
  return doc.items.find((i) => i.productId === item.productId)!;
}

// Upsert several items in a single read-modify-write, with the same protected-
// field rules as upsertUsualItem (addedBy preserved on existing items,
// timesOrdered/lastOrdered never clobbered). Use this for promote_to_usuals so
// converting a 40-item cart isn't 40 separate KV writes (slow, and racy).
// Returns the new doc's items.
export async function bulkUpsertUsualItems(env: Env, items: UsualItem[]): Promise<UsualItem[]> {
  if (items.length === 0) return (await getUsualItems(env)).items;
  const doc = await getUsualItems(env);
  for (const item of items) {
    const idx = doc.items.findIndex((i) => i.productId === item.productId);
    if (idx >= 0) {
      const { addedBy: _a, timesOrdered: _t, lastOrdered: _l, ...updates } = item;
      doc.items[idx] = { ...doc.items[idx]!, ...updates };
    } else {
      doc.items.push(item);
    }
  }
  await saveUsualItems(env, doc);
  return doc.items;
}

// Apply a partial update to an existing item without touching the protected
// fields (addedBy / timesOrdered / lastOrdered). Use this for tools that just
// tweak knobs like quantity or cadence — going through upsertUsualItem would
// require fabricating a full UsualItem just to throw most of it away.
export async function patchUsualItem(
  env: Env,
  productId: string,
  patch: Partial<Omit<UsualItem, "productId" | "addedBy" | "timesOrdered" | "lastOrdered">>,
): Promise<UsualItem | null> {
  const doc = await getUsualItems(env);
  const idx = doc.items.findIndex((i) => i.productId === productId);
  if (idx < 0) return null;
  doc.items[idx] = { ...doc.items[idx]!, ...patch };
  await saveUsualItems(env, doc);
  return doc.items[idx]!;
}

export async function removeUsualItem(env: Env, productId: string): Promise<boolean> {
  const doc = await getUsualItems(env);
  const before = doc.items.length;
  doc.items = doc.items.filter((i) => i.productId !== productId);
  if (doc.items.length === before) return false;
  await saveUsualItems(env, doc);
  return true;
}

export async function recordOrderedItems(env: Env, productIds: string[]): Promise<void> {
  if (productIds.length === 0) return;
  const doc = await getUsualItems(env);
  const now = new Date().toISOString();
  const set = new Set(productIds);
  for (const item of doc.items) {
    if (set.has(item.productId)) {
      item.lastOrdered = now;
      item.timesOrdered = (item.timesOrdered ?? 0) + 1;
    }
  }
  await saveUsualItems(env, doc);
}
