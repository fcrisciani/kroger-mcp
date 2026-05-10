import type { Env, KrogerTokens } from "./types.js";
import {
  getCachedClientCredentialsToken,
  getKrogerTokens,
  setCachedClientCredentialsToken,
  setKrogerTokens,
} from "./storage.js";

const KROGER_BASE = "https://api.kroger.com/v1";

// ---------- low level: token management ----------

function basicAuth(env: Env): string {
  return "Basic " + btoa(`${env.KROGER_CLIENT_ID}:${env.KROGER_CLIENT_SECRET}`);
}

export async function getClientCredentialsToken(env: Env, scope = "product.compact"): Promise<string> {
  const cached = await getCachedClientCredentialsToken(env);
  if (cached && cached.expiresAt > Date.now() + 30_000) {
    return cached.accessToken;
  }
  const body = new URLSearchParams({ grant_type: "client_credentials", scope });
  const res = await fetch(`${KROGER_BASE}/connect/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: basicAuth(env),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) throw new Error(`Kroger client_credentials failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  const token = {
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  await setCachedClientCredentialsToken(env, token);
  return token.accessToken;
}

export async function exchangeAuthorizationCode(
  env: Env,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<KrogerTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  const res = await fetch(`${KROGER_BASE}/connect/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: basicAuth(env),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) throw new Error(`Kroger token exchange failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
  };
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
    scope: json.scope,
  };
}

async function refreshUserToken(env: Env, refreshToken: string): Promise<KrogerTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const res = await fetch(`${KROGER_BASE}/connect/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: basicAuth(env),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) throw new Error(`Kroger refresh failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
  };
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? refreshToken,
    expiresAt: Date.now() + json.expires_in * 1000,
    scope: json.scope,
  };
}

export async function getUserAccessToken(env: Env): Promise<string> {
  const tokens = await getKrogerTokens(env);
  if (!tokens) {
    throw new Error(
      "Kroger account is not connected. Visit /kroger/connect on the Worker to authorize.",
    );
  }
  if (tokens.expiresAt > Date.now() + 30_000) {
    return tokens.accessToken;
  }
  const refreshed = await refreshUserToken(env, tokens.refreshToken);
  await setKrogerTokens(env, refreshed);
  return refreshed.accessToken;
}

// ---------- high level: domain calls ----------

export interface KrogerLocation {
  locationId: string;
  name: string;
  address: { addressLine1: string; city: string; state: string; zipCode: string };
  phone?: string;
  chain?: string;
}

export async function findLocations(
  env: Env,
  args: { zipCode: string; radiusInMiles?: number; limit?: number },
): Promise<KrogerLocation[]> {
  const token = await getClientCredentialsToken(env);
  const params = new URLSearchParams({
    "filter.zipCode.near": args.zipCode,
    "filter.radiusInMiles": String(args.radiusInMiles ?? 10),
    "filter.limit": String(args.limit ?? 10),
  });
  const res = await fetch(`${KROGER_BASE}/locations?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`findLocations failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data: KrogerLocation[] };
  return json.data;
}

export async function getLocation(env: Env, locationId: string): Promise<KrogerLocation | null> {
  const token = await getClientCredentialsToken(env);
  const res = await fetch(`${KROGER_BASE}/locations/${encodeURIComponent(locationId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getLocation failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data: KrogerLocation };
  return json.data;
}

export interface KrogerProduct {
  productId: string;
  upc: string;
  description: string;
  brand?: string;
  categories?: string[];
  size?: string;          // "1 gal", "12 oz", etc.
  regularPrice?: number;
  promoPrice?: number;
  onSale: boolean;
}

interface RawProduct {
  productId: string;
  upc: string;
  description: string;
  brand?: string;
  categories?: string[];
  items?: Array<{
    itemId?: string;
    size?: string;
    price?: { regular?: number; promo?: number };
  }>;
}

function normalizeProduct(p: RawProduct): KrogerProduct {
  const item = p.items?.[0];
  const regular = item?.price?.regular;
  const promo = item?.price?.promo;
  const onSale = !!(promo && promo > 0 && regular && promo < regular);
  return {
    productId: p.productId,
    upc: p.upc,
    description: p.description,
    brand: p.brand,
    categories: p.categories,
    size: item?.size,
    regularPrice: regular,
    promoPrice: promo && promo > 0 ? promo : undefined,
    onSale,
  };
}

export async function searchProducts(
  env: Env,
  args: { term: string; locationId?: string; limit?: number; brand?: string },
): Promise<KrogerProduct[]> {
  const token = await getClientCredentialsToken(env);
  const params = new URLSearchParams({
    "filter.term": args.term,
    "filter.limit": String(args.limit ?? 10),
  });
  if (args.locationId) params.set("filter.locationId", args.locationId);
  if (args.brand) params.set("filter.brand", args.brand);
  const res = await fetch(`${KROGER_BASE}/products?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`searchProducts failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data: RawProduct[] };
  return json.data.map(normalizeProduct);
}

// Kroger's `filter.productId` accepts a comma-separated list, but
// `filter.limit` caps at 50 and the API silently drops anything past that. We
// chunk to keep callers honest — if you ask for 200 productIds, you get 200
// results back (or whatever subset Kroger has data for at this location).
const PRODUCTS_BY_ID_CHUNK = 50;

export async function getProductsByIds(
  env: Env,
  args: { productIds: string[]; locationId?: string },
): Promise<KrogerProduct[]> {
  if (args.productIds.length === 0) return [];
  const token = await getClientCredentialsToken(env);

  const batches: string[][] = [];
  for (let i = 0; i < args.productIds.length; i += PRODUCTS_BY_ID_CHUNK) {
    batches.push(args.productIds.slice(i, i + PRODUCTS_BY_ID_CHUNK));
  }

  // Parallel fan-out is safe at our scale (<10 chunks per call). If we ever
  // grow to hundreds of chunks per call we'd want to throttle to stay under
  // Kroger's rate limits, but that's not a near-term concern.
  const results = await Promise.all(
    batches.map(async (batch) => {
      const params = new URLSearchParams({
        "filter.productId": batch.join(","),
        "filter.limit": String(batch.length),
      });
      if (args.locationId) params.set("filter.locationId", args.locationId);
      const res = await fetch(`${KROGER_BASE}/products?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`getProductsByIds failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { data: RawProduct[] };
      return json.data.map(normalizeProduct);
    }),
  );
  return results.flat();
}

export interface CartItemInput {
  upc: string;
  quantity: number;
  modality?: "PICKUP" | "DELIVERY";
}

export async function addItemsToCart(env: Env, items: CartItemInput[]): Promise<void> {
  if (items.length === 0) return;
  const token = await getUserAccessToken(env);
  const body = {
    items: items.map((i) => ({
      upc: i.upc,
      quantity: i.quantity,
      modality: i.modality ?? "PICKUP",
    })),
  };
  const res = await fetch(`${KROGER_BASE}/cart/add`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`addItemsToCart failed: ${res.status} ${await res.text()}`);
  }
}

// ---------- OAuth helpers (PKCE) ----------

export function buildAuthorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    scope: args.scope,
    state: args.state,
    code_challenge: args.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${KROGER_BASE}/connect/oauth2/authorize?${params}`;
}

export async function generatePkcePair(): Promise<{ verifier: string; challenge: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const verifier = base64Url(bytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64Url(new Uint8Array(digest));
  return { verifier, challenge };
}

function base64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
