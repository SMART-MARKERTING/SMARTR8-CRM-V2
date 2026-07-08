import { Router, raw, Request } from "express";
import path from "path";
import fs from "fs";
import { randomUUID, createHash } from "crypto";
import { hideMessage, hiddenMessageSigs, hideConversation, unhideConversation, hiddenConversationIds, hideContacts, hiddenContactPhones } from "../store/db";
import { config } from "../config";
import { log } from "../logger";
import { checkPass, requirePass } from "../util/auth";
import { mintWebrtcToken } from "../services/telnyxWebrtc";
import { sendOutbound, getMessagingMode, setMessagingMode, MessagingMode } from "../services/router";
import { lookupNumber } from "../services/telnyxLookup";
import { listNumbers, defaultFrom, pickFromNumber, toOwnedNumber } from "../services/numbers";
import { listOwnedNumbers, sendSms, getMessageStatus } from "../services/telnyx";
import { isForwardingEnabled, setForwarding, withinForwardWindow } from "../services/inboundRouter";
import { mimeForExt, mediaPathFor, publicMediaUrl, supportedMediaExt, writeMediaFile } from "../services/media";
// GHL is disconnected: the Messages tab + contacts search now read the local SQLite CRM.
// listAllContacts is the only GHL call left (for the one-time "Import from GHL" migration).
import { listAllContacts } from "../services/ghl";
import {
  findLead,
  createLead,
  getLead,
  updateLead,
  logActivity,
  logActivityOnce,
  listLeads,
  leadName,
  listMessageThreads,
  getLeadMessages,
} from "../services/leads";
import { toE164 } from "../util/phone";

export const appRouter = Router();

function ownerScope(req: Request): string | undefined {
  return req.authUser?.role === "admin" ? undefined : req.authUser?.id;
}

function canAccessLead(req: Request, lead: { owner_user_id: string | null } | null | undefined): boolean {
  const owner = ownerScope(req);
  return Boolean(lead && (!owner || lead.owner_user_id === owner));
}

// /app now serves the SAME console as /console. The console is a superset of the old
// softphone (it has a Dialer tab), and serving it here also rescues phones that cached
// the original PWA manifest whose start_url was "/app" — they still land on the console
// instead of the bare softphone. (softphone.html is kept in the repo in case we want it back.)
appRouter.get("/app", (_req, res) => {
  res.set("Cache-Control", "no-store, must-revalidate");
  res.sendFile(path.resolve(process.cwd(), "public", "console.html"));
});

// Bare domain (e.g. crm.smartr8.com/) serves the console DIRECTLY — no redirect — so the
// impact.com site-verification <meta> is present at the root itself (verifiers that don't
// follow 302s still find it), while humans still land straight on the CRM.
appRouter.get("/", (_req, res) => {
  res.set("Cache-Control", "no-store, must-revalidate");
  res.sendFile(path.resolve(process.cwd(), "public", "console.html"));
});

// Serve the full console UI (Leads · Messages · Contacts · Dialer · Flows).
// No-store so browsers always fetch the latest HTML (avoids "still shows old UI").
appRouter.get("/console", (_req, res) => {
  res.set("Cache-Control", "no-store, must-revalidate");
  res.sendFile(path.resolve(process.cwd(), "public", "console.html"));
});

// Isolated v2 CRM shell. This intentionally does not replace /, /console, or /app;
// crm.smartr8.com/v2 can be tested and shared without changing the live root console.
appRouter.get(["/v2", "/v2/"], (_req, res) => {
  res.set("Cache-Control", "no-store, must-revalidate");
  res.sendFile(path.resolve(process.cwd(), "public", "v2.html"));
});

// PWA service worker, served at root so its scope covers /console (installability).
appRouter.get("/sw.js", (_req, res) => {
  res.set("Content-Type", "application/javascript");
  res.set("Service-Worker-Allowed", "/");
  res.set("Cache-Control", "no-store");
  res.sendFile(path.resolve(process.cwd(), "public", "sw.js"));
});

// Public attachment media. Served WITHOUT the passcode (Telnyx must fetch MMS media);
// the filename is an unguessable UUID and is validated to stay inside MEDIA_DIR.
appRouter.get("/media/:file", (req, res) => {
  const full = mediaPathFor(req.params.file);
  if (!full) {
    res.status(404).end();
    return;
  }
  res.set("Content-Type", mimeForExt(path.extname(req.params.file)));
  res.set("Cache-Control", "public, max-age=3600");
  fs.createReadStream(full).pipe(res);
});

// Mint a short-lived Telnyx WebRTC token for the browser SDK. Passcode-gated.
appRouter.post("/webrtc/token", async (req, res) => {
  if (!checkPass(req, res)) return;
  try {
    const token = await mintWebrtcToken();
    res.json({ token, callerNumber: config.webrtc.callerNumber });
  } catch (err) {
    log.error("webrtc token error", { err: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

// ── Messaging + contacts API (all passcode-gated) ────────────────────────────

/** Lightweight gated health/auth check — used by the console to validate the
 *  passcode on unlock without hitting GHL/Telnyx (so unlock can never hang). */
appRouter.get("/api/ping", requirePass, (_req, res) => {
  res.json({ ok: true });
});

/** Upload an attachment (raw bytes; original filename in the x-filename header). Stored on
 *  the disk under an unguessable id; returns that id for use by /api/messages/send. */
appRouter.post("/api/messages/upload", raw({ type: () => true, limit: "16mb" }), (req, res) => {
  if (!checkPass(req, res)) return;
  const buf = req.body as Buffer;
  if (!buf || !buf.length) {
    res.status(400).json({ error: "empty upload" });
    return;
  }
  const rawName = req.get("x-filename") || "upload";
  const ext = path.extname(rawName).toLowerCase() || ".bin";
  if (!supportedMediaExt(ext)) {
    res.status(400).json({ error: "unsupported attachment type" });
    return;
  }
  const id = `${randomUUID()}${ext}`;
  writeMediaFile(id, buf)
    .then(() => res.json({ id, name: rawName, mime: mimeForExt(ext), size: buf.length }))
    .catch((err) => {
      log.error("attachment upload failed", { err: String(err) });
      res.status(500).json({ error: String(err) });
    });
});

/** Send an outbound text or image (iMessage-first → SMS/MMS fallback) and log it locally.
 *  `contactId` is a local lead id; if only a phone is given we find-or-create the lead so
 *  the message threads under it. GHL is no longer involved. */
appRouter.post("/api/messages/send", requirePass, async (req, res) => {
  const body = (req.body ?? {}) as {
    phone?: string;
    contactId?: string;
    message?: string;
    from?: string;
    attachmentId?: string;
    attachmentName?: string;
  };
  if (!body.message && !body.attachmentId) {
    res.status(400).json({ error: "pass a message or an attachmentId" });
    return;
  }
  try {
    let phone = body.phone;
    let contactId = body.contactId;
    // Resolve the local lead: by id if given, else find-or-create by phone.
    let lead = contactId ? getLead(contactId) : null;
    if (contactId && !canAccessLead(req, lead)) {
      res.status(404).json({ error: "contact not found" });
      return;
    }
    if (lead && !phone) phone = lead.phone ?? undefined;
    if (!phone) {
      res.status(400).json({ error: "pass phone or a contactId that has a phone" });
      return;
    }
    const e164 = toE164(phone);
    if (!lead) {
      const existing = findLead({ phone: e164 });
      if (existing && !canAccessLead(req, existing)) {
        res.status(404).json({ error: "contact not found" });
        return;
      }
      lead = existing ?? createLead({ phone: e164, source: "console" });
      const owner = ownerScope(req);
      if (!existing && owner) {
        updateLead(lead.id, { owner_user_id: owner });
        lead = getLead(lead.id)!;
      }
    }
    contactId = lead.id;

    // Resolve the attachment (if any) to a disk path + public URL (for the MMS fallback).
    let media: { path: string; url: string; mime: string; name: string } | undefined;
    if (body.attachmentId) {
      const full = mediaPathFor(body.attachmentId);
      if (!full) {
        res.status(400).json({ error: "attachment not found" });
        return;
      }
      const base = config.publicBaseUrl || config.crm.publicBaseUrl || `${req.protocol}://${req.get("host")}`;
      media = {
        path: full,
        url: publicMediaUrl(body.attachmentId, base),
        mime: mimeForExt(path.extname(body.attachmentId)),
        name: body.attachmentName || body.attachmentId,
      };
    }

    // `from` only affects the SMS/MMS fallback leg; iMessage-first order is unchanged.
    const result = await sendOutbound({ phone: e164, message: body.message ?? "", smsFrom: body.from, media });
    // Log the outbound onto the lead's local timeline (the Messages tab reads this).
    const logBody = body.message || (media ? `📎 ${media.name}` : "");
    const channel = result.path.startsWith("imessage") ? "imessage" : "sms";
    try {
      logActivityOnce(contactId, {
        type: channel,
        direction: "outbound",
        channel,
        body: logBody,
        status: result.ok ? "sent" : "failed",
        meta: { detail: result.detail },
      });
    } catch (err) {
      log.warn("console send: logActivity failed", { err: String(err) });
    }
    res.json({ ok: result.ok, path: result.path, detail: result.detail, contactId });
  } catch (err) {
    log.error("console send error", { err: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

/** Stable signature for a message, so the console can hide a specific one. */
function messageSig(m: { direction: string; date?: string | null; body: string }): string {
  return createHash("sha1").update(`${m.direction}|${m.date ?? ""}|${m.body}`).digest("hex").slice(0, 16);
}

/** List recent messages for a lead (for the thread view). Each message carries a `sig`,
 *  and any the operator hid via /hide are filtered out (console-side only; the timeline keeps them). */
appRouter.get("/api/messages/:contactId", requirePass, async (req, res) => {
  try {
    const lead = getLead(req.params.contactId);
    if (!canAccessLead(req, lead)) {
      res.status(404).json({ error: "contact not found" });
      return;
    }
    const hidden = hiddenMessageSigs(req.params.contactId);
    const messages = getLeadMessages(req.params.contactId, 100)
      .map((m) => ({ ...m, sig: messageSig(m) }))
      .filter((m) => !hidden.has(m.sig));
    res.json({
      messages,
      contact: lead
        ? {
            id: lead.id,
            phone: lead.phone,
            email: lead.email,
            whatsapp_phone: lead.whatsapp_phone,
            whatsapp_opt_in_status: Boolean(lead.whatsapp_opt_in_status),
            whatsapp_last_inbound_at: lead.whatsapp_last_inbound_at,
            whatsapp_last_outbound_at: lead.whatsapp_last_outbound_at,
            preferred_channel: lead.preferred_channel,
          }
        : null,
    });
  } catch (err) {
    log.error("console messages read error", { err: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

/** Hide a single message from this contact's console thread (GHL retains the original). */
appRouter.post("/api/messages/:contactId/hide", requirePass, (req, res) => {
  const lead = getLead(req.params.contactId);
  if (!canAccessLead(req, lead)) {
    res.status(404).json({ error: "contact not found" });
    return;
  }
  const sig = (req.body as { sig?: string } | undefined)?.sig;
  if (!sig || typeof sig !== "string") {
    res.status(400).json({ error: "pass sig" });
    return;
  }
  hideMessage(req.params.contactId, sig);
  res.json({ ok: true });
});

/** Search/list contacts from the local CRM (leads + contact-only records). */
appRouter.get("/api/contacts", requirePass, async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  try {
    const contacts = listLeads({ q, includeContactOnly: true, limit: 25, ownerUserId: ownerScope(req) }).map((l) => ({
      id: l.id,
      name: leadName(l),
      phone: l.phone ?? undefined,
      tags: l.tags,
    }));
    res.json({ contacts });
  } catch (err) {
    log.error("console contacts error", { err: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

/** ALL contacts (paginated) — for the Contacts tab's display-only GHL merge. Hidden GHL
 *  contacts (deleted from the Contacts list) are filtered out. */
appRouter.get("/api/contacts/all", requirePass, async (req, res) => {
  try {
    const owner = ownerScope(req);
    if (owner) {
      const contacts = listLeads({ includeContactOnly: true, limit: 2000, ownerUserId: owner }).map((l) => ({
        id: l.id,
        name: leadName(l),
        phone: l.phone ?? undefined,
        email: l.email ?? undefined,
        tags: l.tags,
      }));
      res.json({ contacts });
      return;
    }
    const hidden = hiddenContactPhones();
    const norm = (p?: string) => { const d = String(p || "").replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : ""; };
    const contacts = (await listAllContacts(2000)).filter((c) => { const k = norm(c.phone); return !k || !hidden.has(k); });
    res.json({ contacts });
  } catch (err) {
    log.error("console contacts/all error", { err: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

/** Hide GHL contacts from the Contacts list (they have no lead record to delete). Body: { phones: string[] }. */
appRouter.post("/api/contacts/hide", requirePass, (req, res) => {
  if (ownerScope(req)) {
    res.status(403).json({ error: "admin only" });
    return;
  }
  const phones = Array.isArray((req.body ?? {}).phones) ? (req.body as { phones: string[] }).phones : [];
  hideContacts(phones);
  res.json({ ok: true, hidden: phones.length });
});

/** Recent text conversations across all leads — the Messages inbox (local activities). */
appRouter.get("/api/conversations", requirePass, async (req, res) => {
  try {
    // Drop conversations the operator removed from the Messages inbox (console-side only;
    // the lead's own activity timeline still has every message). Fetch a few extra so the
    // list still fills up after hidden ones are filtered out.
    const hidden = hiddenConversationIds();
    const all = listMessageThreads(hidden.size ? 75 : 50, ownerScope(req));
    const conversations = all
      .filter((c) => !c.contactId || !hidden.has(c.contactId))
      .slice(0, 50);
    res.json({ conversations });
  } catch (err) {
    log.error("console conversations error", { err: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

/** Remove a conversation from the Messages inbox (console-side only; the lead keeps it). */
appRouter.post("/api/conversations/:contactId/hide", requirePass, (req, res) => {
  const lead = getLead(req.params.contactId);
  if (!canAccessLead(req, lead)) {
    res.status(404).json({ error: "contact not found" });
    return;
  }
  hideConversation(req.params.contactId);
  res.json({ ok: true });
});

/** Restore a previously hidden conversation to the inbox. */
appRouter.post("/api/conversations/:contactId/unhide", requirePass, (req, res) => {
  const lead = getLead(req.params.contactId);
  if (!canAccessLead(req, lead)) {
    res.status(404).json({ error: "contact not found" });
    return;
  }
  unhideConversation(req.params.contactId);
  res.json({ ok: true });
});

/** List sending numbers (for the dialer's from-number selector).
 *  Includes configured TELNYX_NUMBERS plus live Telnyx-owned numbers when available. */
appRouter.get("/api/numbers", requirePass, async (_req, res) => {
  const configured = listNumbers();
  const byNumber = new Map<string, { e164: string; areaCode?: string; state?: string; label: string; status?: string; source?: string }>();
  for (const n of configured) byNumber.set(n.e164, { ...n, source: "configured" });
  let liveError: string | null = null;
  if (config.telnyx.apiKey) {
    try {
      const owned = await listOwnedNumbers();
      for (const n of owned) {
        if (!n.phone_number) continue;
        const existing = byNumber.get(n.phone_number);
        byNumber.set(n.phone_number, {
          ...(existing || toOwnedNumber(n.phone_number)),
          status: n.status,
          source: existing ? `${existing.source || "configured"}+telnyx` : "telnyx",
        });
      }
    } catch (err) {
      liveError = err instanceof Error ? err.message : String(err);
    }
  }
  res.json({ numbers: Array.from(byNumber.values()), default: defaultFrom(), liveError });
});

/** List EVERY phone number on the Telnyx account, with a ready-to-paste TELNYX_NUMBERS
 *  value. Lets the operator populate the env without hunting through the Telnyx portal. */
appRouter.get("/api/telnyx/numbers", requirePass, async (_req, res) => {
  try {
    const owned = await listOwnedNumbers();
    const all = owned.map((n) => n.phone_number);
    res.json({
      count: all.length,
      csv: all.join(","),
      numbers: owned,
      configured: listNumbers().map((n) => n.e164),
    });
  } catch (err) {
    log.error("telnyx numbers list error", { err: String(err) });
    res.status(502).json({ error: String(err) });
  }
});

/** Read/flip inbound call-forwarding (the dialer toggle). When off, inbound rings the
 *  CRM portal only; when on, the business-hours window governs the forward to your cell. */
appRouter.get("/api/call-forwarding", requirePass, (_req, res) => {
  res.json({
    enabled: isForwardingEnabled(),
    inWindow: withinForwardWindow(),
    appRingSecs: config.inbound.appRingSecs,
    mode: config.inbound.mode,
    schedule: { tz: config.inbound.forwardTz, start: config.inbound.forwardStart, end: config.inbound.forwardEnd, days: config.inbound.forwardDays },
  });
});
appRouter.post("/api/call-forwarding", requirePass, (req, res) => {
  const enabled = (req.body as { enabled?: boolean } | undefined)?.enabled;
  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: "pass { enabled: boolean }" });
    return;
  }
  setForwarding(enabled);
  res.json({ ok: true, enabled });
});

/** Read/set the outbound texting channel: auto (iMessage→SMS), sms (Telnyx only),
 *  or imessage (always iMessage first). Lets the LO force SMS without a redeploy. */
appRouter.get("/api/messaging-mode", requirePass, (_req, res) => {
  res.json({ mode: getMessagingMode() });
});
appRouter.post("/api/messaging-mode", requirePass, (req, res) => {
  const mode = (req.body as { mode?: string } | undefined)?.mode;
  if (mode !== "auto" && mode !== "sms" && mode !== "imessage") {
    res.status(400).json({ error: "pass { mode: 'auto' | 'sms' | 'imessage' }" });
    return;
  }
  setMessagingMode(mode as MessagingMode);
  res.json({ ok: true, mode });
});

/** One-shot outbound SMS test that returns Telnyx's RAW response/error, bypassing the
 *  iMessage router — so we can see exactly why outbound fails (10DLC, profile, etc.).
 *  GET so it's clickable: /api/telnyx/test-send?to=+1...&pass=PASSCODE[&from=+1...] */
appRouter.get("/api/telnyx/test-send", requirePass, async (req, res) => {
  const to = typeof req.query.to === "string" ? req.query.to : "";
  if (!to) {
    res.status(400).json({ error: "pass ?to=+1XXXXXXXXXX" });
    return;
  }
  const e164 = toE164(to);
  const from = typeof req.query.from === "string" && req.query.from ? toE164(req.query.from) : pickFromNumber(e164).from;
  try {
    const sms = await sendSms(e164, "Smartr8 test — outbound SMS check.", from);
    res.json({ ok: true, to: e164, from, telnyxId: sms.id, status: sms.status });
  } catch (err) {
    // The raw Telnyx error (status + body) is the actual reason outbound is failing.
    res.status(502).json({ ok: false, to: e164, from, error: String(err) });
  }
});
appRouter.get("/api/route-from/:phone", requirePass, (req, res) => {
  res.json(pickFromNumber(req.params.phone));
});

/** Check a sent message's final delivery status + errors: /api/telnyx/message-status?id=...&pass= */
appRouter.get("/api/telnyx/message-status", requirePass, async (req, res) => {
  const id = typeof req.query.id === "string" ? req.query.id : "";
  if (!id) {
    res.status(400).json({ error: "pass ?id=<telnyxId>" });
    return;
  }
  try {
    res.json(await getMessageStatus(id));
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

/** Number lookup: carrier, line type (mobile/landline/voip), caller name (CNAM). */
appRouter.get("/api/lookup/:phone", requirePass, async (req, res) => {
  try {
    const info = await lookupNumber(req.params.phone);
    res.json(info);
  } catch (err) {
    log.error("number lookup error", { err: String(err) });
    res.status(502).json({ error: String(err) });
  }
});
