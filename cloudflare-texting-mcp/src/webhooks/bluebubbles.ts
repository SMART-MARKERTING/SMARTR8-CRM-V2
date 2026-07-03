import type { Env } from "../env";
import { recordInbound } from "../services/inbound";

/** POST /webhooks/bluebubbles — inbound iMessage (BlueBubbles "new-message" event).
 *  Verified payload: { type: "new-message", data: { text, isFromMe, handle: { address }, chats: [...] } }.
 *  We only record messages FROM the contact (isFromMe === false). */
export async function handleBlueBubblesWebhook(env: Env, body: unknown): Promise<Response> {
  const b = body as { type?: string; data?: any };
  const data = b?.data;
  if (!data) return Response.json({ ok: true, ignored: "no data" });
  if (data.isFromMe === true) return Response.json({ ok: true, ignored: "outbound echo" });

  const from = data.handle?.address ?? data.address ?? data.chats?.[0]?.chatIdentifier;
  const text = data.text ?? "";
  if (!from) return Response.json({ ok: true, ignored: "no sender handle" });

  const res = await recordInbound(env, { fromRaw: String(from), text: String(text), channel: "imessage" });
  return Response.json({ ok: true, ...res });
}
