import { config } from "../config";
import { toE164 } from "../util/phone";
import { log } from "../logger";

export interface NumberLookup {
  phone: string;
  carrierName?: string;
  lineType?: string; // "mobile" | "landline" | "voip" | ...
  callerName?: string; // CNAM
  raw?: unknown;
}

/**
 * Telnyx Number Lookup: carrier + line type + caller name (CNAM).
 * Line type is handy here — SMS to a landline won't deliver, and it flags VoIP.
 * Best-effort: returns what it can, never throws on a bad lookup (logs raw).
 */
export async function lookupNumber(phoneRaw: string): Promise<NumberLookup> {
  const phone = toE164(phoneRaw);
  const url =
    `${config.telnyx.apiBase}/v2/number_lookup/${encodeURIComponent(phone)}` +
    `?type=carrier&type=caller-name`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${config.telnyx.apiKey}`,
      Accept: "application/json",
    },
  });
  const raw = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`Telnyx number_lookup failed ${res.status}: ${raw}`);
  const data = (raw ? JSON.parse(raw) : {}) as { data?: any };
  const d = data.data ?? {};
  log.info("number lookup", { phone, carrier: d?.carrier?.name, lineType: d?.carrier?.type });
  return {
    phone,
    carrierName: d?.carrier?.name,
    lineType: d?.carrier?.type, // mobile / landline / voip
    callerName: d?.caller_name?.caller_name,
    raw: d,
  };
}
