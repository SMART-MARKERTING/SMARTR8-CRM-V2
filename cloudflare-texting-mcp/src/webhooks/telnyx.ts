import type { Env } from "../env";
import { parseInboundTelnyx } from "../services/telnyx";
import { recordInbound } from "../services/inbound";

/** POST /webhooks/telnyx — inbound SMS. Always 2xx fast (Telnyx needs <2s). */
export async function handleTelnyxWebhook(env: Env, body: unknown): Promise<Response> {
  const parsed = parseInboundTelnyx(body);
  if (!parsed) return Response.json({ ok: true, ignored: "not an inbound message" });
  const res = await recordInbound(env, { fromRaw: parsed.from, text: parsed.text, channel: "sms" });
  return Response.json({ ok: true, ...res });
}
