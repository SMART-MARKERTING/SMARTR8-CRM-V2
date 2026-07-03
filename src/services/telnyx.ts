import { config } from "../config";

interface TelnyxSendResponse {
  data: { id: string; to: { status: string }[] };
}

/** Send an SMS via Telnyx. `to` must be E.164. Optional `from` overrides the default. */
export async function sendSms(
  to: string,
  text: string,
  from = config.telnyx.fromNumber,
): Promise<{ id: string; status: string }> {
  const res = await fetch(`${config.telnyx.apiBase}/v2/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.telnyx.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      from: from || config.telnyx.fromNumber,
      to,
      text,
      messaging_profile_id: config.telnyx.messagingProfileId,
    }),
  });
  if (!res.ok) throw new Error(`Telnyx send failed ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as TelnyxSendResponse;
  return { id: data.data.id, status: data.data.to?.[0]?.status ?? "queued" };
}

/**
 * Send an MMS via Telnyx. `mediaUrls` must be PUBLICLY reachable (Telnyx fetches them).
 * `text` is an optional caption. `to` must be E.164.
 */
export async function sendMms(
  to: string,
  mediaUrls: string[],
  text = "",
  from = config.telnyx.fromNumber,
): Promise<{ id: string; status: string }> {
  const res = await fetch(`${config.telnyx.apiBase}/v2/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.telnyx.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      from: from || config.telnyx.fromNumber,
      to,
      text: text || undefined,
      media_urls: mediaUrls,
      messaging_profile_id: config.telnyx.messagingProfileId,
    }),
  });
  if (!res.ok) throw new Error(`Telnyx MMS failed ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as TelnyxSendResponse;
  return { id: data.data.id, status: data.data.to?.[0]?.status ?? "queued" };
}

/** Fetch a sent message's current delivery status + any errors (GET /v2/messages/{id}).
 *  Lets us see whether a "queued" send actually delivered or was carrier-rejected (10DLC). */
export async function getMessageStatus(id: string): Promise<{
  status?: string;
  to?: Array<{ phone_number?: string; status?: string }>;
  errors?: unknown;
  from?: string;
  raw: unknown;
}> {
  const res = await fetch(`${config.telnyx.apiBase}/v2/messages/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${config.telnyx.apiKey}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Telnyx get message failed ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { data?: Record<string, any> };
  const d = body.data ?? {};
  return {
    status: d.to?.[0]?.status,
    to: d.to,
    errors: d.errors,
    from: typeof d.from === "object" ? d.from?.phone_number : d.from,
    raw: d,
  };
}

/** A phone number owned on the Telnyx account, with its current status. */
export interface OwnedTelnyxNumber {
  phone_number: string;
  status?: string;
}

/**
 * List ALL phone numbers on the Telnyx account (cursor through GET /v2/phone_numbers).
 * Used by GET /api/telnyx/numbers so the operator can copy the full list into the
 * TELNYX_NUMBERS env. Returns E.164 strings + status, newest API order.
 */
export async function listOwnedNumbers(max = 1000): Promise<OwnedTelnyxNumber[]> {
  const out: OwnedTelnyxNumber[] = [];
  const seen = new Set<string>();
  const pageSize = 250;
  for (let page = 1; out.length < max && page <= 50; page++) {
    const url = `${config.telnyx.apiBase}/v2/phone_numbers?page[size]=${pageSize}&page[number]=${page}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.telnyx.apiKey}`, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Telnyx list numbers failed ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as {
      data?: Array<{ phone_number?: string; status?: string }>;
      meta?: { total_pages?: number };
    };
    const batch = body.data ?? [];
    for (const n of batch) {
      if (!n.phone_number || seen.has(n.phone_number)) continue;
      seen.add(n.phone_number);
      out.push({ phone_number: n.phone_number, status: n.status });
    }
    const totalPages = body.meta?.total_pages ?? 1;
    if (batch.length < pageSize || page >= totalPages) break;
  }
  return out;
}
