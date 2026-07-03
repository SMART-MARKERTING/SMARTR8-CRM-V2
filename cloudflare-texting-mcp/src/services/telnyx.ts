import type { Env } from "../env";

interface TelnyxSendResponse {
  data: { id: string; to: { status: string }[] };
}

/** Send an SMS via Telnyx v2. `to` must be E.164. Throws on non-2xx. */
export async function sendSms(
  env: Env,
  to: string,
  text: string,
): Promise<{ id: string; status: string }> {
  const res = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.TELNYX_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      from: env.TELNYX_FROM_NUMBER,
      to,
      text,
      messaging_profile_id: env.TELNYX_MESSAGING_PROFILE_ID,
    }),
  });
  if (!res.ok) throw new Error(`Telnyx send failed ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as TelnyxSendResponse;
  return { id: data.data.id, status: data.data.to?.[0]?.status ?? "queued" };
}

/** Parse an inbound Telnyx webhook into { from, text } or null if not an inbound message.
 *  Shape (verified): data.event_type === "message.received",
 *  data.payload.from.phone_number, data.payload.text. */
export function parseInboundTelnyx(body: unknown): { from: string; text: string } | null {
  const data = (body as { data?: any })?.data;
  if (!data) return null;
  if (data.event_type && data.event_type !== "message.received") return null;
  const from = data.payload?.from?.phone_number;
  const text = data.payload?.text ?? "";
  if (!from) return null;
  return { from: String(from), text: String(text) };
}
