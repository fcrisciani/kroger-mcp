# CLAUDE.md

Guidance for Claude Code (and other AI agents) working in this repo.

## What this is

A **shared-household** Model Context Protocol server for the **Kroger Public
API**, deployed as a single Cloudflare Worker. Family members each connect
Claude to this Worker; their items go into one shared kroger.com cart, drawn
from one shared Kroger account.

## Hard constraint: the API cannot place an order

The public Kroger API exposes:
- `GET /v1/products`, `GET /v1/locations` — product/location search (client_credentials).
- `PUT /v1/cart/add` — add UPCs to the signed-in user's cart (`cart.basic:write`).

There is **no** public endpoint to read the cart, modify quantities, remove
items, or check out. The MCP's job ends at "items are in the kroger.com cart" —
someone in the household finishes checkout themselves at <https://www.kroger.com/cart>.

If you find yourself wanting to write a `place_order` or `get_cart` tool: stop.
That requires the partner API (Kroger business agreement) and is out of scope.

## Architecture

```
Family member's Claude ──OAuth 2.1──▶ Worker ──OAuth 2.0 (auth code)──▶ Kroger
                                       ▲                                  │
                                       │                                  ▼
                                Cloudflare Access            shared household account
                                  (SSO, family allowlist)         (one refresh token)

KV namespaces:
   OAUTH_KV   → provider grants/tokens (one per family member, one per Claude install)
   KROGER_KV  → shared kroger refresh token, default location, household usual-items list
```

Three identity layers, kept distinct:

1. **Family member → Worker authentication** (Cloudflare Access).
   Access fronts `/authorize` and `/kroger/*`. The family member logs in once
   via Access (Google / OTP / etc., configured in your Zero Trust dashboard).
   Cloudflare adds a signed `Cf-Access-Jwt-Assertion` header to every
   downstream request. The Worker verifies this JWT (signature + AUD + issuer)
   and reads `email` from the claims. **No passwords stored in the Worker.**
   The family allowlist lives entirely in the Access policy.

2. **Worker → Claude session** (`@cloudflare/workers-oauth-provider`).
   After Access verifies the human, the OAuth provider issues that family
   member their own bearer token bound to their email. Subsequent `/sse` and
   `/mcp` calls from Claude use this token. **`/sse` and `/mcp` are not behind
   Access** — Claude is a server-to-server caller and has no Access cookie;
   the OAuth provider's bearer token is what authenticates those endpoints.

3. **Worker → Kroger** (one-time household consent).
   Any family member visits `/kroger/connect` once. The Worker generates a
   PKCE pair, redirects to Kroger, receives the code at `/kroger/callback`,
   exchanges for an access + refresh token, and stores the refresh token in
   `KROGER_KV` under a single shared key. From then on, cart writes use a
   fresh access token minted from that refresh token. Anyone in the family can
   re-run `/kroger/connect` to rotate or replace the connected account.

Don't conflate the layers. Tools never touch Access state or Claude's OAuth
state; the OAuth provider never touches Kroger tokens.

## Key files

| File              | Purpose                                                     |
|-------------------|-------------------------------------------------------------|
| `src/index.ts`    | Entry point. Wires `OAuthProvider` → MCP + default handler. |
| `src/mcp.ts`      | `KrogerMCP` `McpAgent` subclass. All tool definitions.      |
| `src/kroger.ts`   | Kroger API client: tokens (CC + auth-code + refresh), products, locations, cart, PKCE helpers. |
| `src/access.ts`   | Cloudflare Access JWT verifier (JWKS cached per isolate).   |
| `src/auth.ts`     | Hono app: landing page, `/authorize` (Access-gated), Kroger OAuth setup. |
| `src/storage.ts`  | KV helpers (tokens, default location, usual items).         |
| `src/util.ts`     | Pure helpers: `isDue`, `priceLine`. Tested in isolation.    |
| `src/types.ts`    | Shared types (`Env`, `SessionProps`, domain shapes).        |
| `wrangler.jsonc`  | Worker config: KV bindings, DO migrations, vars.            |
| `.github/workflows/ci.yml` | typecheck → vitest → wrangler dry-run on every PR. |
| `tests/`          | Vitest unit tests (start with the pure helpers).            |

## Tools (alphabetical)

- `add_one_off` — fuzzy product search + add top match to shared Kroger cart.
- `add_usual_item` — upsert into the household recurring list. Stamps `addedBy`.
- `check_sales_on_usuals` — read-only: which household items are on sale?
- `find_locations` — store search by ZIP.
- `get_default_location` / `set_default_location` — pin a `locationId` for the household.
- `list_usual_items` — show recurring items (with `addedBy`); filter by what's due.
- `prepare_weekly_order` — *the* tool. Pulls due-cadence usuals, resolves
  each to a current-price product at the default store, calls `cart/add`,
  bumps `lastOrdered`, returns a summary + checkout URL. Surfaces sale items.
- `remove_usual_item`, `update_usual_item` — list maintenance.
- `search_products` — catalog search (price-aware when default location is set).

## KV layout

`KROGER_KV`:
- `kroger:tokens` → `{ accessToken, refreshToken, expiresAt, scope }` (one per household)
- `kroger:cc_token` → `{ accessToken, expiresAt }` (TTL'd; client-credentials cache)
- `prefs:default_location_id` → `string`
- `prefs:usual_items` → `{ items: UsualItem[], updatedAt }`. Each `UsualItem`
  has an optional `addedBy` (email of whoever created it). Documents written
  before the multi-member migration won't have it; readers must tolerate that.
- `pkce:<state>` → `string` (verifier, 10-min TTL during OAuth dance)

`OAUTH_KV` is owned by `@cloudflare/workers-oauth-provider`. Don't touch it.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in real values
npm run kv:create                # paste IDs into wrangler.jsonc
npm run dev                      # http://localhost:8787
```

Local dev does not have Cloudflare Access in front. Set `DEV_AUTH_EMAIL` in
`.dev.vars` to skip JWT verification and pretend you logged in as that email.
**Do not set `DEV_AUTH_EMAIL` in production** — it bypasses Access.

For the Kroger OAuth dance to work locally, register
`http://localhost:8787/kroger/callback` as a redirect URI on your Kroger app
and set `BASE_URL=http://localhost:8787` in `.dev.vars`.

## Deploy

```bash
wrangler deploy
wrangler secret put KROGER_CLIENT_ID
wrangler secret put KROGER_CLIENT_SECRET
wrangler secret put COOKIE_ENCRYPTION_KEY   # any random 32+ byte string
```

Update `BASE_URL`, `CF_ACCESS_TEAM_DOMAIN`, and `CF_ACCESS_AUD` in
`wrangler.jsonc` to your real values, then redeploy.

## Cloudflare Access setup

1. Cloudflare dashboard → Zero Trust → Access → Applications → **Add an application** → Self-hosted.
2. Application domain: `<BASE_URL>` host (e.g. `kroger-mcp.<subdomain>.workers.dev`).
3. **Path restriction is critical.** Add two path entries on this Application:
   - `/authorize`
   - `/kroger/*`
   Do **not** include `/sse` or `/mcp` — those are server-to-server calls from
   Claude using a bearer token, and Access would block them.
4. Configure your identity provider (Google, GitHub, OTP, …) and a policy
   allowing the family-member emails.
5. Copy the Application **AUD tag** into `wrangler.jsonc` as `CF_ACCESS_AUD`.
6. Set `CF_ACCESS_TEAM_DOMAIN` to your team subdomain (the `<team>` in
   `<team>.cloudflareaccess.com`).
7. Have an owner visit `<BASE_URL>/kroger/connect` once to authorize the
   shared Kroger account.

## Connecting from Claude

Each family member adds the Worker as a remote MCP connector pointing at
`<BASE_URL>/sse` (or `/mcp` for streamable HTTP). Claude opens the OAuth flow
in a popup, the popup hits Cloudflare Access SSO, the family member logs in,
and Claude is issued a token bound to their email. Tools become available.

## Conventions for AI agents editing this repo

- **Don't hand-roll Kroger HTTP calls in tools.** Add a typed function in
  `src/kroger.ts` and call it from the tool. Tools should be thin glue.
- **Don't add a "checkout" tool.** See the hard constraint above.
- **Don't store passwords in the Worker.** Identity comes from Cloudflare
  Access. If you need to add or remove a family member, do it in the Access
  policy in the Cloudflare dashboard.
- **Don't gate `/sse` or `/mcp` with Access.** Those are bearer-token
  endpoints; Access in front of them breaks Claude's connector.
- **Don't read/write `OAUTH_KV` directly.** That's the OAuth provider's data.
  Use the `OAUTH_PROVIDER` helper passed to the default handler if you need
  anything from it (you almost certainly don't).
- **Schema changes to `usual_items`** must be additive and tolerate old
  documents in KV (e.g. missing `addedBy`). No forced migrations, no failing
  reads on missing fields.
- **New tools follow the pattern in `src/mcp.ts`**: zod schema for inputs, one
  `await` call to a `kroger.ts` or `storage.ts` function, return `{ content:
  [{ type: "text", text }] }`. Stamp `addedBy = this.props.email` when
  creating a new usual item.
- **No comments restating what the code does.** Keep comments for the *why*
  (subtle invariants, API quirks, security reasoning).
- **Type-check and test before committing**: `npm run typecheck && npm test`.
