import {
  addItemsToCart,
  getProductsByIds,
  type CartItemInput,
} from "./kroger.js";
import {
  getDefaultLocationId,
  getUsualItems,
  recordOrderedItems,
} from "./storage.js";
import type { Env } from "./types.js";
import { isDue, priceLine } from "./util.js";

const CHECKOUT_URL = "https://www.kroger.com/cart";

export interface WeeklyOrderArgs {
  includeAll?: boolean;
  modality?: CartItemInput["modality"];
}

// Pulled out of mcp.ts so it can be unit-tested without booting the McpAgent
// Durable Object. The function returns the user-facing summary text; the tool
// wrapper just packages it as MCP content.
export async function runWeeklyOrder(env: Env, args: WeeklyOrderArgs): Promise<string> {
  const doc = await getUsualItems(env);
  const candidates = args.includeAll ? doc.items : doc.items.filter((i) => isDue(i));
  if (candidates.length === 0) {
    return "No items are due to reorder. Pass includeAll=true to add the full list anyway.";
  }

  const locationId = (await getDefaultLocationId(env)) ?? undefined;
  const products = await getProductsByIds(env, {
    productIds: candidates.map((i) => i.productId),
    locationId,
  });
  const byProductId = new Map(products.map((p) => [p.productId, p]));

  // Only items that resolved to a product at this store should have their
  // lastOrdered/timesOrdered bumped — otherwise an item temporarily
  // unavailable here would silently get marked as ordered every week and
  // disappear from the due list.
  const resolved = candidates.filter((u) => byProductId.has(u.productId));
  const unresolved = candidates.filter((u) => !byProductId.has(u.productId));

  if (resolved.length === 0) {
    return "Could not resolve any of the due items at the current store.";
  }

  const cartItems = resolved.map((u) => ({
    upc: byProductId.get(u.productId)!.upc,
    quantity: u.defaultQty,
    modality: args.modality,
  }));

  await addItemsToCart(env, cartItems);

  // Bookkeeping is best-effort. If KV fails after a successful cart-add, the
  // user's cart is the source of truth — surfacing an error here would cause
  // them to retry and get duplicate items in the cart.
  let bookkeepingNote = "";
  try {
    await recordOrderedItems(env, resolved.map((u) => u.productId));
  } catch (err) {
    bookkeepingNote = `\n\n⚠ Items were added but their lastOrdered timestamps could not be saved: ${(err as Error).message}. They may show up as "due" again until the next successful run.`;
  }

  const headline =
    unresolved.length > 0
      ? `Added ${resolved.length} of ${candidates.length} due items to your Kroger cart (${unresolved.length} couldn't be resolved at this store).`
      : `Added ${resolved.length} item(s) to your Kroger cart.`;

  const itemLines: string[] = [];
  const sales: string[] = [];
  let total = 0;
  let priced = 0;
  for (const u of resolved) {
    const p = byProductId.get(u.productId)!;
    const each = p.onSale && p.promoPrice ? p.promoPrice : p.regularPrice;
    if (each !== undefined) {
      total += each * u.defaultQty;
      priced++;
    }
    itemLines.push(`• ${u.defaultQty} × ${p.description} — ${priceLine(p)}`);
    if (p.onSale) sales.push(`  ${p.description} — on sale at $${p.promoPrice!.toFixed(2)}`);
  }

  const sections: string[] = [headline, "", ...itemLines];

  if (unresolved.length > 0) {
    sections.push("", "Skipped — not available at this store (lastOrdered preserved):");
    for (const u of unresolved) sections.push(`• ${u.name}`);
  }
  if (priced > 0) {
    sections.push("", `Estimated subtotal (priced items only): $${total.toFixed(2)}`);
  }
  if (sales.length > 0) {
    sections.push("", "On sale this week:", ...sales);
  }
  sections.push("", `Review & checkout: ${CHECKOUT_URL}`);
  if (bookkeepingNote) sections.push(bookkeepingNote);

  return sections.join("\n");
}
