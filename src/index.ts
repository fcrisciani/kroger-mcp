import OAuthProvider from "@cloudflare/workers-oauth-provider";
import defaultHandler from "./auth.js";
import { KrogerMCP } from "./mcp.js";

export { KrogerMCP };

export default new OAuthProvider({
  // SSE for the legacy MCP transport, /mcp for the streamable-HTTP transport.
  // McpAgent.serveSSE / .serve return Worker-style fetch handlers.
  apiHandlers: {
    "/sse": KrogerMCP.serveSSE("/sse"),
    "/mcp": KrogerMCP.serve("/mcp"),
  },
  defaultHandler: defaultHandler as unknown as ExportedHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
