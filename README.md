# kroger-mcp

A personal MCP server for the [Kroger Public API](https://developer.kroger.com/api-products),
deployed as a Cloudflare Worker. Lets Claude prepare your weekly grocery cart
on kroger.com, add one-off items during the week, and remember the things you
usually buy.

> **Heads up.** The Kroger Public API can *add items to your cart* but cannot
> read the cart or place an order. The MCP gets your cart ready; you finish
> checkout at <https://www.kroger.com/cart>.

## What's in here

- Cloudflare Worker (TypeScript) speaking the MCP protocol on `/sse` and `/mcp`.
- OAuth 2.1 in front (single allowed user) via [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider).
- A second OAuth dance (one-time, owner-protected) to authorize the Worker
  against Kroger; refresh token persisted in KV.
- "Usual items" with weekly / biweekly / monthly cadence.
- Sale-aware summaries on the weekly order.

See [`CLAUDE.md`](./CLAUDE.md) for architecture, file map, KV layout, and
conventions for editing.

## Quick start

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in
npm run kv:create                # paste IDs into wrangler.jsonc
npm run dev
```

Then deploy and finish setup as documented in [`CLAUDE.md`](./CLAUDE.md).

## Tools exposed to Claude

`find_locations`, `set_default_location`, `get_default_location`,
`search_products`, `add_one_off`, `list_usual_items`, `add_usual_item`,
`update_usual_item`, `remove_usual_item`, `check_sales_on_usuals`,
`prepare_weekly_order`.
