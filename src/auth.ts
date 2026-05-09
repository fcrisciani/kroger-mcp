import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { html } from "hono/html";
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
        <p>Personal MCP server for the Kroger Public API. To use:</p>
        <ol>
          <li>Connect a Kroger account: <a href="/kroger/connect">/kroger/connect</a></li>
          <li>In Claude.ai, add this Worker as a remote MCP connector. The OAuth flow will land you on the login screen.</li>
        </ol>
      </body>
    </html>`);
});

// ---------- Owner login (the OAuth provider's authorize endpoint) ----------
//
// workers-oauth-provider routes /authorize requests to the default handler
// when the user is not yet authenticated. We render a login form, validate
// against OWNER_EMAIL/OWNER_PASSWORD, then call completeAuthorization to
// redirect back to Claude.ai with an auth code.

app.get("/authorize", async (c) => {
  const oauthReq = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const client = await c.env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
  if (!client) return c.text("unknown client", 400);

  // Encode the OAuth request so we can round-trip it through the form.
  const stateBlob = btoa(JSON.stringify(oauthReq));
  return c.html(html`<!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Sign in to Kroger MCP</title>
        <style>
          body { font-family: system-ui, sans-serif; max-width: 360px; margin: 6rem auto; padding: 0 1rem; }
          input { width: 100%; padding: 0.5rem; margin: 0.25rem 0 0.75rem; box-sizing: border-box; }
          button { padding: 0.5rem 1rem; }
          .err { color: #b00020; margin-bottom: 1rem; }
          .who { color: #666; font-size: 0.9rem; }
        </style>
      </head>
      <body>
        <h1>Sign in</h1>
        <p class="who">Authorizing <b>${client.clientName ?? client.clientId}</b> to access your Kroger MCP.</p>
        <form method="post" action="/authorize">
          <label>Email<input name="email" type="email" required autofocus /></label>
          <label>Password<input name="password" type="password" required /></label>
          <input type="hidden" name="oauth_req" value="${stateBlob}" />
          <button type="submit">Continue</button>
        </form>
      </body>
    </html>`);
});

app.post("/authorize", async (c) => {
  const form = await c.req.formData();
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");
  const oauthReqEncoded = String(form.get("oauth_req") ?? "");
  if (!oauthReqEncoded) return c.text("missing oauth_req", 400);

  const oauthReq = JSON.parse(atob(oauthReqEncoded));

  const owner = c.env.OWNER_EMAIL;
  const ok =
    email.length > 0 &&
    password.length > 0 &&
    timingSafeEqual(email, owner) &&
    timingSafeEqual(password, c.env.OWNER_PASSWORD);
  if (!ok) {
    return c.html(
      html`<p class="err">Invalid email or password.</p><p><a href="javascript:history.back()">Back</a></p>`,
      401,
    );
  }

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReq,
    userId: owner,
    metadata: { email: owner },
    scope: oauthReq.scope,
    props: { userId: owner, email: owner },
  });
  return c.redirect(redirectTo);
});

// ---------- Kroger OAuth (worker → Kroger) ----------
//
// One-time consent flow. Owner-protected via Basic Auth so only you can
// initiate it from a browser. The callback uses `state` to find the stored
// PKCE verifier in KV.

app.use("/kroger/connect", basicAuthMiddleware());

app.get("/kroger/connect", async (c) => {
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
      <p>You can close this tab and return to Claude.</p>
    </body></html>`);
});

// ---------- helpers ----------

function basicAuthMiddleware(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const header = c.req.raw.headers.get("authorization") ?? "";
    if (!header.startsWith("Basic ")) {
      return new Response("auth required", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="kroger-mcp"' },
      });
    }
    const decoded = atob(header.slice(6));
    const idx = decoded.indexOf(":");
    if (idx < 0) return c.text("malformed", 401);
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);
    if (!timingSafeEqual(user, c.env.OWNER_EMAIL) || !timingSafeEqual(pass, c.env.OWNER_PASSWORD)) {
      return c.text("forbidden", 403);
    }
    await next();
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default app;
