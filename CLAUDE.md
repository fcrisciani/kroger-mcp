# CLAUDE.md

Guidance for Claude Code (and other AI agents) working in this repo.

## What this is

A personal Model Context Protocol server for the **Kroger Public API**, deployed
as a single Cloudflare Worker. It exists so the user can ask Claude things like
"prepare my weekly grocery order" or "add oat milk to my Kroger cart" and have
those requests turn into real cart entries on kroger.com.

This is a **single-user** deployment by design. There is one owner, one Kroger
account, one set of "usual items".

## Hard constraint: the API cannot place an order

The public Kroger API exposes:
- `GET /v1/products`, `GET /v1/locations` — product/location search (client_credentials).
- `PUT /v1/cart/add` — add UPCs to the signed-in user's cart (`cart.basic:write`).

There is **no** public endpoint to read the cart, modify quantities, remove
items, or check out. The MCP's job ends at "items are in the kroger.com cart" —
the user finishes checkout themselves at <https://www.kroger.com/cart>.

If you find yourself wanting to write a `place_order` or `get_cart` tool: stop.
That requires the partner API (Kroger business agreement) and is out of scope.

## Architecture

```
Claude.ai (or Desktop) ──OAuth 2.1──▶ Worker ──OAuth 2.0 (auth code)──▶ Kroger
                                       │
                                       ├── OAUTH_KV   (provider grants/tokens)
                                       └── KROGER_KV  (kroger refresh token,
                                                       default location,
                                                       usual-items list)
```

Two completely separate auth boundaries:

1. **Claude → Worker** (`@cloudflare/workers-oauth-provider`).
   The Worker is its own OAuth 2.1 provider. Claude's connector flow lands the
   user on `/authorize`, which renders a login form. The form validates against
   `OWNER_EMAIL` / `OWNER_PASSWORD` (single allowed user). On success, the
   provider issues an auth code → Claude exchanges it for an access token →
   Claude calls `/sse` or `/mcp` with that token. Provider state lives in
   `OAUTH_KV`.

2. **Worker → Kroger** (one-time owner consent).
   Visit `/kroger/connect` once (Basic Auth-protected). The Worker generates a
   PKCE pair, redirects you to Kroger, receives the code at `/kroger/callback`,
   exchanges it for an access + refresh token, and stores the refresh token in
   `KROGER_KV`. From then on, cart writes use a fresh access token minted from
   that refresh token.

Don't conflate the two. Tools never touch Claude's OAuth state; the provider
never touches Kroger tokens.

## Key files

| File              | Purpose                                                     |
|-------------------|-------------------------------------------------------------|
| `src/index.ts`    | Entry point. Wires `OAuthProvider` → MCP + default handler. |
| `src/mcp.ts`      | `KrogerMCP` `McpAgent` subclass. All tool definitions.      |
| `src/kroger.ts`   | Kroger API client: tokens (CC + auth-code + refresh), products, locations, cart, PKCE helpers. |
| `src/auth.ts`     | Hono app: landing page, `/authorize` login, Kroger OAuth setup (`/kroger/connect`, `/kroger/callback`). |
| `src/storage.ts`  | KV helpers (tokens, default location, usual items).         |
| `src/types.ts`    | Shared types (`Env`, `SessionProps`, domain shapes).        |
| `wrangler.jsonc`  | Worker config: KV bindings, DO migrations, vars.            |

## Tools (alphabetical)

- `add_one_off` — fuzzy product search + add top match to Kroger cart.
- `add_usual_item` — upsert into the recurring grocery list.
- `check_sales_on_usuals` — read-only: which of my usual items are on sale?
- `find_locations` — store search by ZIP.
- `get_default_location` / `set_default_location` — pin a `locationId`.
- `list_usual_items` — show recurring items; filter by what's due.
- `prepare_weekly_order` — *the* tool. Pulls due-cadence usuals, resolves
  each to a current-price product at the default store, calls `cart/add`,
  bumps `lastOrdered`, returns a summary + checkout URL. Surfaces sale items.
- `remove_usual_item`, `update_usual_item` — list maintenance.
- `search_products` — catalog search (price-aware when default location is set).

## KV layout

`KROGER_KV`:
- `kroger:tokens` → `{ accessToken, refreshToken, expiresAt, scope }`
- `kroger:cc_token` → `{ accessToken, expiresAt }` (TTL'd; client-credentials cache)
- `prefs:default_location_id` → `string`
- `prefs:usual_items` → `{ items: UsualItem[], updatedAt }`
- `pkce:<state>` → `string` (verifier, 10-min TTL during OAuth dance)

`OAUTH_KV` is owned by `@cloudflare/workers-oauth-provider`. Don't touch it.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in real values
npm run kv:create                # paste IDs into wrangler.jsonc
npm run dev                      # http://localhost:8787
```

For Kroger OAuth to work in local dev, register `http://localhost:8787/kroger/callback`
as a redirect URI on your Kroger app, and set `BASE_URL=http://localhost:8787`
in `.dev.vars`.

## Deploy

```bash
wrangler deploy
wrangler secret put KROGER_CLIENT_ID
wrangler secret put KROGER_CLIENT_SECRET
wrangler secret put OWNER_EMAIL
wrangler secret put OWNER_PASSWORD
wrangler secret put COOKIE_ENCRYPTION_KEY   # any random 32+ byte string
```

Then update `BASE_URL` in `wrangler.jsonc` to the real Workers URL, redeploy,
register `<BASE_URL>/kroger/callback` on the Kroger developer portal, and
visit `<BASE_URL>/kroger/connect` once to authorize.

## Connecting from Claude

Add the Worker as a remote MCP connector pointing at `<BASE_URL>/sse` (or
`/mcp` for streamable HTTP). Claude opens the OAuth flow, you log in with the
owner credentials, and tools become available.

## Conventions for AI agents editing this repo

- **Don't hand-roll Kroger HTTP calls in tools.** Add a typed function in
  `src/kroger.ts` and call it from the tool. Tools should be thin glue.
- **Don't add a "checkout" tool.** See the hard constraint above.
- **Don't add multi-tenant plumbing.** Single-user is a design choice; if the
  user wants multi-user later, that's a deliberate redesign of the KV schema
  and props plumbing, not an incremental change.
- **Don't read/write `OAUTH_KV` directly.** That's the OAuth provider's data.
  Use the `OAUTH_PROVIDER` helper passed to the default handler if you need
  anything from it (you almost certainly don't).
- **Schema changes to `usual_items`** must be additive and tolerate old
  documents in KV (no forced migrations, no failing reads on missing fields).
- **New tools follow the pattern in `src/mcp.ts`**: zod schema for inputs, one
  `await` call to a `kroger.ts` or `storage.ts` function, return `{ content:
  [{ type: "text", text }] }`.
- **No comments restating what the code does.** Keep comments for the *why*
  (subtle invariants, API quirks, security reasoning).
- **Type-check before committing**: `npm run typecheck`.
