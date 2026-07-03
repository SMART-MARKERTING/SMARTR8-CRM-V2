import { createHmac } from "crypto";
import { config } from "../config";
import { addLeadTag, getLead, updateLead, logActivity, Lead } from "./leads";

// Email unsubscribe (CAN-SPAM). Every drip email carries a one-click
// List-Unsubscribe header + a visible unsubscribe link, both pointing at
// GET/POST /unsubscribe?lead=<id>&t=<token>. The token is an HMAC of the lead
// id keyed on LEAD_WEBHOOK_SECRET so links can't be forged or enumerated.
//
// Unsubscribing tags the lead `email_unsubscribed`; the send_email automation
// step checks that tag and skips, so opt-outs are honored on the very next step
// (well inside the 10-day CAN-SPAM window). It does NOT touch SMS consent — SMS
// opt-out is a separate STOP flow.

const EMAIL_UNSUB_TAG = "email_unsubscribed";

/** Origin this service is reachable at, for building absolute links. */
export function publicBaseUrl(): string {
  if (config.crm.publicBaseUrl) return config.crm.publicBaseUrl.replace(/\/$/, "");
  try {
    return new URL(config.ghl.redirectUri).origin;
  } catch {
    return "";
  }
}

export function makeUnsubToken(leadId: string): string {
  const secret = config.crm.leadWebhookSecret || "unsub";
  return createHmac("sha256", secret).update(`unsub:${leadId}`).digest("hex").slice(0, 24);
}

export function verifyUnsubToken(leadId: string, token: string): boolean {
  if (!token) return false;
  const expected = makeUnsubToken(leadId);
  // Constant-time-ish compare (lengths are equal hex strings).
  if (token.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** Absolute unsubscribe URL for a lead, or "" if we don't know our own origin. */
export function unsubscribeUrl(leadId: string): string {
  const base = publicBaseUrl();
  if (!base) return "";
  return `${base}/unsubscribe?lead=${encodeURIComponent(leadId)}&t=${makeUnsubToken(leadId)}`;
}

export function isEmailUnsubscribed(lead: Lead): boolean {
  return lead.tags.includes(EMAIL_UNSUB_TAG);
}

/** Mark a lead unsubscribed from drip email. Idempotent. */
export function unsubscribeEmail(leadId: string): boolean {
  const lead = getLead(leadId);
  if (!lead) return false;
  if (!isEmailUnsubscribed(lead)) {
    addLeadTag(leadId, EMAIL_UNSUB_TAG);
    // Mark a custom flag too so it survives any tag housekeeping.
    updateLead(leadId, { custom: { ...lead.custom, email_unsubscribed_at: Date.now() } });
    logActivity(leadId, {
      type: "email",
      direction: "inbound",
      channel: "email",
      body: "Unsubscribed from marketing email",
      status: "unsubscribed",
    });
  }
  return true;
}
