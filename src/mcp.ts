import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  addItemsToCart,
  findLocations,
  getProductsByIds,
  searchProducts,
  type KrogerProduct,
} from "./kroger.js";
import {
  getDefaultLocationId,
  getUsualItems,
  recordOrderedItems,
  removeUsualItem,
  saveUsualItems,
  setDefaultLocationId,
  upsertUsualItem,
} from "./storage.js";
import type { Cadence, Env, SessionProps, UsualItem } from "./types.js";

const CHECKOUT_URL = "https://www.kroger.com/cart";

const cadenceDays: Record<Cadence, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
};

function isDue(item: UsualItem, now = Date.now()): boolean {
  if (!item.lastOrdered) return true;
  const last = Date.parse(item.lastOrdered);
  if (Number.isNaN(last)) return true;
  // Subtract a 1-day grace window so a "weekly" order on day 6 still counts as due.
  const dueAt = last + (cadenceDays[item.cadence] - 1) * 86_400_000;
  return now >= dueAt;
}

function priceLine(p: KrogerProduct): string {
  if (p.onSale && p.promoPrice && p.regularPrice) {
    return `$${p.promoPrice.toFixed(2)} (sale, was $${p.regularPrice.toFixed(2)})`;
  }
  if (p.regularPrice) return `$${p.regularPrice.toFixed(2)}`;
  return "price unavailable at this location";
}

export class KrogerMCP extends McpAgent<Env, unknown, SessionProps> {
  server = new McpServer({ name: "kroger-mcp", version: "0.1.0" });

  async init(): Promise<void> {
    const env = this.env;

    // ---------- locations ----------

    this.server.tool(
      "find_locations",
      "Find Kroger-family stores near a ZIP code. Use this to pick a default store.",
      {
        zipCode: z.string().regex(/^\d{5}$/),
        radiusInMiles: z.number().int().min(1).max(100).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      async ({ zipCode, radiusInMiles, limit }) => {
        const locs = await findLocations(env, { zipCode, radiusInMiles, limit });
        const lines = locs.map(
          (l) =>
            `${l.locationId}  ${l.name} — ${l.address.addressLine1}, ${l.address.city}, ${l.address.state} ${l.address.zipCode}`,
        );
        return { content: [{ type: "text", text: lines.join("\n") || "No stores found." }] };
      },
    );

    this.server.tool(
      "set_default_location",
      "Save a Kroger locationId as the default store for searches and the cart.",
      { locationId: z.string().min(1) },
      async ({ locationId }) => {
        await setDefaultLocationId(env, locationId);
        return { content: [{ type: "text", text: `Default location set to ${locationId}.` }] };
      },
    );

    this.server.tool(
      "get_default_location",
      "Return the currently saved default locationId, if any.",
      {},
      async () => {
        const loc = await getDefaultLocationId(env);
        return {
          content: [{ type: "text", text: loc ?? "No default location set. Use find_locations + set_default_location." }],
        };
      },
    );

    // ---------- product search ----------

    this.server.tool(
      "search_products",
      "Search Kroger's product catalog. If a default location is set, results include current prices and sale flags for that store.",
      {
        term: z.string().min(1),
        limit: z.number().int().min(1).max(25).optional(),
        brand: z.string().optional(),
        locationId: z.string().optional(),
      },
      async ({ term, limit, brand, locationId }) => {
        const loc = locationId ?? (await getDefaultLocationId(env)) ?? undefined;
        const products = await searchProducts(env, { term, limit, brand, locationId: loc });
        if (products.length === 0) {
          return { content: [{ type: "text", text: "No products found." }] };
        }
        const text = products
          .map(
            (p, i) =>
              `${i + 1}. ${p.description}${p.size ? ` (${p.size})` : ""} — ${priceLine(p)}\n   id=${p.productId} upc=${p.upc}`,
          )
          .join("\n");
        return { content: [{ type: "text", text }] };
      },
    );

    // ---------- one-off add ----------

    this.server.tool(
      "add_one_off",
      "Search for an item by free text and add the top match to the Kroger cart. If unsure, set auto_add=false to return options instead.",
      {
        query: z.string().min(1),
        quantity: z.number().int().min(1).max(50).optional(),
        autoAdd: z.boolean().optional(),
      },
      async ({ query, quantity, autoAdd }) => {
        const locationId = (await getDefaultLocationId(env)) ?? undefined;
        const products = await searchProducts(env, { term: query, limit: 5, locationId });
        if (products.length === 0) {
          return { content: [{ type: "text", text: `No products matched "${query}".` }] };
        }
        const auto = autoAdd ?? true;
        if (!auto) {
          const text = products
            .map((p, i) => `${i + 1}. ${p.description} — ${priceLine(p)} (upc=${p.upc})`)
            .join("\n");
          return {
            content: [{ type: "text", text: `Top matches for "${query}" (autoAdd disabled):\n${text}` }],
          };
        }
        const top = products[0]!;
        await addItemsToCart(env, [{ upc: top.upc, quantity: quantity ?? 1 }]);
        return {
          content: [
            {
              type: "text",
              text: `Added ${quantity ?? 1} × ${top.description} (${priceLine(top)}) to your Kroger cart. Review and checkout: ${CHECKOUT_URL}`,
            },
          ],
        };
      },
    );

    // ---------- usual items CRUD ----------

    this.server.tool(
      "list_usual_items",
      "List the user's recurring grocery items. Set onlyDue=true to filter to items whose cadence makes them due to reorder.",
      { onlyDue: z.boolean().optional() },
      async ({ onlyDue }) => {
        const doc = await getUsualItems(env);
        const items = onlyDue ? doc.items.filter((i) => isDue(i)) : doc.items;
        if (items.length === 0) {
          return { content: [{ type: "text", text: onlyDue ? "Nothing due to reorder." : "No usual items saved yet." }] };
        }
        const text = items
          .map((i) => {
            const due = isDue(i) ? "DUE" : "ok";
            const last = i.lastOrdered ?? "never";
            return `[${due}] ${i.name} — qty ${i.defaultQty}, ${i.cadence}, last ${last}, productId=${i.productId}`;
          })
          .join("\n");
        return { content: [{ type: "text", text }] };
      },
    );

    this.server.tool(
      "add_usual_item",
      "Add or update an item in the recurring list. Use search_products to find a productId first.",
      {
        productId: z.string().min(1),
        name: z.string().min(1),
        defaultQty: z.number().int().min(1).max(50),
        cadence: z.enum(["weekly", "biweekly", "monthly"]),
        notes: z.string().optional(),
      },
      async (args) => {
        const item = await upsertUsualItem(env, {
          productId: args.productId,
          name: args.name,
          defaultQty: args.defaultQty,
          cadence: args.cadence,
          notes: args.notes,
          timesOrdered: 0,
        });
        return { content: [{ type: "text", text: `Saved usual item: ${item.name} (${item.cadence}, qty ${item.defaultQty}).` }] };
      },
    );

    this.server.tool(
      "remove_usual_item",
      "Remove a productId from the recurring list.",
      { productId: z.string().min(1) },
      async ({ productId }) => {
        const ok = await removeUsualItem(env, productId);
        return { content: [{ type: "text", text: ok ? "Removed." : "No matching item found." }] };
      },
    );

    this.server.tool(
      "update_usual_item",
      "Tweak quantity, cadence, or notes for an existing usual item.",
      {
        productId: z.string().min(1),
        defaultQty: z.number().int().min(1).max(50).optional(),
        cadence: z.enum(["weekly", "biweekly", "monthly"]).optional(),
        notes: z.string().optional(),
      },
      async ({ productId, defaultQty, cadence, notes }) => {
        const doc = await getUsualItems(env);
        const item = doc.items.find((i) => i.productId === productId);
        if (!item) return { content: [{ type: "text", text: "No matching item." }] };
        if (defaultQty !== undefined) item.defaultQty = defaultQty;
        if (cadence !== undefined) item.cadence = cadence;
        if (notes !== undefined) item.notes = notes;
        await saveUsualItems(env, doc);
        return { content: [{ type: "text", text: `Updated ${item.name}.` }] };
      },
    );

    // ---------- weekly order ----------

    this.server.tool(
      "prepare_weekly_order",
      "Build this week's grocery cart on Kroger. Pulls items from the usual list whose cadence is due, adds them to the user's Kroger cart, and returns a summary plus a checkout link. Surfaces any items currently on sale.",
      {
        includeAll: z.boolean().optional(),
        modality: z.enum(["PICKUP", "DELIVERY"]).optional(),
      },
      async ({ includeAll, modality }) => {
        const doc = await getUsualItems(env);
        const candidates = includeAll ? doc.items : doc.items.filter((i) => isDue(i));
        if (candidates.length === 0) {
          return { content: [{ type: "text", text: "No items are due to reorder. Pass includeAll=true to add the full list anyway." }] };
        }
        const locationId = (await getDefaultLocationId(env)) ?? undefined;
        const products = await getProductsByIds(env, {
          productIds: candidates.map((i) => i.productId),
          locationId,
        });
        const byProductId = new Map(products.map((p) => [p.productId, p]));

        const cartItems = candidates
          .map((u) => {
            const p = byProductId.get(u.productId);
            return p ? { upc: p.upc, quantity: u.defaultQty, modality } : null;
          })
          .filter((x): x is NonNullable<typeof x> => x !== null);

        if (cartItems.length === 0) {
          return { content: [{ type: "text", text: "Could not resolve any of the due items at the current store." }] };
        }

        await addItemsToCart(env, cartItems);
        await recordOrderedItems(env, candidates.map((c) => c.productId));

        const lines: string[] = [];
        const sales: string[] = [];
        let total = 0;
        let priced = 0;
        for (const u of candidates) {
          const p = byProductId.get(u.productId);
          if (!p) {
            lines.push(`! ${u.name} — not available at this store, skipped`);
            continue;
          }
          const each = p.onSale && p.promoPrice ? p.promoPrice : p.regularPrice;
          if (each !== undefined) {
            total += each * u.defaultQty;
            priced++;
          }
          lines.push(`• ${u.defaultQty} × ${p.description} — ${priceLine(p)}`);
          if (p.onSale) sales.push(`  ${p.description} — on sale at $${p.promoPrice?.toFixed(2)}`);
        }

        const summary = [
          `Added ${cartItems.length} item(s) to your Kroger cart.`,
          ...lines,
          priced > 0 ? `\nEstimated subtotal (priced items only): $${total.toFixed(2)}` : "",
          sales.length > 0 ? `\nOn sale this week:\n${sales.join("\n")}` : "",
          `\nReview & checkout: ${CHECKOUT_URL}`,
        ]
          .filter(Boolean)
          .join("\n");

        return { content: [{ type: "text", text: summary }] };
      },
    );

    // ---------- sale watch ----------

    this.server.tool(
      "check_sales_on_usuals",
      "Check which of the user's usual items are currently on sale at the default store. Read-only.",
      {},
      async () => {
        const doc = await getUsualItems(env);
        if (doc.items.length === 0) return { content: [{ type: "text", text: "No usual items saved yet." }] };
        const locationId = (await getDefaultLocationId(env)) ?? undefined;
        if (!locationId) {
          return { content: [{ type: "text", text: "Set a default location first to get accurate sale prices." }] };
        }
        const products = await getProductsByIds(env, { productIds: doc.items.map((i) => i.productId), locationId });
        const onSale = products.filter((p) => p.onSale);
        if (onSale.length === 0) return { content: [{ type: "text", text: "Nothing on sale right now." }] };
        const text = onSale
          .map((p) => `• ${p.description} — $${p.promoPrice?.toFixed(2)} (was $${p.regularPrice?.toFixed(2)})`)
          .join("\n");
        return { content: [{ type: "text", text: `On sale at your store:\n${text}` }] };
      },
    );
  }
}
