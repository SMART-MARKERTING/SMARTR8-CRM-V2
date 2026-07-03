import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/** Bindings + secrets available to the Worker. See wrangler.toml + README. */
export interface Env {
  /** smartr8-leads D1 (shared with the Pages app; we only add tables). */
  LEADS_DB: D1Database;
  /** KV used by the OAuth provider for issued tokens / clients / grants. */
  OAUTH_KV: KVNamespace;
  /** Injected by @cloudflare/workers-oauth-provider for the auth flow. */
  OAUTH_PROVIDER: OAuthHelpers;

  /* Telnyx */
  TELNYX_API_KEY: string;
  TELNYX_FROM_NUMBER: string;
  TELNYX_MESSAGING_PROFILE_ID: string;

  /* BlueBubbles (iMessage bridge on the Mac, reached via Cloudflare tunnel). */
  BLUEBUBBLES_URL: string;
  BLUEBUBBLES_PASSWORD: string;

  /* The shared secret the user pastes into Claude's connector. Gates /authorize. */
  MCP_AUTH_SECRET: string;
  /* Optional shared secret that gates the inbound webhooks (?key=...). */
  WEBHOOK_SECRET?: string;

  /* Optional: the Render service's base URL + APP_PASSCODE. When BOTH are set, the
   * connector also exposes the crm_* tools that proxy the Render console API (leads,
   * pipeline, todos, contacts, messages, flows, click-to-call). Unset = those tools
   * are simply not registered. */
  RENDER_API_BASE?: string;
  RENDER_APP_PASSCODE?: string;
}
