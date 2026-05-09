import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./types.js";

// Cloudflare Access puts the signed identity JWT in this header on every
// request that successfully passed through Access.
const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";

interface JwksCacheEntry {
  team: string;
  jwks: ReturnType<typeof createRemoteJWKSet>;
}

// One JWKS resolver per team domain, kept in module scope so it survives across
// requests inside the same isolate (jose handles its own internal cache too).
let jwksCache: JwksCacheEntry | null = null;

function jwksFor(team: string) {
  if (jwksCache?.team === team) return jwksCache.jwks;
  const jwks = createRemoteJWKSet(
    new URL(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`),
  );
  jwksCache = { team, jwks };
  return jwks;
}

export interface AccessIdentity {
  email: string;
}

export class AccessAuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

// Resolve the identity of the human currently driving the request.
//
// In production: verify the JWT Access stamped on the request. The team domain
// + audience must match what's configured on the Access Application that
// fronts this Worker.
//
// In local dev (no Access in front): if DEV_AUTH_EMAIL is set, trust it. This
// is the only way to exercise the OAuth flow on `wrangler dev`. Don't set it
// in production — it would let anyone bypass Access by hitting the Worker URL
// directly.
export async function identifyUser(request: Request, env: Env): Promise<AccessIdentity> {
  // DEV_AUTH_EMAIL is a footgun in production — if a secret with that name
  // ever gets set on the deployed Worker (typo, copy-paste, leftover from a
  // local config sync), it would silently bypass Access for everyone. Defense
  // in depth: only honor it when the request is hitting the Worker via
  // localhost, which is impossible from outside `wrangler dev`.
  if (env.DEV_AUTH_EMAIL) {
    const { hostname } = new URL(request.url);
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return { email: env.DEV_AUTH_EMAIL };
    }
  }

  // Surface a misconfigured deploy with a clear 500 before doing anything that
  // depends on these vars. This way an operator who forgot to set the Access
  // vars sees the right error on their first request, not "missing JWT" which
  // points them in the wrong direction.
  if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) {
    throw new AccessAuthError(
      "Worker is misconfigured: CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must be set.",
      500,
    );
  }

  const jwt = request.headers.get(ACCESS_JWT_HEADER);
  if (!jwt) {
    throw new AccessAuthError(
      "Missing Cf-Access-Jwt-Assertion. This Worker must be deployed behind Cloudflare Access.",
    );
  }

  const { payload } = await jwtVerify(jwt, jwksFor(env.CF_ACCESS_TEAM_DOMAIN), {
    audience: env.CF_ACCESS_AUD,
    issuer: `https://${env.CF_ACCESS_TEAM_DOMAIN}.cloudflareaccess.com`,
    // Cloudflare Access signs with RS256. Pinning rules out any future
    // algorithm-confusion attack if the JWKS ever publishes more keys.
    algorithms: ["RS256"],
  });
  const email = typeof payload.email === "string" ? payload.email : null;
  if (!email) throw new AccessAuthError("Access JWT did not include an email claim.");
  return { email };
}
