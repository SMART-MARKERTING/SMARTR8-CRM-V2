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

export const webhooksRouter = Router();

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
  res.status(200).json({ received: true });
  const data = (req.body ?? {}).data;
  if (data?.event_type !== "message.received") return; // drop status/delivery events
  const from: string | undefined = data?.payload?.from?.phone_number;
  const text: string = data?.payload?.text ?? "";
  if (!from) return;
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
    logActivity(crmLead.id, { type: "sms", direction: "inbound", channel: "sms", body: text, status: "received" });
    log.info("logged inbound SMS", { from, leadId: crmLead.id, keyword: handled });
    // One-time iMessage capability probe (inbound SMS only; skip on a keyword reply).
    if (!handled) await runImessageProbe(contact);
  } catch (err) {
    log.error("telnyx inbound handler error", { err: String(err) });
  }
});

// Last few BlueBubbles webhook hits (raw), so GET /webhooks/bluebubbles/diag can
// confirm whether the Mac is actually POSTing inbound events to us, and their shape.
interface BbHit { at: string; type?: string; parsedFrom?: string; parsedText?: string; logged: boolean; reason?: string; raw: unknown }
const recentBbHits: BbHit[] = [];
function recordBb(h: BbHit): void {
  recentBbHits.unshift(h);
  if (recentBbHits.length > 10) recentBbHits.pop();
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
 * Records every hit (pre-filter) so /webhooks/bluebubbles/diag shows whether the
 * Mac is reaching us and the exact payload shape. Parses defensively.
 */
webhooksRouter.post("/bluebubbles", async (req, res) => {
  res.status(200).json({ received: true });
  const b = (req.body ?? {}) as Record<string, any>;
  log.info("bluebubbles webhook hit", { type: b.type, raw: b }); // full raw shape in logs
  const msg = b.data ?? b;

  // Non-message events (typing, read receipts, etc.) — record + skip.
  if (b.type && b.type !== "new-message") {
    recordBb({ at: new Date().toISOString(), type: b.type, logged: false, reason: "not a new-message event", raw: b });
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
      recordBb({ at: new Date().toISOString(), type: b.type, logged: false, reason: "isFromMe via CRM (already logged)", raw: b });
      return;
    }
    const to = extractChatId(msg);
    const outText: string = msg?.text ?? "";
    if (!to || !/^\+?[0-9()\-.\s]{7,}$/.test(to) || !outText) {
      recordBb({ at: new Date().toISOString(), type: b.type, parsedFrom: to, logged: false, reason: "isFromMe but no phone recipient or empty body — skipped", raw: b });
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
      recordBb({ at: new Date().toISOString(), type: b.type, parsedFrom: to, parsedText: outText, logged: true, reason: "isFromMe sent from device → logged outbound", raw: b });
      log.info("logged outbound iMessage sent from device", { to, leadId: crmLead.id });
    } catch (err) {
      recordBb({ at: new Date().toISOString(), type: b.type, parsedFrom: to, logged: false, reason: `error: ${String(err)}`, raw: b });
      log.error("bluebubbles isFromMe handler error", { err: String(err) });
    }
    return;
  }
  const from = extractFrom(msg);
  const text: string = msg?.text ?? "";
  if (!from) {
    recordBb({ at: new Date().toISOString(), type: b.type, logged: false, reason: "no sender address found in payload", raw: b });
    log.warn("bluebubbles inbound: could not find sender address", { raw: b });
    return;
  }
  // Skip non-phone senders (Apple Business Chat bots use urn:biz:... handles, emails, etc.)
  // GHL upsert requires a real phone number, so anything that isn't phone-like is ignored.
  const phoneLike = /^\+?[0-9()\-.\s]{7,}$/.test(from);
  if (!phoneLike) {
    recordBb({ at: new Date().toISOString(), type: b.type, parsedFrom: from, logged: false, reason: "sender is not a phone number (e.g. Apple Business Chat) — skipped", raw: b });
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
    logActivityOnce(crmLead.id, {
      type: "imessage",
      direction: "inbound",
      channel: "imessage",
      body: text,
      status: "received",
      meta: { messageGuid: extractMessageGuid(msg), chatGuid: extractChatGuid(msg) },
    });
    recordBb({ at: new Date().toISOString(), type: b.type, parsedFrom: from, parsedText: text, logged: true, raw: b });
    log.info("logged inbound iMessage", { from, leadId: crmLead.id });
  } catch (err) {
    recordBb({ at: new Date().toISOString(), type: b.type, parsedFrom: from, parsedText: text, logged: false, reason: `error: ${String(err)}`, raw: b });
    log.error("bluebubbles inbound handler error", { err: String(err) });
  }
});

/**
 * One-time setup: register our /webhooks/bluebubbles URL on the BlueBubbles server
 * so inbound iMessages POST to us. Passcode-gated (?pass= or x-app-passcode).
 * Either GET (clickable in a browser) or POST registers it; idempotent (skips if
 * already present). Returns a friendly HTML page for GET, JSON for POST.
 */
webhooksRouter.all("/bluebubbles/register", async (req, res) => {
  const wantsHtml = req.method === "GET";
  const page = (title: string, body: string) =>
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<body style="font-family:system-ui;max-width:34rem;margin:auto;padding:2rem;line-height:1.5">` +
    `<h2>${title}</h2>${body}</body>`;

  const provided = req.get("x-app-passcode") || (typeof req.query.pass === "string" ? req.query.pass : "");
  if (!config.app.passcode) {
    if (wantsHtml) return res.status(503).send(page("Not configured", "<p>APP_PASSCODE not set on the server.</p>"));
    return res.status(503).json({ error: "APP_PASSCODE not set on the server" });
  }
  if (provided !== config.app.passcode) {
    if (wantsHtml) return res.status(401).send(page("Locked", "<p>Add <code>?pass=YOUR_PASSCODE</code> to the URL.</p>"));
    return res.status(401).json({ error: "bad passcode" });
  }

  const base = publicBaseUrl();
  if (!base) {
    if (wantsHtml) return res.status(500).send(page("Error", "<p>Could not derive public URL from GHL_REDIRECT_URI.</p>"));
    return res.status(500).json({ error: "could not derive public URL from GHL_REDIRECT_URI" });
  }
  const hookUrl = `${base}/webhooks/bluebubbles`;
  try {
    const existing = await listWebhooks();
    const already = JSON.stringify(existing).includes(hookUrl);
    if (!already) {
      await registerWebhook(hookUrl);
      log.info("registered BlueBubbles webhook", { hookUrl });
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

/** Read-only: did BlueBubbles reach us, and what did the payload look like? */
webhooksRouter.get("/bluebubbles/diag", (_req, res) => {
  res.json({
    hits: recentBbHits.length,
    note: recentBbHits.length
      ? "If hits show but logged:false, see reason. If empty after sending an iMessage to the Mac, BlueBubbles isn't configured to POST to /webhooks/bluebubbles."
      : "No BlueBubbles webhooks received yet. Configure a webhook in BlueBubbles → Settings → API & Webhooks → add this URL with the 'new-message' event.",
    recent: recentBbHits,
  });
});
