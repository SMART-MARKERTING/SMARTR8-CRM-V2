import { createHash } from "node:crypto";
import { config } from "../config";
import { log } from "../logger";
import type { Lead } from "./leads";

/**
 * Meta Conversions API (server-side events).
 *
 * Fires a "Lead" event to Meta when a new website lead lands, so Meta can optimize ad
 * delivery toward people who actually become mortgage leads. This is the server-side
 * complement to the browser pixel on the funnel: the funnel page fires PageView in the
 * visitor's browser; our backend fires the Lead conversion, matched to the person by
 * hashed email/phone. They share one dataset (pixel) and the same event_id, so Meta
 * de-dups a browser-fired and a server-fired copy of the same event.
 *
 * Docs (verified): action_source "system_generated" for backend/CRM events or "website"
 * for funnel-origin leads; event_time is a Unix timestamp in SECONDS and must reflect the
 * actual lead-generation time; PII in user_data is normalized then SHA-256 hashed (hex),
 * while fbp/fbc/IP/user-agent are sent unhashed.
 *   https://developers.facebook.com/docs/marketing-api/conversions-api/
 */

export function capiConfigured(): boolean {
  return Boolean(config.meta.capiToken && config.meta.pixelId);
}

/** Optional request-derived signals that sharpen Meta's match quality. */
export interface CapiContext {
  /** _fbp cookie value (Meta browser id), if the funnel forwarded it. */
  fbp?: string;
  /** _fbc cookie value (click id), if the funnel forwarded it. */
  fbc?: string;
  /** Visitor IP (from the funnel / proxy), unhashed. */
  clientIp?: string;
  /** Visitor User-Agent, unhashed. */
  clientUserAgent?: string;
  /** The capture page URL (event_source_url); falls back to META_EVENT_SOURCE_URL. */
  eventSourceUrl?: string;
}

export interface CapiResult {
  /** true = Meta accepted the event; false = skipped or rejected (see reason). */
  sent: boolean;
  reason?: string;
  fbtrace_id?: string;
}

/** SHA-256 hex of a normalized string (Meta's required hashing for PII match keys). */
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Lowercase + trim, then hash. For email and names. */
function hashNormalized(value: string | null | undefined): string | undefined {
  const v = (value ?? "").trim().toLowerCase();
  return v ? sha256(v) : undefined;
}

/** Phone → digits only (keep country code, drop the leading +), then hash. */
function hashPhone(phone: string | null | undefined): string | undefined {
  const digits = (phone ?? "").replace(/[^0-9]/g, "");
  return digits ? sha256(digits) : undefined;
}

/** City → lowercase, strip spaces/punctuation, then hash. */
function hashCity(city: string | undefined): string | undefined {
  const v = (city ?? "").toLowerCase().replace(/[^a-z]/g, "");
  return v ? sha256(v) : undefined;
}

/** 2-letter state/country code → lowercase, then hash. */
function hashCode(code: string | undefined): string | undefined {
  const v = (code ?? "").trim().toLowerCase();
  return v ? sha256(v) : undefined;
}

/** ZIP → first 5 digits, then hash. */
function hashZip(zip: string | undefined): string | undefined {
  const v = (zip ?? "").replace(/[^0-9]/g, "").slice(0, 5);
  return v ? sha256(v) : undefined;
}

function customStr(lead: Lead, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = lead.custom?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * Send a server-side "Lead" event for a newly created lead. Best-effort and non-blocking:
 * never throws, and returns a structured result. A no-op (sent:false, reason:"not configured")
 * when META_CAPI_TOKEN is unset, so lead intake works with or without Meta wired up.
 */
export async function sendLeadEvent(lead: Lead, ctx: CapiContext = {}): Promise<CapiResult> {
  if (!capiConfigured()) return { sent: false, reason: "not configured" };

  const state = customStr(lead, ["state", "State", "STATE", "property_state", "propertyState"]);
  const city = customStr(lead, ["city", "City", "CITY"]);
  const zip = customStr(lead, ["zip", "zipcode", "postal_code", "postalCode"]);

  // user_data: hashed PII match keys + unhashed browser/click identifiers. Omit empty fields —
  // Meta rejects empty-string hashes and they only dilute match quality.
  const userData: Record<string, unknown> = {};
  const em = hashNormalized(lead.email);
  const ph = hashPhone(lead.phone);
  const fn = hashNormalized(lead.first_name);
  const ln = hashNormalized(lead.last_name);
  const ct = hashCity(city);
  const st = hashCode(state);
  const zp = hashZip(zip);
  if (em) userData.em = [em];
  if (ph) userData.ph = [ph];
  if (fn) userData.fn = [fn];
  if (ln) userData.ln = [ln];
  if (ct) userData.ct = [ct];
  if (st) userData.st = [st];
  if (zp) userData.zp = [zp];
  if (st) userData.country = [sha256("us")]; // US-only book of business
  if (ctx.fbp) userData.fbp = ctx.fbp;
  if (ctx.fbc) userData.fbc = ctx.fbc;
  if (ctx.clientIp) userData.client_ip_address = ctx.clientIp;
  if (ctx.clientUserAgent) userData.client_user_agent = ctx.clientUserAgent;

  // Need at least one match key or Meta can't attribute the event to a person.
  if (!em && !ph && !ctx.fbp && !ctx.fbc) {
    return { sent: false, reason: "no match key (email/phone/fbp/fbc)" };
  }

  const event: Record<string, unknown> = {
    event_name: "Lead",
    // Unix SECONDS, the real lead-generation time (Conversion Leads discards mismatched times).
    event_time: Math.floor((lead.created_at ?? Date.now()) / 1000),
    // Share the lead id with the browser pixel so Meta de-dups a double-fired Lead.
    event_id: lead.id,
    action_source: config.meta.actionSource,
    event_source_url: ctx.eventSourceUrl || config.meta.defaultEventSourceUrl,
    user_data: userData,
    custom_data: {
      lead_event_source: lead.source ?? "website",
      ...(lead.campaign ? { campaign: lead.campaign } : {}),
      ...(lead.category ? { lead_category: lead.category } : {}),
    },
  };

  const payload: Record<string, unknown> = { data: [event] };
  if (config.meta.testEventCode) payload.test_event_code = config.meta.testEventCode;

  const url = `https://graph.facebook.com/${config.meta.graphVersion}/${config.meta.pixelId}/events?access_token=${encodeURIComponent(
    config.meta.capiToken,
  )}`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = (await resp.json().catch(() => ({}))) as {
      events_received?: number;
      fbtrace_id?: string;
      error?: { message?: string; fbtrace_id?: string };
    };
    if (!resp.ok || json.error) {
      const reason = json.error?.message || `HTTP ${resp.status}`;
      log.warn("meta capi: Lead event rejected", { leadId: lead.id, reason, fbtrace_id: json.error?.fbtrace_id });
      return { sent: false, reason, fbtrace_id: json.error?.fbtrace_id };
    }
    log.info("meta capi: Lead event sent", { leadId: lead.id, events_received: json.events_received });
    return { sent: true, fbtrace_id: json.fbtrace_id };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn("meta capi: Lead event failed", { leadId: lead.id, reason });
    return { sent: false, reason };
  }
}
