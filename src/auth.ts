import { Hono } from "hono";
import { html } from "hono/html";
import { AccessAuthError, identifyUser } from "./access.js";
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  generatePkcePair,
} from "./kroger.js";
import { setKrogerTokens } from "./storage.js";
import type { Env } from "./types.js";

const app = new Hono<{ Bindings: Env }>();

const KROGER_USER_SCOPE = "cart.basic:write profile.compact";

// ---------- Landing ----------

app.get("/", (c) => {
  return c.html(html`<!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Kroger MCP</title>
        <style>
          body { font-family: system-ui, sans-serif; max-width: 640px; margin: 4rem auto; padding: 0 1rem; }
          code { background: #f4f4f4; padding: 2px 4px; border-radius: 3px; }
        </style>
      </head>
      <body>
        <h1>Kroger MCP</h1>
        <p>Shared-household MCP for the Kroger Public API. To use:</p>
        <ol>
          <li>An owner connects the household Kroger account once: <a href="/kroger/connect">/kroger/connect</a> (requires Cloudflare Access login).</li>
          <li>Each family member adds this Worker as a remote MCP connector in Claude.ai. The OAuth flow lands them on Cloudflare Access SSO; once they're in, Claude gets a token bound to their email.</li>
        </ol>
      </body>
    </html>`);
});

// ---------- Family-member login (the OAuth provider's authorize endpoint) ----------
//
// Cloudflare Access protects this path. By the time the request reaches us,
// the user has already authenticated through Access (Google / OTP / whatever
// is configured). We read their identity from the Access JWT and immediately
// complete the OAuth grant — no second password prompt.
//
// Access policy must protect /authorize and /kroger/* but NOT /sse or /mcp;
// those are server-to-server calls from Claude using the bearer token issued
// here, so Access would block them.

app.get("/authorize", async (c) => {
  const oauthReq = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const client = await c.env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
  if (!client) return c.text("unknown client", 400);

  let identity;
  try {
    identity = await identifyUser(c.req.raw, c.env);
  } catch (err) {
    return accessErrorResponse(err);
  }

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReq,
    userId: identity.email,
    metadata: { email: identity.email },
    scope: oauthReq.scope,
    props: { userId: identity.email, email: identity.email },
  });
  return c.redirect(redirectTo);
});

// ---------- Kroger OAuth (worker → Kroger) ----------
//
// One-time household consent. Any family member with Access can run this — the
// resulting refresh token is shared. State carries the PKCE verifier through
// the Kroger redirect.

app.get("/kroger/connect", async (c) => {
  try {
    await identifyUser(c.req.raw, c.env);
  } catch (err) {
    return accessErrorResponse(err);
  }

  const { verifier, challenge } = await generatePkcePair();
  const state = crypto.randomUUID();
  await c.env.KROGER_KV.put(`pkce:${state}`, verifier, { expirationTtl: 600 });

  const url = buildAuthorizeUrl({
    clientId: c.env.KROGER_CLIENT_ID,
    redirectUri: `${c.env.BASE_URL}/kroger/callback`,
    scope: KROGER_USER_SCOPE,
    state,
    codeChallenge: challenge,
  });
  return c.redirect(url);
});

app.get("/kroger/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");
  if (error) return c.text(`Kroger error: ${error}`, 400);
  if (!code || !state) return c.text("missing code or state", 400);

  const verifier = await c.env.KROGER_KV.get(`pkce:${state}`);
  if (!verifier) return c.text("invalid or expired state", 400);
  await c.env.KROGER_KV.delete(`pkce:${state}`);

  const tokens = await exchangeAuthorizationCode(
    c.env,
    code,
    `${c.env.BASE_URL}/kroger/callback`,
    verifier,
  );
  await setKrogerTokens(c.env, tokens);

  return c.html(html`<!doctype html>
    <html><body style="font-family: system-ui, sans-serif; max-width: 480px; margin: 4rem auto;">
      <h1>Kroger account connected</h1>
      <p>The household Kroger account is wired up. Family members can now use Claude to add items.</p>
    </body></html>`);
});

function accessErrorResponse(err: unknown): Response {
  if (err instanceof AccessAuthError) {
    return new Response(err.message, { status: err.status });
  }
  return new Response(`Auth failure: ${(err as Error).message ?? "unknown"}`, { status: 401 });
}

export default app;
