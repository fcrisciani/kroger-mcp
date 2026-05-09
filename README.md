# kroger-mcp

Shared-household MCP server for the [Kroger Public API](https://developer.kroger.com/api-products),
deployed as a Cloudflare Worker. Family members each connect Claude; items
land in one shared kroger.com cart, drawn from one shared Kroger account.
Family identity is handled by Cloudflare Access; you finish checkout in the
browser.

See [`CLAUDE.md`](./CLAUDE.md) for setup, architecture, and the full tool list.
