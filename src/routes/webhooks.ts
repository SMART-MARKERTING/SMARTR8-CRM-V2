import { Router } from "express";
import { config } from "../config";
import { upsertContact, logMessage } from "../services/ghl";
import { runImessageProbe } from "../services/probe";
import { listWebhooks, registerWebhook } from "../services/bluebubbles";
import { handleInboundKeyword } from "../services/optout";
import { handleLeadReply } from "../services/automations";
import { findLead, createLead, logActivity, logActivityOnce } from "../services/leads";
import { forwardInbound } from "../services/textingMcpForward";
import { log } from "../logger";
import { requireAdmin, requireVerifiedAdmin, rejectClientSuppliedIdentity } from "../util/auth";
import { createHash, timingSafeEqual } from "crypto";
import { verifyTelnyxWebhookSignature } from "../services/callSummary";
import { createNotificationEvent } from "../services/notifications";
import { db } from "../store/db";
import { recordAudit } from "../services/audit";

export const webhooksRouter = Router();

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function telnyxSmsAccepted(req: Parameters<typeof verifyTelnyxWebhookSignature>[0]): boolean {
  if (config.telnyx.publicKey) return verifyTelnyxWebhookSignature(req);
  if (config.webhooks.enforceTelnyxSms) return false;
  log.warn("Telnyx SMS webhook verification is in rollout mode; set TELNYX_PUBLIC_KEY then WEBHOOK_ENFORCE_TELNYX_SMS=true");
  return true;
}

function blueBubblesAccepted(req: Parameters<typeof verifyTelnyxWebhookSignature>[0]): boolean {
  const configured = config.bluebubbles.webhookSecret;
  if (!configured) {
    if (config.webhooks.enforceBlueBubbles) return false;
    log.warn("BlueBubbles webhook verification is in rollout mode; set BLUEBUBBLES_WEBHOOK_SECRET then WEBHOOK_ENFORCE_BLUEBUBBLES=true");
    return true;
  }
  const authorization = req.get("authorization") || "";
  const querySecret = typeof req.query.key === "string" ? req.query.key : "";
  const provided = req.get("x-bluebubbles-secret") || (authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "") || querySecret;
  return Boolean(provided && equalSecret(provided, configured));
}

/** Our public base URL, derived from the OAuth redirect URI's origin. */
function publicBaseUrl(): string | null {
  try {
    return new URL(config.ghl.redirectUri).origin;
  } catch {
    return null;
  }
}

/**
 * Telnyx inbound SMS -> upsert contact -> log inbound -> one-time iMessage probe.
 * The probe fires ONLY here (a new SMS into the Telnyx number), never on outbound
 * sends or on inbound iMessage.
 */
webhooksRouter.post("/telnyx", async (req, res) => {
  if (!telnyxSmsAccepted(req)) {
    res.status(401).json({ error: "invalid Telnyx webhook signature" });
    return;
  }
  const data = (req.body ?? {}).data;
  if (data?.event_type !== "message.received") {
    res.status(200).json({ received: true, ignored: true });
    return;
  }
  const providerEventId = typeof data?.id === "string" ? data.id : typeof data?.payload?.id === "string" ? data.payload.id : "";
  if (providerEventId) {
    const duplicate = db.prepare(
      `SELECT 1 FROM notification_events WHERE provider = 'telnyx' AND provider_event_id = ? LIMIT 1`,
    ).get(providerEventId);
    if (duplicate) {
      res.status(200).json({ received: true, duplicate: true });
      return;
    }
  }
  const from: string | undefined = data?.payload?.from?.phone_number;
  const text: string = data?.payload?.text ?? "";
  if (!from) {
    res.status(400).json({ error: "message.received is missing sender" });
    return;
  }
  // Relay a copy to the Cloudflare texting+MCP Worker (best-effort; never blocks).
  forwardInbound("telnyx", req.body);
  try {
    // STOP / HELP / START first: honors opt-out immediately + sends one confirmation.
    const handled = await handleInboundKeyword(from, text);
    // A real reply (not a keyword): advance the lead to Replied + pause its drip.
    if (!handled) handleLeadReply(from);
    const contact = await upsertContact(from);
    await logMessage({ contactId: contact.id, message: text, direction: "inbound" });
    // Thread the inbound text onto the CRM lead's timeline (GHL is retired; local is the
    // system of record). Find-or-create the lead so inbound from a new number shows up in Messages.
    const crmLead = findLead({ phone: from }) ?? createLead({ phone: from, source: "inbound-sms" });
    const activity = logActivity(crmLead.id, { type: "sms", direction: "inbound", channel: "sms", body: text, status: "received" });
    createNotificationEvent({
      kind: "incoming_message",
      provider: "telnyx",
      providerEventId: providerEventId || null,
      sourceType: "activity",
      sourceRecordId: activity.id,
      leadId: crmLead.id,
      deepLink: `/v2/?page=messages&lead=${encodeURIComponent(crmLead.id)}`,
      contactFirstName: crmLead.first_name,
    });
    log.info("logged inbound SMS", { from, leadId: crmLead.id, keyword: handled });
    // One-time iMessage capability probe (inbound SMS only; skip on a keyword reply).
    if (!handled) await runImessageProbe(contact);
    res.status(200).json({ received: true, activityId: activity.id });
  } catch (err) {
    log.error("telnyx inbound handler error", { err: String(err) });
    res.status(500).json({ error: "inbound SMS could not be persisted" });
  }
});

// Last few BlueBubbles webhook hits (raw), so GET /webhooks/bluebubbles/diag can
// confirm whether the Mac is actually POSTing inbound events to us, and their shape.
interface BbHit {
  at: string;
  type?: string;
  hasSender?: boolean;
  hasText?: boolean;
  eventFingerprint?: string;
  logged: boolean;
  reason?: string;
}
const recentBbHits: BbHit[] = [];
function recordBb(h: BbHit): void {
  recentBbHits.unshift(h);
  if (recentBbHits.length > 10) recentBbHits.pop();
}

function bbFingerprint(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized ? createHash("sha256").update(normalized).digest("hex").slice(0, 12) : undefined;
}

/** Pull the sender address out of the various BlueBubbles new-message shapes. */
function extractFrom(msg: any): string | undefined {
  return (
    msg?.handle?.address ??
    msg?.address ??
    msg?.chats?.[0]?.chatIdentifier ??
    msg?.chat?.chatIdentifier ??
    (typeof msg?.handle === "string" ? msg.handle : undefined)
  );
}

/** The conversation's OTHER party (recipient) — used for messages you sent (isFromMe). For a
 *  1:1 chat the chat identifier is the recipient's number; fall back to the handle. */
function extractChatId(msg: any): string | undefined {
  return (
    msg?.chats?.[0]?.chatIdentifier ??
    msg?.chat?.chatIdentifier ??
    msg?.handle?.address ??
    msg?.address ??
    (typeof msg?.handle === "string" ? msg.handle : undefined)
  );
}

function extractMessageGuid(msg: any): string | undefined {
  return msg?.guid ?? msg?.messageGuid ?? msg?.item?.guid ?? msg?.data?.guid ?? undefined;
}

function extractChatGuid(msg: any): string | undefined {
  return msg?.chatGuid ?? msg?.chat?.guid ?? msg?.chats?.[0]?.guid ?? msg?.chat?.chatGuid ?? undefined;
}

/**
 * BlueBubbles inbound iMessage ("New Messages") -> upsert -> log. No probe here.
 * Records redacted metadata for diagnostics; raw payloads and message content
 * never enter the diagnostics buffer.
 */
webhooksRouter.post("/bluebubbles", async (req, res) => {
  if (!blueBubblesAccepted(req)) {
    res.status(401).json({ error: "invalid BlueBubbles webhook secret" });
    return;
  }
  const b = (req.body ?? {}) as Record<string, any>;
  log.info("bluebubbles webhook hit", { type: b.type, hasData: Boolean(b.data) });
  const msg = b.data ?? b;

  // Non-message events (typing, read receipts, etc.) — record + skip.
  if (b.type && b.type !== "new-message") {
    recordBb({ at: new Date().toISOString(), type: b.type, logged: false, reason: "not a new-message event" });
    res.status(200).json({ received: true, ignored: true });
    return;
  }
  if (msg?.isFromMe) {
    // A message YOU sent. Two cases:
    //  1. Sent THROUGH the CRM — BlueBubbles echoes our tempGuid ("smartr8-…"); it's already
    //     logged at send time, so skip to avoid a duplicate.
    //  2. Sent natively from your iPhone/Mac — no smartr8 tempGuid. Log it as an OUTBOUND
    //     iMessage on the matching lead so the conversation shows in the CRM thread.
    const tempGuid = String(msg?.tempGuid ?? "");
    if (tempGuid.indexOf("smartr8-") === 0) {
      recordBb({ at: new Date().toISOString(), type: b.type, logged: false, reason: "isFromMe via CRM (already logged)", eventFingerprint: bbFingerprint(extractMessageGuid(msg)) });
      res.status(200).json({ received: true, ignored: true });
      return;
    }
    const to = extractChatId(msg);
    const outText: string = msg?.text ?? "";
    if (!to || !/^\+?[0-9()\-.\s]{7,}$/.test(to) || !outText) {
      res.status(200).json({ received: true, ignored: true });
      recordBb({ at: new Date().toISOString(), type: b.type, hasSender: Boolean(to), hasText: Boolean(outText), logged: false, reason: "isFromMe but no phone recipient or empty body — skipped", eventFingerprint: bbFingerprint(extractMessageGuid(msg)) });
      return;
    }
    forwardInbound("bluebubbles", req.body); // keep the Worker thread in sync
    try {
      const crmLead = findLead({ phone: to }) ?? createLead({ phone: to, source: "imessage" });
      logActivityOnce(crmLead.id, {
        type: "imessage",
        direction: "outbound",
        channel: "imessage",
        body: outText,
        status: "sent",
        meta: { via: "device", messageGuid: extractMessageGuid(msg), chatGuid: extractChatGuid(msg) },
      });
      recordBb({ at: new Date().toISOString(), type: b.type, hasSender: true, hasText: true, logged: true, reason: "isFromMe sent from device → logged outbound", eventFingerprint: bbFingerprint(extractMessageGuid(msg)) });
      log.info("logged outbound iMessage sent from device", { leadId: crmLead.id });
      res.status(200).json({ received: true });
    } catch (err) {
      recordBb({ at: new Date().toISOString(), type: b.type, hasSender: true, hasText: Boolean(outText), logged: false, reason: `error: ${String(err)}`, eventFingerprint: bbFingerprint(extractMessageGuid(msg)) });
      log.error("bluebubbles isFromMe handler error", { err: String(err) });
      res.status(500).json({ error: "outbound device message could not be persisted" });
    }
    return;
  }
  const from = extractFrom(msg);
  const text: string = msg?.text ?? "";
  if (!from) {
    recordBb({ at: new Date().toISOString(), type: b.type, hasSender: false, hasText: Boolean(text), logged: false, reason: "no sender address found in payload", eventFingerprint: bbFingerprint(extractMessageGuid(msg)) });
    log.warn("bluebubbles inbound: could not find sender address", { type: b.type, eventFingerprint: bbFingerprint(extractMessageGuid(msg)) });
    res.status(400).json({ error: "message sender is missing" });
    return;
  }
  // Skip non-phone senders (Apple Business Chat bots use urn:biz:... handles, emails, etc.)
  // GHL upsert requires a real phone number, so anything that isn't phone-like is ignored.
  const phoneLike = /^\+?[0-9()\-.\s]{7,}$/.test(from);
  if (!phoneLike) {
    res.status(200).json({ received: true, ignored: true });
    recordBb({ at: new Date().toISOString(), type: b.type, hasSender: true, hasText: Boolean(text), logged: false, reason: "sender is not a phone number (e.g. Apple Business Chat) — skipped", eventFingerprint: bbFingerprint(extractMessageGuid(msg)) });
    return;
  }
  // Relay a copy to the Cloudflare texting+MCP Worker (best-effort; never blocks).
  forwardInbound("bluebubbles", req.body);
  try {
    // STOP/HELP keyword + reply-driven stage advance (parity with the SMS path).
    const handled = await handleInboundKeyword(from, text);
    if (!handled) handleLeadReply(from);
    const contact = await upsertContact(from);
    await logMessage({ contactId: contact.id, message: text, direction: "inbound" });
    // Thread the inbound iMessage onto the CRM lead's timeline (GHL is retired; local is the
    // system of record). Find-or-create the lead so inbound from a new number shows up in Messages.
    const crmLead = findLead({ phone: from }) ?? createLead({ phone: from, source: "inbound-imessage" });
    const activity = logActivityOnce(crmLead.id, {
      type: "imessage",
      direction: "inbound",
      channel: "imessage",
      body: text,
      status: "received",
      meta: { messageGuid: extractMessageGuid(msg), chatGuid: extractChatGuid(msg) },
    });
    if (activity) {
      createNotificationEvent({
        kind: "incoming_message",
        provider: "bluebubbles",
        providerEventId: extractMessageGuid(msg) || activity.id,
        sourceType: "activity",
        sourceRecordId: activity.id,
        leadId: crmLead.id,
        deepLink: `/v2/?page=messages&lead=${encodeURIComponent(crmLead.id)}`,
        contactFirstName: crmLead.first_name,
      });
    }
    recordBb({ at: new Date().toISOString(), type: b.type, hasSender: true, hasText: Boolean(text), logged: true, eventFingerprint: bbFingerprint(extractMessageGuid(msg)) });
    log.info("logged inbound iMessage", { leadId: crmLead.id });
    res.status(200).json({ received: true, activityId: activity?.id || null, duplicate: !activity });
  } catch (err) {
    recordBb({ at: new Date().toISOString(), type: b.type, hasSender: true, hasText: Boolean(text), logged: false, reason: `error: ${String(err)}`, eventFingerprint: bbFingerprint(extractMessageGuid(msg)) });
    log.error("bluebubbles inbound handler error", { err: String(err) });
    res.status(500).json({ error: "inbound iMessage could not be persisted" });
  }
});

/**
 * One-time setup: register our /webhooks/bluebubbles URL on the BlueBubbles server
 * so inbound iMessages POST to us. Passcode-gated (?pass= or x-app-passcode).
 * Either GET (clickable in a browser) or POST registers it; idempotent (skips if
 * already present). Returns a friendly HTML page for GET, JSON for POST.
 */
webhooksRouter.all("/bluebubbles/register", requireVerifiedAdmin, rejectClientSuppliedIdentity, async (req, res) => {
  const wantsHtml = req.method === "GET";
  const page = (title: string, body: string) =>
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<body style="font-family:system-ui;max-width:34rem;margin:auto;padding:2rem;line-height:1.5">` +
    `<h2>${title}</h2>${body}</body>`;

  const base = publicBaseUrl();
  if (!base) {
    if (wantsHtml) return res.status(500).send(page("Error", "<p>Could not derive public URL from GHL_REDIRECT_URI.</p>"));
    return res.status(500).json({ error: "could not derive public URL from GHL_REDIRECT_URI" });
  }
  const hookUrl = `${base}/webhooks/bluebubbles`;
  const registeredHookUrl = config.bluebubbles.webhookSecret
    ? `${hookUrl}?key=${encodeURIComponent(config.bluebubbles.webhookSecret)}`
    : hookUrl;
  try {
    const existing = await listWebhooks();
    const already = JSON.stringify(existing).includes(registeredHookUrl);
    if (!already) {
      await registerWebhook(registeredHookUrl);
      log.info("registered BlueBubbles webhook", { hookUrl });
      recordAudit({ req, action: "provider.bluebubbles_webhook.register", statusCode: 200 });
    }
    if (wantsHtml) {
      return res.send(
        page(
          already ? "✅ Already set up" : "✅ Inbound iMessage logging enabled",
          `<p>BlueBubbles will now POST new iMessages to this service, which logs them to GHL.</p>` +
            `<p><b>Test it:</b> text the Mac's iMessage from another phone, then open ` +
            `<a href="/webhooks/bluebubbles/diag">/webhooks/bluebubbles/diag</a> — you should see a hit with <code>logged: true</code>.</p>`,
        ),
      );
    }
    res.json({ ok: true, alreadyRegistered: already, registered: hookUrl });
  } catch (err) {
    log.error("bluebubbles register error", { err: String(err) });
    const hint = "check BLUEBUBBLES_URL/PASSWORD and that the Mac/tunnel is reachable";
    if (wantsHtml) return res.status(502).send(page("Couldn't reach BlueBubbles", `<p>${String(err)}</p><p>${hint}</p>`));
    res.status(502).json({ error: String(err), hint });
  }
});

/** Admin-only, redacted diagnostics: no message bodies, phone numbers, or raw payloads. */
webhooksRouter.get("/bluebubbles/diag", requireAdmin, (_req, res) => {
  res.json({
    hits: recentBbHits.length,
    note: recentBbHits.length
      ? "If hits show but logged:false, see reason. If empty after sending an iMessage to the Mac, BlueBubbles isn't configured to POST to /webhooks/bluebubbles."
      : "No BlueBubbles webhooks received yet. Configure a webhook in BlueBubbles → Settings → API & Webhooks → add this URL with the 'new-message' event.",
    recent: recentBbHits,
  });
});
