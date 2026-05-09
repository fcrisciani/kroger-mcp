export interface Env {
  // KV
  OAUTH_KV: KVNamespace;
  KROGER_KV: KVNamespace;
  // Durable Object
  MCP_OBJECT: DurableObjectNamespace;
  // Vars
  BASE_URL: string;
  // Cloudflare Access — needed for JWT verification on /authorize
  CF_ACCESS_TEAM_DOMAIN: string;   // e.g. "myorg" for myorg.cloudflareaccess.com
  CF_ACCESS_AUD: string;           // Access Application AUD tag
  // Secrets
  KROGER_CLIENT_ID: string;
  KROGER_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
  // Optional: dev-only override that bypasses Access verification when set.
  DEV_AUTH_EMAIL?: string;
  // Injected by @cloudflare/workers-oauth-provider into apiHandlers
  OAUTH_PROVIDER: OAuthHelpers;
}

// Minimal subset of the workers-oauth-provider helper API we use.
export interface OAuthHelpers {
  parseAuthRequest(request: Request): Promise<AuthRequest>;
  lookupClient(clientId: string): Promise<ClientInfo | null>;
  completeAuthorization(opts: {
    request: AuthRequest;
    userId: string;
    metadata?: Record<string, unknown>;
    scope: string[];
    props: Record<string, unknown>;
  }): Promise<{ redirectTo: string }>;
}

export interface AuthRequest {
  responseType: string;
  clientId: string;
  redirectUri: string;
  scope: string[];
  state: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}

export interface ClientInfo {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
}

// Props attached to the MCP session after login. Available as `this.props` inside the agent.
export interface SessionProps extends Record<string, unknown> {
  userId: string;
  email: string;
}

// ----- Domain types -----

export type Cadence = "weekly" | "biweekly" | "monthly";

export interface UsualItem {
  productId: string;          // Kroger product id (UPC for cart writes)
  name: string;               // human-friendly description
  defaultQty: number;
  cadence: Cadence;
  lastOrdered?: string;       // ISO timestamp
  timesOrdered: number;
  notes?: string;
  // Email of the family member who added this item. Optional so that documents
  // written before the multi-member migration still load cleanly.
  addedBy?: string;
}

export interface UsualItemsDoc {
  items: UsualItem[];
  updatedAt: string;
}

export interface KrogerTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;          // epoch ms
  scope: string;
}

export interface ClientCredentialsToken {
  accessToken: string;
  expiresAt: number;
}
