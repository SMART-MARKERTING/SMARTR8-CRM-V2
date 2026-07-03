import type { Env } from "../env";
import { toE164 } from "../util/phone";
import { stateFromPhone } from "../util/areaCodeState";
import { checkBusinessHours } from "../util/tz";
import { sanitize, applyFooter, normalizeForDedupe } from "../util/hygiene";
import { sendOutbound } from "./outbound";
import {
  getLeadById,
  hasConsent,
  hasInboundThread,
  hasOutbound,
  isOptedOut,
  recentOutboundBodies,
  outboundCountSince,
  getOrCreateConversation,
  recordMessage,
  insertAudit,
} from "../db/repo";

/** Canonical outcomes from the task spec, extended with two precise hold/limit
 *  statuses (held_outside_hours, rate_limited) so we never mislabel a hold. */
export type SendStatus =
  | "sent_imessage"
  | "sent_sms"
  | "held_unknown_timezone"
  | "held_outside_hours"
  | "skipped_opted_out"
  | "needs_consent"
  | "deduped"
  | "rate_limited"
  | "blocked_hygiene"
  | "error";

export interface SendOutcome {
  status: SendStatus;
  reason: string;
  /** Echoes back useful context for the MCP tool's structured return. */
  contactId: string;
  phone?: string;
  channel?: "imessage" | "sms";
  providerId?: string;
}

const DEDUPE_HOURS = 12;
const DAILY_CAP = 10;

/** Run ALL compliance gates, then deliver. Logs every attempt (incl. holds) to
 *  send_audit. Never throws for a policy hold — only for genuinely broken input. */
export async function sendMessage(env: Env, contactId: string, rawBody: string): Promise<SendOutcome> {
  const lead = await getLeadById(env, contactId);
  if (!lead) {
    return { status: "error", reason: `No lead found for contactId "${contactId}".`, contactId };
  }
  const phone = toE164(lead.phone_e164);
  const audit = (status: SendStatus, reason: string, channel?: string, body?: string) =>
    insertAudit(env, { leadId: contactId, phone: phone || lead.phone_e164, channel: channel ?? null, body: body ?? rawBody, status, reason });

  if (!phone) {
    const reason = "Lead has no usable phone number (phone_e164 empty).";
    await audit("error", reason);
    return { status: "error", reason, contactId };
  }

  /* 1. Business hours — resolve tz from property_state, falling back to the phone's
        area code when state is blank (the funnels collect phone but not state).
        Unknown tz even after the fallback => do not send. */
  const rawState = (lead.property_state ?? "").trim();
  const effectiveState = rawState || stateFromPhone(phone);
  const stateSource = rawState ? "property_state" : effectiveState ? "phone area code" : "none";
  const hours = checkBusinessHours(effectiveState);
  if (!hours.ok && hours.reason === "unknown_timezone") {
    const reason = `Cannot resolve a timezone (property_state="${rawState}", area-code fallback from ${phone} also unresolved); not sending (held_unknown_timezone).`;
    await audit("held_unknown_timezone", reason);
    return { status: "held_unknown_timezone", reason, contactId, phone };
  }
  if (!hours.ok) {
    const reason = `Outside business hours: it is ${hours.localHour}:00 in ${hours.tz} (state via ${stateSource}); allowed window is ${hours.window.start}:00-${hours.window.end}:00 recipient-local.`;
    await audit("held_outside_hours", reason);
    return { status: "held_outside_hours", reason, contactId, phone };
  }

  /* 2. Opt-out — shared suppression list. */
  if (await isOptedOut(env, phone)) {
    const reason = `${phone} is on the shared opt_out list; not sending.`;
    await audit("skipped_opted_out", reason);
    return { status: "skipped_opted_out", reason, contactId, phone };
  }

  /* 3. Consent — first touch to a new lead needs a tcpa_consents row. Replies inside
        an existing inbound thread are exempt. */
  const inboundThread = await hasInboundThread(env, contactId);
  if (!inboundThread) {
    const consented = await hasConsent(env, contactId);
    if (!consented) {
      const reason = "First outbound to this lead but no tcpa_consents row exists and they have not texted in; holding for consent (needs_consent).";
      await audit("needs_consent", reason);
      return { status: "needs_consent", reason, contactId, phone };
    }
  }

  /* 4. Hygiene — strip em/en dashes, smart quotes, emoji; force GSM-7. */
  const hy = sanitize(rawBody);
  if (hy.empty) {
    const reason = "Message body is empty after hygiene (only emoji/non-GSM characters?).";
    await audit("blocked_hygiene", reason, undefined, rawBody);
    return { status: "blocked_hygiene", reason, contactId, phone };
  }
  const lengthFlag = hy.tooLong ? ` [flagged: core message is ${hy.length} chars (>160, multi-segment)]` : "";

  /* 5. Footer — NMLS line always; STOP language on the first message to a contact. */
  const firstMessage = !(await hasOutbound(env, contactId));
  const finalBody = applyFooter(hy.core, { firstMessage });

  /* 6. Dedupe (12h near-identical) + daily rate-limit. */
  const since12h = Date.now() - DEDUPE_HOURS * 3600_000;
  const recent = await recentOutboundBodies(env, contactId, since12h);
  const norm = normalizeForDedupe(finalBody);
  if (norm && recent.some((b) => normalizeForDedupe(b) === norm)) {
    const reason = `Near-identical message already sent to this contact within ${DEDUPE_HOURS}h; suppressed (deduped).`;
    await audit("deduped", reason, undefined, finalBody);
    return { status: "deduped", reason, contactId, phone };
  }
  const since24h = Date.now() - 24 * 3600_000;
  const sentToday = await outboundCountSince(env, contactId, since24h);
  if (sentToday >= DAILY_CAP) {
    const reason = `Daily cap reached (${sentToday}/${DAILY_CAP} outbound in 24h); suppressed (rate_limited).`;
    await audit("rate_limited", reason, undefined, finalBody);
    return { status: "rate_limited", reason, contactId, phone };
  }

  /* 7. Deliver (iMessage-first, SMS fallback) + persist the message + audit. */
  const conversationId = await getOrCreateConversation(env, { leadId: contactId, phone });
  const delivery = await sendOutbound(env, { leadId: contactId, phone, message: finalBody });

  await recordMessage(env, {
    conversation_id: conversationId,
    lead_id: contactId,
    phone_e164: phone,
    direction: "out",
    channel: delivery.channel,
    body: finalBody,
    status: delivery.ok ? "sent" : "failed",
    provider_id: delivery.providerId ?? null,
    temp_guid: delivery.tempGuid ?? null,
    error: delivery.ok ? null : delivery.detail,
    created_at: Date.now(),
  });

  if (!delivery.ok) {
    const reason = `Delivery failed on all channels: ${delivery.detail}`;
    await audit("error", reason, delivery.channel, finalBody);
    return { status: "error", reason, contactId, phone, channel: delivery.channel };
  }

  const status: SendStatus = delivery.channel === "imessage" ? "sent_imessage" : "sent_sms";
  const reason = `${delivery.detail}${lengthFlag}`;
  await audit(status, reason, delivery.channel, finalBody);
  return { status, reason, contactId, phone, channel: delivery.channel, providerId: delivery.providerId };
}
