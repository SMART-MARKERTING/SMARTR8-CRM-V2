import { config } from "../config";
import { GhlContact } from "./ghl";
import { isOnDnc } from "./dnc";

export type GateReason = "on-DNC" | "no-consent" | "outside-hours" | "unknown-timezone" | "no-phone";

export interface GateResult {
  allowed: boolean;
  reason?: GateReason;
}

/** Local hour (0-23) for an IANA timezone, or null if missing/invalid. */
function localHour(timezone?: string): number | null {
  if (!timezone) return null;
  try {
    const s = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    }).format(new Date());
    const h = parseInt(s, 10);
    return Number.isFinite(h) ? h % 24 : null;
  } catch {
    return null;
  }
}

/** TCPA calling-hours gate. Missing timezone -> skip (conservative). */
export function withinCallingHours(timezone?: string): GateResult {
  const h = localHour(timezone);
  if (h === null) return { allowed: false, reason: "unknown-timezone" };
  const { callHoursStart, callHoursEnd } = config.compliance;
  return h >= callHoursStart && h < callHoursEnd
    ? { allowed: true }
    : { allowed: false, reason: "outside-hours" };
}

/** All hard gates for an AUTOMATED outbound call. */
export async function checkAutomatedCall(contact: GhlContact): Promise<GateResult> {
  if (!contact.phone) return { allowed: false, reason: "no-phone" };
  if (await isOnDnc(contact.phone)) return { allowed: false, reason: "on-DNC" };
  const tags = contact.tags ?? [];
  if (!tags.includes(config.compliance.consentTag)) return { allowed: false, reason: "no-consent" };
  return withinCallingHours(contact.timezone);
}

/** Manual click-to-call: DNC only. Consent + hours are exempt (a human is dialing). */
export async function checkManualCall(phone: string): Promise<GateResult> {
  if (await isOnDnc(phone)) return { allowed: false, reason: "on-DNC" };
  return { allowed: true };
}
