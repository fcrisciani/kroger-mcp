import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildCart } from "./cart.js";
import {
  findLocations,
  getLocation,
  getProductsByIds,
  searchProducts,
  type KrogerProduct,
  type ProductFulfillment,
} from "./kroger.js";
import {
  bulkUpsertUsualItems,
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

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

// Structured-ish errors so the agent can self-heal (retry the right
// precondition) instead of escalating to a human. Codes: NO_DEFAULT_LOCATION,
// KROGER_NOT_CONNECTED, PRODUCT_NOT_FOUND, MISSING_ARGS, INTERNAL_ERROR.
function fail(code: string, message: string): ToolResult {
  return { content: [{ type: "text", text: `${code}: ${message}` }], isError: true };
}

async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not connected/i.test(msg)) {
      return fail(
        "KROGER_NOT_CONNECTED",
        "The household Kroger account isn't connected. Visit /kroger/connect on the Worker (a Cloudflare Access login) to authorize it, then retry.",
      );
    }
    return fail("INTERNAL_ERROR", msg);
  }
}

async function requireDefaultLocation(env: Env): Promise<string | ToolResult> {
  const loc = await getDefaultLocationId(env);
  if (loc) return loc;
  return fail(
    "NO_DEFAULT_LOCATION",
    "No default store set. Call find_locations with a ZIP, then set_default_location with the chosen locationId.",
  );
}
function isToolResult(x: unknown): x is ToolResult {
  return typeof x === "object" && x !== null && "content" in x;
}

function fulfillmentSummary(f?: ProductFulfillment): string | undefined {
  if (!f) return undefined;
  const parts: string[] = [];
  if (f.curbside !== undefined) parts.push(`pickup${f.curbside ? "✓" : "✗"}`);
  if (f.delivery !== undefined) parts.push(`delivery${f.delivery ? "✓" : "✗"}`);
  if (f.shipToHome) parts.push("ship✓");
  return parts.length ? parts.join(" ") : undefined;
}

// Compact multi-line block per product so the model has enough to compare:
// name + price (+ per-unit estimate), then the attributes Kroger gives us
// (size, brand, category, temperature, sold-by, origin, fulfillment), then ids.
function formatProduct(p: KrogerProduct, n: number): string {
  // Mirror priceLine: when on sale, the per-unit estimate should be the promo one.
  const pricePerUnit =
    p.onSale && typeof p.promoPricePerUnit === "number" ? p.promoPricePerUnit : p.regularPricePerUnit;
  const perUnit = typeof pricePerUnit === "number" ? ` (~$${pricePerUnit.toFixed(2)}/unit)` : "";
  const attrs = [
    p.size,
    p.brand,
    p.categories?.length ? p.categories.join("/") : undefined,
    p.temperature && p.temperature.toLowerCase() !== "ambient" ? p.temperature.toLowerCase() : undefined,
    p.soldBy ? `sold by ${p.soldBy.toLowerCase()}` : undefined,
    p.countryOrigin ? `from ${p.countryOrigin}` : undefined,
    fulfillmentSummary(p.fulfillment),
  ].filter(Boolean);
  const lines = [`${n}. ${p.description} — ${priceLine(p)}${perUnit}`];
  if (attrs.length) lines.push(`   ${attrs.join(" · ")}`);
  lines.push(`   id=${p.productId} upc=${p.upc}`);
  return lines.join("\n");
}

const CADENCE = z.enum(["weekly", "biweekly", "monthly"]);
const MODALITY = z.enum(["PICKUP", "DELIVERY"]);

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
      async ({ zipCode, radiusInMiles, limit }) =>
        guard(async () => {
          const locs = await findLocations(env, { zipCode, radiusInMiles, limit });
          const lines = locs.map((l) => {
            const banner = l.chain ? `[${l.chain}] ` : "";
            return `${l.locationId}  ${banner}${l.name} — ${l.address.addressLine1}, ${l.address.city}, ${l.address.state} ${l.address.zipCode}`;
          });
          return ok(lines.join("\n") || "No stores found.");
        }),
    );

    this.server.tool(
      "set_default_location",
      "Save a Kroger locationId as the default store for searches and the cart. Validates the locationId first, and records the store's banner so checkout links point at the right site (kingsoopers.com, fredmeyer.com, …). Idempotent — re-running it re-derives the banner.",
      { locationId: z.string().min(1) },
      async ({ locationId }) =>
        guard(async () => {
          // Validate before storing: a bogus locationId would otherwise become
          // the default and break every later product/cart call. On a
          // *transient* lookup failure (not a 404) we still store it — refusing
          // would be annoying if Kroger is just briefly flaky — but we clear
          // any stale banner so the checkout URL falls back to kroger.com.
          let loc;
          try {
            loc = await getLocation(env, locationId);
          } catch {
            await setDefaultLocationId(env, locationId);
            await clearDefaultLocationChain(env);
            return ok(`Default location set to ${locationId}. (Couldn't reach Kroger to verify the store or its banner; checkout links will use kroger.com.)`);
          }
          if (!loc) {
            return fail("PRODUCT_NOT_FOUND", `No store found with locationId ${locationId}. Use find_locations to get a valid one.`);
          }
          await setDefaultLocationId(env, locationId);
          if (loc.chain) await setDefaultLocationChain(env, loc.chain);
          else await clearDefaultLocationChain(env);
          const bannerNote = loc.chain ? ` Banner: ${loc.chain}.` : " (Banner unknown; checkout links will use kroger.com.)";
          return ok(`Default location set to ${locationId} — ${loc.name}.${bannerNote}`);
        }),
    );

    this.server.tool(
      "get_default_location",
      "Return the currently saved default locationId, its banner, and the resolved checkout URL.",
      {},
      async () =>
        guard(async () => {
          const loc = await getDefaultLocationId(env);
          if (!loc) return ok("No default location set. Use find_locations + set_default_location.");
          const chain = await getDefaultLocationChain(env);
          const checkout = await getCheckoutUrl(env, chain);
          return ok(`Default location: ${loc}${chain ? ` (banner: ${chain})` : ""}. Checkout URL: ${checkout}`);
        }),
    );

    // ---------- product search ----------

    this.server.tool(
      "search_products",
      "Search Kroger's product catalog. Each result lists productId + upc (pass a chosen `upc` to add_to_cart for a deterministic add), brand, category, size, sold-by-weight-vs-unit, temperature (ambient/refrigerated/frozen), country of origin, and per-fulfillment availability (pickup/delivery). If a default location is set, prices/sale flags and a per-unit price estimate are for that store. Fresh-produce results are nudged up when the query has no brand/processing words.",
      {
        term: z.string().min(1),
        limit: z.number().int().min(1).max(25).optional(),
        brand: z.string().optional(),
        locationId: z.string().optional(),
      },
      async ({ term, limit, brand, locationId }) =>
        guard(async () => {
          const loc = locationId ?? (await getDefaultLocationId(env)) ?? undefined;
          const products = await searchProducts(env, { term, limit, brand, locationId: loc });
          if (products.length === 0) return ok(`No products matched "${term}".`);
          return ok(products.map((p, i) => formatProduct(p, i + 1)).join("\n"));
        }),
    );

    // ---------- cart ----------

    this.server.tool(
      "add_to_cart",
      "Add one or more products to the Kroger cart in a single call. Each item is identified by `upc` (deterministic — get it from search_products), or `productId` (resolved to a UPC server-side), or `query` (fuzzy search, top match — less reliable, prefer upc). Returns a per-item result + a checkout link. Requires a default store.",
      {
        items: z
          .array(
            z.object({
              upc: z.string().optional(),
              productId: z.string().optional(),
              query: z.string().optional(),
              quantity: z.number().int().min(1).max(50).optional(),
              modality: MODALITY.optional(),
            }),
          )
          .min(1)
          .max(100),
      },
      async ({ items }) =>
        guard(async () => {
          const loc = await requireDefaultLocation(env);
          if (isToolResult(loc)) return loc;
          const result = await buildCart(env, items, loc);
          const lines: string[] = [`Added ${result.added.length} of ${items.length} item(s) to your Kroger cart.`];
          for (const a of result.added) {
            // For an upc-only line `from` is already "upc <x>", so don't repeat it.
            const head = a.name ? `${a.name}${a.price ? ` — ${a.price}` : ""} [upc ${a.upc}]` : `upc ${a.upc}`;
            lines.push(`✓ ${a.quantity} × ${head}`);
          }
          for (const s of result.skipped) lines.push(`✗ ${s.from} — ${s.reason}`);
          lines.push("", `Review & checkout: ${result.checkoutUrl}`);
          return ok(lines.join("\n"));
        }),
    );

    this.server.tool(
      "add_one_off",
      "Convenience: search for a single item by free text and add the top match to the Kroger cart. For anything ambiguous prefer search_products → add_to_cart with the chosen upc. Set autoAdd=false to just see the matches. Requires a default store.",
      {
        query: z.string().min(1),
        quantity: z.number().int().min(1).max(50).optional(),
        autoAdd: z.boolean().optional(),
      },
      async ({ query, quantity, autoAdd }) =>
        guard(async () => {
          const auto = autoAdd ?? true;
          if (!auto) {
            const loc = (await getDefaultLocationId(env)) ?? undefined;
            const products = await searchProducts(env, { term: query, limit: 5, locationId: loc });
            if (products.length === 0) return ok(`No products matched "${query}".`);
            const t = products.map((p, i) => formatProduct(p, i + 1)).join("\n");
            return ok(`Top matches for "${query}" — call add_to_cart with the chosen upc:\n${t}`);
          }
          const locOrErr = await requireDefaultLocation(env);
          if (isToolResult(locOrErr)) return locOrErr;
          const result = await buildCart(env, [{ query, quantity }], locOrErr);
          const a = result.added[0];
          if (a) {
            return ok(`Added ${a.quantity} × ${a.name ?? a.from}${a.price ? ` (${a.price})` : ""} to your Kroger cart. Review & checkout: ${result.checkoutUrl}`);
          }
          const s = result.skipped[0];
          return fail("PRODUCT_NOT_FOUND", `Couldn't add "${query}"${s ? `: ${s.reason}` : "."}`);
        }),
    );

    // ---------- usual items ----------

    this.server.tool(
      "list_usual_items",
      "List the household's shared recurring grocery items. Set onlyDue=true to filter to items whose cadence makes them due to reorder. Each entry shows which family member added it.",
      { onlyDue: z.boolean().optional() },
      async ({ onlyDue }) =>
        guard(async () => {
          const doc = await getUsualItems(env);
          const items = onlyDue ? doc.items.filter((i) => isDue(i)) : doc.items;
          if (items.length === 0) return ok(onlyDue ? "Nothing due to reorder." : "No usual items saved yet.");
          const text = items
            .map((i) => {
              const due = isDue(i) ? "DUE" : "ok";
              const last = i.lastOrdered ?? "never";
              const by = i.addedBy ? ` · added by ${i.addedBy}` : "";
              return `[${due}] ${i.name} — qty ${i.defaultQty}, ${i.cadence}, last ${last}${by}, productId=${i.productId}`;
            })
            .join("\n");
          return ok(text);
        }),
    );

    this.server.tool(
      "add_usual_item",
      "Add or update an item in the household recurring list. Provide either a free-text `query` (resolved to the top product match server-side — the response echoes back the resolved name to verify) OR an explicit `productId` + `name`. The caller's email is recorded as `addedBy`.",
      {
        query: z.string().optional(),
        productId: z.string().optional(),
        name: z.string().optional(),
        defaultQty: z.number().int().min(1).max(50),
        cadence: CADENCE,
        notes: z.string().optional(),
      },
      async (args) =>
        guard(async () => {
          let productId = args.productId;
          let name = args.name;
          if (!productId || !name) {
            if (!args.query) return fail("MISSING_ARGS", "Provide either `query`, or both `productId` and `name`.");
            const loc = (await getDefaultLocationId(env)) ?? undefined;
            const matches = await searchProducts(env, { term: args.query, limit: 5, locationId: loc });
            const top = matches[0];
            if (!top) return fail("PRODUCT_NOT_FOUND", `No products matched "${args.query}".`);
            productId = top.productId;
            name = top.description;
          }
          const item = await upsertUsualItem(env, {
            productId,
            name,
            defaultQty: args.defaultQty,
            cadence: args.cadence,
            notes: args.notes,
            timesOrdered: 0,
            addedBy: this.props.email,
          });
          return ok(`Saved usual item: ${item.name} (${item.cadence}, qty ${item.defaultQty}${item.addedBy ? `, added by ${item.addedBy}` : ""}). productId=${item.productId}`);
        }),
    );

    this.server.tool(
      "promote_to_usuals",
      "Bulk-add products to the household recurring list — handy for turning a just-built weekly cart into usuals so next week is one tool call. Each item needs productId, name, and cadence; defaultQty defaults to 1. New items get the caller's email as `addedBy`; existing items keep their original `addedBy` and order history.",
      {
        items: z
          .array(
            z.object({
              productId: z.string().min(1),
              name: z.string().min(1),
              cadence: CADENCE,
              defaultQty: z.number().int().min(1).max(50).optional(),
              notes: z.string().optional(),
            }),
          )
          .min(1)
          .max(100),
      },
      async ({ items }) =>
        guard(async () => {
          await bulkUpsertUsualItems(
            env,
            items.map((i) => ({
              productId: i.productId,
              name: i.name,
              cadence: i.cadence,
              defaultQty: i.defaultQty ?? 1,
              notes: i.notes,
              timesOrdered: 0,
              addedBy: this.props.email,
            })),
          );
          return ok(`Saved ${items.length} item(s) to the usual list.`);
        }),
    );

    this.server.tool(
      "remove_usual_item",
      "Remove a productId from the recurring list.",
      { productId: z.string().min(1) },
      async ({ productId }) =>
        guard(async () => {
          const removed = await removeUsualItem(env, productId);
          return ok(removed ? "Removed." : "No matching item found.");
        }),
    );

    this.server.tool(
      "update_usual_item",
      "Tweak quantity, cadence, or notes for an existing usual item. Does not touch addedBy or order history.",
      {
        productId: z.string().min(1),
        defaultQty: z.number().int().min(1).max(50).optional(),
        cadence: CADENCE.optional(),
        notes: z.string().optional(),
      },
      async ({ productId, defaultQty, cadence, notes }) =>
        guard(async () => {
          const patch: Parameters<typeof patchUsualItem>[2] = {};
          if (defaultQty !== undefined) patch.defaultQty = defaultQty;
          if (cadence !== undefined) patch.cadence = cadence;
          if (notes !== undefined) patch.notes = notes;
          const updated = await patchUsualItem(env, productId, patch);
          if (!updated) return fail("PRODUCT_NOT_FOUND", `No usual item with productId ${productId}.`);
          return ok(`Updated ${updated.name}.`);
        }),
    );

    // ---------- weekly order ----------

    this.server.tool(
      "prepare_weekly_order",
      "Build this week's grocery cart on Kroger. Pulls items from the usual list whose cadence is due, adds them to the user's Kroger cart, and returns a summary plus a checkout link. Surfaces any items currently on sale.",
      {
        includeAll: z.boolean().optional(),
        modality: MODALITY.optional(),
      },
      async (args) => guard(async () => ok(await runWeeklyOrder(env, args))),
    );

    // ---------- sale watch ----------

    this.server.tool(
      "check_sales_on_usuals",
      "Check which of the household's usual items are currently on sale at the default store. Read-only.",
      {},
      async () =>
        guard(async () => {
          const doc = await getUsualItems(env);
          if (doc.items.length === 0) return ok("No usual items saved yet.");
          const loc = await requireDefaultLocation(env);
          if (isToolResult(loc)) return loc;
          const products = await getProductsByIds(env, { productIds: doc.items.map((i) => i.productId), locationId: loc });
          const onSale = products.filter((p) => p.onSale);
          if (onSale.length === 0) return ok("Nothing on sale right now.");
          // normalizeProduct guarantees both prices are defined when onSale is true.
          const text = onSale
            .map((p) => `• ${p.description} — $${p.promoPrice!.toFixed(2)} (was $${p.regularPrice!.toFixed(2)})`)
            .join("\n");
          return ok(`On sale at your store:\n${text}`);
        }),
    );
  }
}
