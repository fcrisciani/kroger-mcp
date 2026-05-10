import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  addItemsToCart,
  findLocations,
  getLocation,
  getProductsByIds,
  searchProducts,
} from "./kroger.js";
import {
  clearDefaultLocationChain,
  getCheckoutUrl,
  getDefaultLocationChain,
  getDefaultLocationId,
  getUsualItems,
  patchUsualItem,
  removeUsualItem,
  setDefaultLocationChain,
  setDefaultLocationId,
  upsertUsualItem,
} from "./storage.js";
import type { Env, SessionProps } from "./types.js";
import { runWeeklyOrder } from "./weekly-order.js";
import { isDue, priceLine } from "./util.js";

export class KrogerMCP extends McpAgent<Env, unknown, SessionProps> {
  server = new McpServer({ name: "kroger-mcp", version: "0.1.0" });

  async init(): Promise<void> {
    const env = this.env;

    // ---------- locations ----------

    this.server.tool(
      "find_locations",
      "Find Kroger-family stores near a ZIP code. Use this to pick a default store. Output includes the banner (KROGER, KINGSOOPERS, FREDMEYER, …) since each banner has its own website.",
      {
        zipCode: z.string().regex(/^\d{5}$/),
        radiusInMiles: z.number().int().min(1).max(100).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      async ({ zipCode, radiusInMiles, limit }) => {
        const locs = await findLocations(env, { zipCode, radiusInMiles, limit });
        const lines = locs.map((l) => {
          const banner = l.chain ? `[${l.chain}] ` : "";
          return `${l.locationId}  ${banner}${l.name} — ${l.address.addressLine1}, ${l.address.city}, ${l.address.state} ${l.address.zipCode}`;
        });
        return { content: [{ type: "text", text: lines.join("\n") || "No stores found." }] };
      },
    );

    this.server.tool(
      "set_default_location",
      "Save a Kroger locationId as the default store for searches and the cart. Also records the store's banner so checkout links point at the right site (kingsoopers.com, fredmeyer.com, …).",
      { locationId: z.string().min(1) },
      async ({ locationId }) => {
        await setDefaultLocationId(env, locationId);
        // Best-effort: look up the banner so checkout URLs are correct. If the
        // lookup fails, drop any stale chain rather than pointing at the wrong
        // banner's site — the checkout URL then falls back to kroger.com.
        let bannerNote = " The store's banner couldn't be determined; checkout links will use kroger.com.";
        try {
          const loc = await getLocation(env, locationId);
          if (loc?.chain) {
            await setDefaultLocationChain(env, loc.chain);
            bannerNote = ` Banner: ${loc.chain}.`;
          } else {
            await clearDefaultLocationChain(env);
          }
        } catch {
          await clearDefaultLocationChain(env);
        }
        return { content: [{ type: "text", text: `Default location set to ${locationId}.${bannerNote}` }] };
      },
    );

    this.server.tool(
      "get_default_location",
      "Return the currently saved default locationId and its banner, if any.",
      {},
      async () => {
        const loc = await getDefaultLocationId(env);
        if (!loc) {
          return { content: [{ type: "text", text: "No default location set. Use find_locations + set_default_location." }] };
        }
        const chain = await getDefaultLocationChain(env);
        const checkout = await getCheckoutUrl(env);
        return {
          content: [{ type: "text", text: `Default location: ${loc}${chain ? ` (banner: ${chain})` : ""}. Checkout URL: ${checkout}` }],
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
        const checkoutUrl = await getCheckoutUrl(env);
        return {
          content: [
            {
              type: "text",
              text: `Added ${quantity ?? 1} × ${top.description} (${priceLine(top)}) to your Kroger cart. Review and checkout: ${checkoutUrl}`,
            },
          ],
        };
      },
    );

    // ---------- usual items CRUD ----------

    this.server.tool(
      "list_usual_items",
      "List the household's shared recurring grocery items. Set onlyDue=true to filter to items whose cadence makes them due to reorder. Each entry shows which family member added it.",
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
            const by = i.addedBy ? ` · added by ${i.addedBy}` : "";
            return `[${due}] ${i.name} — qty ${i.defaultQty}, ${i.cadence}, last ${last}${by}, productId=${i.productId}`;
          })
          .join("\n");
        return { content: [{ type: "text", text }] };
      },
    );

    this.server.tool(
      "add_usual_item",
      "Add or update an item in the shared household recurring list. The caller's email is recorded as `addedBy`. Use search_products to find a productId first.",
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
          addedBy: this.props.email,
        });
        return {
          content: [
            {
              type: "text",
              text: `Saved usual item: ${item.name} (${item.cadence}, qty ${item.defaultQty}${item.addedBy ? `, added by ${item.addedBy}` : ""}).`,
            },
          ],
        };
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
        const patch: Parameters<typeof patchUsualItem>[2] = {};
        if (defaultQty !== undefined) patch.defaultQty = defaultQty;
        if (cadence !== undefined) patch.cadence = cadence;
        if (notes !== undefined) patch.notes = notes;
        const updated = await patchUsualItem(env, productId, patch);
        if (!updated) return { content: [{ type: "text", text: "No matching item." }] };
        return { content: [{ type: "text", text: `Updated ${updated.name}.` }] };
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
      async (args) => {
        const text = await runWeeklyOrder(env, args);
        return { content: [{ type: "text", text }] };
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
        // normalizeProduct guarantees both prices are defined when onSale is true.
        const text = onSale
          .map((p) => `• ${p.description} — $${p.promoPrice!.toFixed(2)} (was $${p.regularPrice!.toFixed(2)})`)
          .join("\n");
        return { content: [{ type: "text", text: `On sale at your store:\n${text}` }] };
      },
    );
  }
}
