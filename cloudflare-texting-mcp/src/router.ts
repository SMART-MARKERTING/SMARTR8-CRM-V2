import type { Env } from "./env";
import { handleTelnyxWebhook } from "./webhooks/telnyx";
import { handleBlueBubblesWebhook } from "./webhooks/bluebubbles";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/** Timing-safe-ish string compare. */
function secretMatches(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Optional shared-secret gate for inbound webhooks (?key=...). If WEBHOOK_SECRET is
 *  unset the webhooks are open (they still only WRITE inbound rows). */
function webhookAuthorized(env: Env, url: URL): boolean {
  if (!env.WEBHOOK_SECRET) return true;
  return secretMatches(url.searchParams.get("key") ?? "", env.WEBHOOK_SECRET);
}

const AUTHORIZE_FORM = (action: string, error?: string) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Smartr8 Texting MCP — Authorize</title>
<style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#1e293b;padding:32px;border-radius:12px;max-width:380px;width:90%;box-shadow:0 10px 40px rgba(0,0,0,.4)}
h1{font-size:18px;margin:0 0 4px}p{color:#94a3b8;font-size:14px;margin:0 0 20px}
input{width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;font-size:15px}
button{width:100%;margin-top:16px;padding:12px;border:0;border-radius:8px;background:#E31B23;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
.err{color:#fca5a5;font-size:13px;margin:10px 0 0}</style></head>
<body><form class="card" method="POST" action="${escapeHtml(action)}">
<h1>Smartr8 Texting MCP</h1><p>Enter the access secret to connect this Claude connector.</p>
<input type="password" name="secret" placeholder="MCP access secret" autocomplete="off" autofocus required>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<button type="submit">Authorize</button></form></body></html>`;

/** The OAuthProvider defaultHandler: serves the authorize UI, the inbound webhooks,
 *  health, and a root info page. Everything here is OUTSIDE the OAuth-gated /mcp route. */
export async function handleDefault(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;

  /* ── OAuth authorize ──────────────────────────────────────────────────── */
  if (pathname === "/authorize") {
    const action = `/authorize?${url.search.slice(1)}`;
    if (request.method === "GET") {
      return new Response(AUTHORIZE_FORM(action), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (request.method === "POST") {
      const form = await request.formData();
      const secret = String(form.get("secret") ?? "");
      if (!secretMatches(secret, env.MCP_AUTH_SECRET)) {
        return new Response(AUTHORIZE_FORM(action, "Incorrect secret. Try again."), {
          status: 401,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: oauthReqInfo,
        userId: "smartr8-owner",
        metadata: { label: "Smartr8 Texting MCP" },
        scope: oauthReqInfo.scope ?? [],
        props: { owner: true },
      });
      return Response.redirect(redirectTo, 302);
    }
    return new Response("Method not allowed", { status: 405 });
  }

  /* ── Inbound webhooks ─────────────────────────────────────────────────── */
  if (pathname === "/webhooks/telnyx" && request.method === "POST") {
    if (!webhookAuthorized(env, url)) return new Response("forbidden", { status: 403 });
    const body = await request.json().catch(() => ({}));
    try {
      return await handleTelnyxWebhook(env, body);
    } catch (err) {
      /* Always 2xx so Telnyx does not retry-storm; the error is logged. */
      console.error("telnyx webhook error", err);
      return Response.json({ ok: false, error: String(err) });
    }
  }

  if (pathname === "/webhooks/bluebubbles" && request.method === "POST") {
    if (!webhookAuthorized(env, url)) return new Response("forbidden", { status: 403 });
    const body = await request.json().catch(() => ({}));
    try {
      return await handleBlueBubblesWebhook(env, body);
    } catch (err) {
      console.error("bluebubbles webhook error", err);
      return Response.json({ ok: false, error: String(err) });
    }
  }

  /* ── Health + root ────────────────────────────────────────────────────── */
  if (pathname === "/health") {
    return Response.json({ ok: true, service: "smartr8-texting-mcp", ts: Date.now() });
  }
  if (pathname === "/") {
    return new Response(
      "Smartr8 Texting + MCP worker. MCP endpoint: /mcp (OAuth-protected). Webhooks: /webhooks/telnyx, /webhooks/bluebubbles.",
      { headers: { "content-type": "text/plain" } },
    );
  }

  return new Response("Not found", { status: 404 });
}
