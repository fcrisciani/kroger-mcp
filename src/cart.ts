import {
  addItemsToCart,
  getProductsByIds,
  searchProducts,
  type CartItemInput,
  type KrogerProduct,
} from "./kroger.js";
import { getCheckoutUrl, getDefaultLocationId } from "./storage.js";
import type { Env } from "./types.js";
import { priceLine } from "./util.js";

// One line in an add_to_cart request. Exactly one of upc / productId / query
// identifies the product; quantity defaults to 1.
export interface CartLineInput {
  upc?: string;
  productId?: string;
  query?: string;
  quantity?: number;
  modality?: CartItemInput["modality"];
}

export interface CartBuildResult {
  added: Array<{ from: string; upc: string; quantity: number; name?: string; price?: string }>;
  skipped: Array<{ from: string; reason: string }>;
  checkoutUrl: string;
}

function describe(line: CartLineInput): string {
  if (line.upc) return `upc ${line.upc}`;
  if (line.productId) return `productId ${line.productId}`;
  if (line.query) return `"${line.query}"`;
  return "(empty item)";
}

// Resolve a mixed batch of {upc | productId | query} lines to UPCs, add them to
// the Kroger cart in a single call, and report per-line what happened. Pulled
// out of mcp.ts so it can be unit-tested without the McpAgent Durable Object.
export async function buildCart(env: Env, lines: CartLineInput[]): Promise<CartBuildResult> {
  const locationId = (await getDefaultLocationId(env)) ?? undefined;

  // Resolve productId-only lines in one products call.
  const productIdLines = lines.filter((l) => !l.upc && l.productId);
  const byProductId = new Map<string, KrogerProduct>();
  if (productIdLines.length > 0) {
    const products = await getProductsByIds(env, {
      productIds: productIdLines.map((l) => l.productId!),
      locationId,
    });
    for (const p of products) byProductId.set(p.productId, p);
  }

  // Resolve query lines via search (one search per query — could batch if
  // Kroger offered it, but it doesn't).
  const queryMatches = new Map<CartLineInput, KrogerProduct>();
  for (const l of lines) {
    if (l.upc || l.productId || !l.query) continue;
    const products = await searchProducts(env, { term: l.query, limit: 5, locationId });
    if (products[0]) queryMatches.set(l, products[0]);
  }

  const toAdd: CartItemInput[] = [];
  const added: CartBuildResult["added"] = [];
  const skipped: CartBuildResult["skipped"] = [];

  for (const line of lines) {
    const from = describe(line);
    const quantity = line.quantity ?? 1;
    let product: KrogerProduct | undefined;
    let upc: string | undefined;

    if (line.upc) {
      upc = line.upc; // explicit, deterministic — no lookup
    } else if (line.productId) {
      product = byProductId.get(line.productId);
      if (!product) {
        skipped.push({ from, reason: "not available at the default store (no product with that id)" });
        continue;
      }
      upc = product.upc;
    } else if (line.query) {
      product = queryMatches.get(line);
      if (!product) {
        skipped.push({ from, reason: "no products matched" });
        continue;
      }
      upc = product.upc;
    } else {
      skipped.push({ from, reason: "no upc, productId, or query provided" });
      continue;
    }

    toAdd.push({ upc, quantity, modality: line.modality });
    added.push({
      from,
      upc,
      quantity,
      name: product?.description,
      price: product ? priceLine(product) : undefined,
    });
  }

  if (toAdd.length > 0) await addItemsToCart(env, toAdd);

  return { added, skipped, checkoutUrl: await getCheckoutUrl(env) };
}
