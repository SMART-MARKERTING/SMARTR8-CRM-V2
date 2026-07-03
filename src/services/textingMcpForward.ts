import { config } from "../config";
import { log } from "../logger";

/**
 * Best-effort, fire-and-forget relay of an inbound webhook body to the net-new
 * Cloudflare texting + MCP Worker (the Cowork connector), so its conversation
 * threads stay in sync with this service WITHOUT repointing Telnyx/BlueBubbles
 * away from Render.
 *
 * It intentionally never blocks or throws into the caller — the Telnyx/BlueBubbles
 * inbound handlers must still return 2xx fast and their existing GHL/CRM logic must
 * be unaffected whether or not the Worker is reachable. Unset URL = no-op.
 */
export function forwardInbound(kind: "telnyx" | "bluebubbles", body: unknown): void {
  const url = kind === "telnyx" ? config.textingMcp.telnyxUrl : config.textingMcp.bluebubblesUrl;
  if (!url) return;
  void (async () => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      if (!res.ok) log.warn("texting-mcp forward: non-2xx", { kind, status: res.status });
    } catch (err) {
      log.warn("texting-mcp forward failed", { kind, err: String(err) });
    }
  })();
}
