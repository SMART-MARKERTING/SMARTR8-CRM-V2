import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env";
import { TextingMCP } from "./mcp";
import { handleDefault } from "./router";

/** The Durable Object class must be exported from the Worker entry. */
export { TextingMCP };

/** OAuthProvider gates /mcp; everything else (authorize UI, inbound webhooks,
 *  health) is served by the defaultHandler. The provider also serves the OAuth
 *  metadata + /token + /register (Dynamic Client Registration) endpoints that
 *  Claude's "Add custom connector" flow uses. */
export default new OAuthProvider({
  apiRoute: "/mcp",
  /* McpAgent.serve returns a Streamable-HTTP fetch handler backed by MCP_OBJECT. */
  apiHandler: TextingMCP.serve("/mcp", { binding: "MCP_OBJECT" }),
  defaultHandler: {
    fetch: (request: Request, env: unknown, ctx: ExecutionContext) =>
      handleDefault(request, env as Env, ctx),
  },
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
