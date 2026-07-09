import { config } from "../config";
import { GhlContact } from "./ghl";
import { isOnDnc } from "./dnc";

export type GateReason =
  | "on-DNC"
  | "no-consent"
  | "no-sms-consent"
  | "outside-hours"
  | "unknown-timezone"
  | "no-phone";

export interface GateResult {
  allowed: boolean;
  reason?: GateReason;
}

export interface SmsConsentContact {
  phone?: string | null;
  sms_consent?: number | boolean | null;
  consent_at?: number | null;
}

export interface SmsEligibilityResult extends GateResult {
  channel: "sms";
  checked_at: number;
  consentRecordUsed?: "sms_consent+consent_at";
  dncResult?: "clear" | "blocked";
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

export function hasAffirmativeSmsConsent(contact: SmsConsentContact): boolean {
  const consentFlag = contact.sms_consent === true || contact.sms_consent === 1;
  return consentFlag && typeof contact.consent_at === "number" && contact.consent_at > 0;
}

/** Automated marketing SMS needs affirmative consent plus a timestamped audit record. */
export async function checkAutomatedSms(contact: SmsConsentContact): Promise<SmsEligibilityResult> {
  const checked_at = Date.now();
  if (!contact.phone) return { allowed: false, reason: "no-phone", channel: "sms", checked_at };
  if (await isOnDnc(contact.phone)) {
    return { allowed: false, reason: "on-DNC", channel: "sms", checked_at, dncResult: "blocked" };
  }
  if (!hasAffirmativeSmsConsent(contact)) {
    return { allowed: false, reason: "no-sms-consent", channel: "sms", checked_at, dncResult: "clear" };
  }
  return {
    allowed: true,
    channel: "sms",
    checked_at,
    consentRecordUsed: "sms_consent+consent_at",
    dncResult: "clear",
  };
}

/** Manual click-to-call: DNC only. Consent + hours are exempt (a human is dialing). */
export async function checkManualCall(phone: string): Promise<GateResult> {
  if (await isOnDnc(phone)) return { allowed: false, reason: "on-DNC" };
  return { allowed: true };
}
