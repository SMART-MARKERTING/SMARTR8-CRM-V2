import { Router } from "express";
import { randomUUID } from "crypto";
import { config } from "../config";
import { log } from "../logger";
import { toE164 } from "../util/phone";
import { requirePass, requireAdmin, requireFeatureForCurrentPath } from "../util/auth";
import { upsertContact, logCall } from "../services/ghl";
import { addToDnc, listDnc, isOnDnc } from "../services/dnc";
import { enqueueAutomated, queueStatus } from "../services/callQueue";
import { getCall, setCall, delCall, listCalls } from "../services/callState";
import { startClickToCall } from "../services/clickToCall";
import {
  startConference,
  startConferenceFromCall,
  addToConference,
  hangupConference,
  getConferenceStatus,
  onConfLegAnswered,
  onConfLegHangup,
} from "../services/conference";
import { findLead, getLead, addNote, logActivity, resolveLeadTimezone, Lead } from "../services/leads";
import { withinCallingHours } from "../services/compliance";
import { defaultFrom, listNumbers, OwnedNumber, pickFromAvailableNumbers, toOwnedNumber } from "../services/numbers";
import { listOwnedNumbers } from "../services/telnyx";
import { db, insertCallLog, listCallLog, deleteCallLog, clearCallLog, listDeletedCallLog, restoreCallLog } from "../store/db";
import {
  startInboundAppThenCell,
  onInboundLegAnswered,
  onInboundLegHangup,
  getInboundTrace,
} from "../services/inboundRouter";
import {
  getWebrtcSipUri,
  ensureSipUriCalling,
  getSipUriCallingPref,
  getWebrtcDiagnostic,
  resetWebrtcCredentialCache,
} from "../services/telnyxWebrtc";
import { isVoicemailCall, handleVoicemailEvent } from "../services/voicemail";
import {
  placeCall,
  placeCallWithAmd,
  dialLeg,
  answer,
  hangup,
  bridge,
  transfer,
  speak,
  gatherDigits,
  voiceDiag,
} from "../services/telnyxVoice";
import { acceptTelnyxCallSummaryEvent, processCallSummary, verifyTelnyxWebhookSignature } from "../services/callSummary";

export const voiceRouter = Router();

voiceRouter.use(requireFeatureForCurrentPath);

const IVR_PROMPT =
  "Thank you for calling Adaxa Home Loans. Press 1 to reach Mike, or press 9 to be removed from our call list.";

// app-then-cell mode keeps a TCPA opt-out option before connecting.
const OPTOUT_PROMPT =
  "Thank you for calling Adaxa Home Loans. Please hold while we connect you. Or press 9 to be removed from our call list.";

// ── Endpoints ────────────────────────────────────────────────────────────────

// POST — API / curl. Body: { contactId } or { phone }.
voiceRouter.post("/calls/click-to-call", requirePass, async (req, res) => {
  try {
    const r = await startClickToCall((req.body ?? {}) as { contactId?: string; phone?: string });
    if ("error" in r) res.status(r.status).json({ error: r.error });
    else res.json(r);
  } catch (err) {
    log.error("click-to-call error", { err: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

// ── Conference (3-way) calling — passcode-gated (console only) ───────────────
// Your cell rings first; on answer we create a Telnyx conference and dial the first
// participant in. "Add" dials more people into the same live conference. DNC enforced.

voiceRouter.post("/calls/conference/start", requirePass, async (req, res) => {
  try {
    const r = await startConference((req.body ?? {}) as { phone?: string; contactId?: string });
    if ("error" in r) res.status(r.status).json({ error: r.error });
    else res.json(r);
  } catch (err) {
    log.error("conference start error", { err: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

/** Merge a third party onto the agent's ACTIVE dialer (WebRTC) call. Body: { ccid, phone }
 *  where ccid is the active call's Telnyx call_control_id (from the WebRTC SDK). */
voiceRouter.post("/calls/conference/from-call", requirePass, async (req, res) => {
  const body = (req.body ?? {}) as { ccid?: string; phone?: string };
  try {
    const r = await startConferenceFromCall({ agentCcid: body.ccid, phone: body.phone });
    if ("error" in r) res.status(r.status).json({ error: r.error });
    else res.json(r);
  } catch (err) {
    log.error("conference from-call error", { err: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

voiceRouter.post("/calls/conference/add", requirePass, async (req, res) => {
  const body = (req.body ?? {}) as { name?: string; phone?: string };
  if (!body.name) {
    res.status(400).json({ error: "pass the conference name" });
    return;
  }
  try {
    const r = await addToConference(body.name, body.phone ?? "");
    if ("error" in r) res.status(r.status).json({ error: r.error });
    else res.json(r);
  } catch (err) {
    log.error("conference add error", { err: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

voiceRouter.post("/calls/conference/hangup", requirePass, async (req, res) => {
  const body = (req.body ?? {}) as { name?: string };
  if (!body.name) {
    res.status(400).json({ error: "pass the conference name" });
    return;
  }
  try {
    res.json(await hangupConference(body.name));
  } catch (err) {
    log.error("conference hangup error", { err: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

voiceRouter.get("/calls/conference/:name", requirePass, (req, res) => {
  res.json(getConferenceStatus(req.params.name));
});

// GET — clickable from a GHL Custom Link, e.g.
//   https://<host>/calls/click-to-call?contactId={{contact.id}}
// Returns a small confirmation page; your cell rings and bridges to the contact.
voiceRouter.get("/calls/click-to-call", requirePass, async (req, res) => {
  const contactId = typeof req.query.contactId === "string" ? req.query.contactId : undefined;
  const phone = typeof req.query.phone === "string" ? req.query.phone : undefined;
  const page = (title: string, msg: string) =>
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<body style="font-family:system-ui;text-align:center;padding:2.5rem;max-width:34rem;margin:auto">` +
    `<h2>${title}</h2><p style="font-size:1.05rem;color:#333">${msg}</p></body>`;
  try {
    const r = await startClickToCall({ contactId, phone });
    if ("ok" in r) {
      res.send(page("\u{1F4DE} Calling…", `Your cell will ring now — answer to be connected to <b>${r.contact}</b>. You can close this tab.`));
    } else if ("skipped" in r) {
      res.send(page("Call not placed", `Skipped: <b>${r.reason}</b> (e.g. this number is on your Do-Not-Call list).`));
    } else {
      res.status(r.status).send(page("Couldn't start the call", r.error));
    }
  } catch (err) {
    log.error("click-to-call (GET) error", { err: String(err) });
    res.status(500).send(page("Error", String(err)));
  }
});

// GET /calls/diag — read-only check of the voice setup (no call placed). Open in a browser:
//   https://<host>/calls/diag
// Add ?place=1 to actually attempt the outbound call to MY_CELL_NUMBER (rings your
// cell) — bypasses GHL so it isolates whether Telnyx itself accepts the call.
voiceRouter.get("/calls/diag", requireAdmin, async (req, res) => {
  if (req.query.place === "1") {
    if (!config.voice.myCell) {
      res.status(500).json({ placeAttempt: { ok: false, error: "MY_CELL_NUMBER not set" } });
      return;
    }
    try {
      const ccid = await placeCall(config.voice.myCell);
      res.json({ placeAttempt: { ok: true, callControlId: ccid, note: "your cell should be ringing now" } });
    } catch (err) {
      res.json({ placeAttempt: { ok: false, error: String(err) } }); // raw Telnyx error incl. code/detail
    }
    return;
  }
  const env = {
    TELNYX_API_KEY: Boolean(config.telnyx.apiKey),
    TELNYX_VOICE_APP_ID_OR_CONNECTION_ID: Boolean(config.voice.applicationId),
    TELNYX_AMD_MODE: config.voice.amdMode,
    TELNYX_FROM_NUMBER: Boolean(config.telnyx.fromNumber),
    MY_CELL_NUMBER: Boolean(config.voice.myCell),
    TELNYX_SIP_CONNECTION_ID: Boolean(config.webrtc.sipConnectionId),
    APP_PASSCODE: Boolean(config.app.passcode),
  };
  const telnyx =
    config.telnyx.apiKey && config.voice.applicationId
      ? await voiceDiag()
      : { skipped: "set TELNYX_API_KEY and TELNYX_VOICE_APP_ID or TELNYX_CONNECTION_ID first" };
  const webrtc = await getWebrtcDiagnostic();
  const webrtcSipUri = typeof webrtc.sipUri === "string" ? webrtc.sipUri : null;
  // Current SIP-URI-calling preference on the connection (must be "unrestricted"/"internal"
  // for our app-ring leg to reach the registered console).
  const sipUriCalling = await getSipUriCallingPref();
  res.json({
    env,
    telnyx,
    inboundMode: config.inbound.mode, // must be "app-then-cell" to ring the app
    webrtc,
    webrtcSipUri, // the sip: we dial to ring the console; null = lookup failed
    sipUriCalling, // "disabled" => app can't be rung; hit /calls/enable-sip-uri to fix
    inboundTrace: getInboundTrace(), // step-by-step of the last inbound calls
    pollerWatching: Boolean(config.voice.applicationId && config.voice.myCell),
    callNowTag: config.voice.callNowTag,
    recentVoiceEvents, // call the number, then refresh: empty => Telnyx isn't reaching us
    recentCallLogs, // per-call GHL log result: loggedToGhl=false => GHL rejected the call log
  });
});

// Admin diagnostic: allow inbound SIP URI calls on the connection.
voiceRouter.get("/calls/enable-sip-uri", requireAdmin, async (_req, res) => {
  const result = await ensureSipUriCalling();
  res.json(result);
});

voiceRouter.post("/calls/enable-sip-uri", requirePass, async (req, res) => {
  const body = (req.body ?? {}) as { resetCredential?: boolean };
  if (body.resetCredential !== false) await resetWebrtcCredentialCache();
  const sipUriCalling = await ensureSipUriCalling();
  const webrtc = await getWebrtcDiagnostic();
  res.json({ ok: Boolean(sipUriCalling.ok && webrtc.ok), sipUriCalling, webrtc });
});

/** Automated outbound: queue contacts for sequenced, gated, throttled dialing. */
voiceRouter.post("/calls/automated", requirePass, (req, res) => {
  const body = (req.body ?? {}) as { contactIds?: string[] };
  const ids = Array.isArray(body.contactIds) ? body.contactIds.filter((x) => typeof x === "string") : [];
  if (!ids.length) {
    res.status(400).json({ error: "pass contactIds: string[]" });
    return;
  }
  const depth = enqueueAutomated(ids);
  res.json({ ok: true, accepted: ids.length, queueDepth: depth });
});

voiceRouter.get("/calls/queue", requirePass, (_req, res) => {
  res.json(queueStatus());
});

type PowerConnectTarget = "crm" | "cell";
interface PowerDialerItem {
  leadId: string;
  connectTo: PowerConnectTarget;
  from?: string;
  listId?: string;
  listName?: string;
}

const powerDialerQueue: PowerDialerItem[] = [];
let powerDialerActive = 0;
let powerDialerConcurrency = 1;
let powerDialerStopped = true;
let powerDialerLastError: string | null = null;
let powerDialerNumberCache: { at: number; numbers: OwnedNumber[] } | null = null;

interface PowerDialerEvent {
  id: string;
  at: number;
  leadId: string;
  name: string | null;
  phone: string | null;
  from?: string;
  status: string;
  outcome?: string;
  note?: string;
  callControlId?: string;
  peerCcid?: string;
  listId?: string;
  listName?: string;
}

interface PowerListWindow {
  timezone: string | null;
  label: string | null;
  allowed: boolean;
  localTime: string | null;
  reason: string | null;
}

const powerDialerEvents: PowerDialerEvent[] = [];

const POWER_LIST_TIMEZONES: Array<{ pattern: RegExp; timezone: string; label: string }> = [
  { pattern: /\b(az|arizona|phoenix)\b/i, timezone: "America/Phoenix", label: "AZ" },
  { pattern: /\b(pt|pacific|ca|california|west)\b/i, timezone: "America/Los_Angeles", label: "PT" },
  { pattern: /\b(mt|mountain|denver|co|colorado)\b/i, timezone: "America/Denver", label: "MT" },
  { pattern: /\b(ct|central|chicago|tx|texas)\b/i, timezone: "America/Chicago", label: "CT" },
  { pattern: /\b(et|eastern|new[_\s-]*york|fl|florida)\b/i, timezone: "America/New_York", label: "ET" },
];

function timezoneForPowerListName(name: string | null | undefined): { timezone: string; label: string } | null {
  const raw = String(name || "");
  for (const rule of POWER_LIST_TIMEZONES) {
    if (rule.pattern.test(raw)) return { timezone: rule.timezone, label: rule.label };
  }
  return null;
}

function localHourMinute(timezone: string): { hour: number; minute: number; label: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === "hour")?.value || 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value || 0);
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(new Date());
  return { hour: hour === 24 ? 0 : hour, minute, label };
}

function powerListWindow(name: string | null | undefined): PowerListWindow {
  const zone = timezoneForPowerListName(name);
  if (!zone) return { timezone: null, label: null, allowed: true, localTime: null, reason: null };
  const local = localHourMinute(zone.timezone);
  const minutes = local.hour * 60 + local.minute;
  const allowed = minutes >= 9 * 60 && minutes < 18 * 60;
  return {
    timezone: zone.timezone,
    label: zone.label,
    allowed,
    localTime: local.label,
    reason: allowed ? null : `List ${zone.label} can only dial 9:00 AM-6:00 PM local time (${local.label})`,
  };
}

function ownerScope(req: any): string | undefined {
  return req.authUser?.role === "admin" ? undefined : req.authUser?.id;
}

function canAccessLead(req: any, lead: Lead | null | undefined): boolean {
  const owner = ownerScope(req);
  return Boolean(lead && !lead.deleted_at && (!owner || lead.owner_user_id === owner));
}

function cleanText(value: unknown, fallback = ""): string {
  const s = value === null || value === undefined ? "" : String(value).trim();
  return s || fallback;
}

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function powerDialerEventForLead(lead: Lead | null, patch: Partial<PowerDialerEvent>): PowerDialerEvent {
  const leadId = patch.leadId || lead?.id || "";
  const idx = powerDialerEvents.findIndex((row) => row.leadId === leadId && (!patch.callControlId || row.callControlId === patch.callControlId));
  const current = idx >= 0 ? powerDialerEvents[idx] : {
    id: randomUUID(),
    at: Date.now(),
    leadId,
    name: lead ? leadDisplayName(lead) : null,
    phone: lead?.phone || null,
    status: "queued",
  };
  const next = { ...current, ...patch, at: Date.now() };
  if (idx >= 0) powerDialerEvents.splice(idx, 1);
  powerDialerEvents.unshift(next);
  if (powerDialerEvents.length > 300) powerDialerEvents.splice(300);
  return next;
}

async function listPowerDialerFromNumbers(): Promise<OwnedNumber[]> {
  const configured = listNumbers();
  if (!config.telnyx.apiKey) return configured;
  if (powerDialerNumberCache && Date.now() - powerDialerNumberCache.at < 5 * 60 * 1000) {
    return powerDialerNumberCache.numbers;
  }
  const byNumber = new Map<string, OwnedNumber>();
  for (const n of configured) byNumber.set(n.e164, n);
  try {
    const owned = await listOwnedNumbers();
    for (const n of owned) {
      if (!n.phone_number || byNumber.has(n.phone_number)) continue;
      byNumber.set(n.phone_number, toOwnedNumber(n.phone_number));
    }
    const numbers = Array.from(byNumber.values());
    powerDialerNumberCache = { at: Date.now(), numbers };
    return numbers;
  } catch (err) {
    log.warn("Power Dialer could not refresh Telnyx caller IDs; using configured numbers", { error: String(err) });
    return configured;
  }
}

async function pickPowerDialerFromNumber(destination: string) {
  const numbers = await listPowerDialerFromNumbers();
  return pickFromAvailableNumbers(destination, numbers, defaultFrom() || numbers[0]?.e164 || "");
}

function leadDisplayName(lead: Lead): string | null {
  return [lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.email || lead.phone || null;
}

async function powerDialerTarget(connectTo: PowerConnectTarget): Promise<string | null> {
  if (connectTo === "cell") return config.voice.myCell || null;
  return await getWebrtcSipUri().catch(() => null);
}

async function startPowerDialLead(item: PowerDialerItem): Promise<boolean> {
  const lead = getLead(item.leadId);
  if (!lead || lead.deleted_at) return false;
  const window = powerListWindow(item.listName);
  if (!window.allowed) {
    logActivity(lead.id, { type: "call", direction: "outbound", channel: "voice", body: `Power Dialer skipped: ${window.reason}`, status: "skipped:list-window" });
    powerDialerEventForLead(lead, { leadId: lead.id, status: "skipped", outcome: "list-window", listId: item.listId, listName: item.listName, note: window.reason || undefined });
    return false;
  }
  if (!lead.phone) {
    logActivity(lead.id, { type: "call", direction: "outbound", channel: "voice", body: "Power Dialer skipped: no phone", status: "skipped:no-phone" });
    powerDialerEventForLead(lead, { leadId: lead.id, status: "skipped", outcome: "no-phone", listId: item.listId, listName: item.listName });
    return false;
  }
  if (await isOnDnc(lead.phone)) {
    logActivity(lead.id, { type: "call", direction: "outbound", channel: "voice", body: "Power Dialer skipped: DNC", status: "skipped:on-DNC" });
    powerDialerEventForLead(lead, { leadId: lead.id, status: "skipped", outcome: "dnc", listId: item.listId, listName: item.listName });
    return false;
  }
  const timezone = resolveLeadTimezone(lead) || config.crm.defaultTimezone || undefined;
  const hours = withinCallingHours(timezone);
  if (!hours.allowed) {
    logActivity(lead.id, { type: "call", direction: "outbound", channel: "voice", body: "Power Dialer skipped: outside calling window", status: `skipped:${hours.reason || "outside-hours"}` });
    powerDialerEventForLead(lead, { leadId: lead.id, status: "skipped", outcome: hours.reason || "outside-hours", listId: item.listId, listName: item.listName });
    return false;
  }
  const target = await powerDialerTarget(item.connectTo);
  if (!target) {
    powerDialerLastError = item.connectTo === "crm" ? "CRM softphone is not registered" : "MY_CELL_NUMBER is not set";
    logActivity(lead.id, { type: "call", direction: "outbound", channel: "voice", body: "Power Dialer skipped: no agent target", status: "skipped:no-agent-target" });
    powerDialerEventForLead(lead, { leadId: lead.id, status: "skipped", outcome: "no-agent-target", listId: item.listId, listName: item.listName });
    return false;
  }
  const picked = await pickPowerDialerFromNumber(lead.phone);
  const from = item.from || picked.from;
  const ccid = await placeCallWithAmd(lead.phone, from);
  powerDialerActive++;
  powerDialerEventForLead(lead, { leadId: lead.id, status: "dialing", from, callControlId: ccid, listId: item.listId, listName: item.listName, note: item.from ? "manual caller ID" : `auto ${picked.reason}` });
  setCall(ccid, {
    kind: "automated",
    direction: "outbound",
    startedAt: Date.now(),
    primary: true,
    leadId: lead.id,
    contactPhone: lead.phone,
    peerTarget: target,
    peerFrom: from,
    stage: "amd-wait",
    powerDialer: true,
  });
  logActivity(lead.id, {
    type: "call",
    direction: "outbound",
    channel: "voice",
    body: `Power Dialer started from ${from}`,
    status: "amd-wait",
    meta: { callControlId: ccid, connectTo: item.connectTo, from, fromReason: item.from ? "manual" : picked.reason, listId: item.listId, listName: item.listName },
  });
  return true;
}

function pumpPowerDialer(): void {
  if (powerDialerStopped) return;
  void (async () => {
    while (!powerDialerStopped && powerDialerActive < powerDialerConcurrency && powerDialerQueue.length) {
      const item = powerDialerQueue.shift()!;
      try {
        await startPowerDialLead(item);
      } catch (err) {
        powerDialerLastError = String(err);
        log.error("power dialer start error", { leadId: item.leadId, err: String(err) });
      }
    }
  })();
}

function finishPowerDialerLeg(): void {
  if (powerDialerActive > 0) powerDialerActive--;
  pumpPowerDialer();
}

function powerDialerActiveLines() {
  return listCalls()
    .filter(({ ctx }) => ctx.powerDialer && ctx.primary)
    .map(({ ccid, ctx }) => {
      const lead = ctx.leadId ? getLead(ctx.leadId) : null;
      const event = powerDialerEvents.find((row) => row.callControlId === ccid || (lead && row.leadId === lead.id));
      return {
        callControlId: ccid,
        peerCcid: ctx.peerCcid || null,
        leadId: ctx.leadId || null,
        name: lead ? leadDisplayName(lead) : null,
        phone: ctx.contactPhone || lead?.phone || null,
        status: event?.status || ctx.stage || "calling",
        outcome: event?.outcome || ctx.powerDialerResult || null,
        from: event?.from || ctx.peerFrom || null,
        listId: event?.listId || null,
        listName: event?.listName || null,
        startedAt: ctx.startedAt,
        answeredAt: ctx.answeredAt || null,
        connectedAt: ctx.connectedAt || null,
        stage: ctx.stage || null,
      };
    })
    .sort((a, b) => a.startedAt - b.startedAt);
}

function powerDialerListRows(req: any): Array<{ id: string; created_at: number; updated_at: number; created_by: string | null; owner_user_id: string | null; name: string; source: string | null; lead_ids: string; filters: string }> {
  const owner = ownerScope(req);
  return db
    .prepare(
      `SELECT * FROM power_dialer_lists
       WHERE @owner IS NULL OR owner_user_id = @owner OR owner_user_id IS NULL
       ORDER BY updated_at DESC`,
    )
    .all({ owner: owner || null }) as Array<{ id: string; created_at: number; updated_at: number; created_by: string | null; owner_user_id: string | null; name: string; source: string | null; lead_ids: string; filters: string }>;
}

function powerDialerListForRequest(req: any, id: string) {
  return powerDialerListRows(req).find((row) => row.id === id) || null;
}

function listSummary(row: ReturnType<typeof powerDialerListRows>[number]) {
  const ids = safeParse<string[]>(row.lead_ids, []);
  const window = powerListWindow(row.name);
  return {
    id: row.id,
    name: row.name,
    source: row.source,
    count: ids.length,
    created_at: row.created_at,
    updated_at: row.updated_at,
    filters: safeParse<Record<string, unknown>>(row.filters, {}),
    callWindow: window,
    callableNow: window.allowed,
  };
}

function callablePowerLists(req: any) {
  return powerDialerListRows(req).filter((row) => powerListWindow(row.name).allowed);
}

voiceRouter.get("/calls/power-dialer/lists", requirePass, (req, res) => {
  res.json({ ok: true, lists: powerDialerListRows(req).map(listSummary) });
});

voiceRouter.post("/calls/power-dialer/lists", requirePass, (req, res) => {
  const body = (req.body ?? {}) as { name?: string; ids?: string[]; source?: string; filters?: Record<string, unknown> };
  const name = cleanText(body.name).slice(0, 120);
  const rawIds = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === "string") : [];
  const ids = Array.from(new Set(rawIds)).filter((id) => canAccessLead(req, getLead(id))).slice(0, 5000);
  if (!name) {
    res.status(400).json({ error: "name the call list" });
    return;
  }
  if (!ids.length) {
    res.status(400).json({ error: "select at least one callable lead" });
    return;
  }
  const now = Date.now();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO power_dialer_lists (id, created_at, updated_at, created_by, owner_user_id, name, source, lead_ids, filters)
     VALUES (@id, @now, @now, @createdBy, @ownerUserId, @name, @source, @leadIds, @filters)`,
  ).run({
    id,
    now,
    createdBy: req.authUser?.name || req.authUser?.username || null,
    ownerUserId: req.authUser?.role === "admin" ? null : req.authUser?.id || null,
    name,
    source: cleanText(body.source, "manual").slice(0, 80),
    leadIds: JSON.stringify(ids),
    filters: JSON.stringify(body.filters && typeof body.filters === "object" ? body.filters : {}),
  });
  res.json({ ok: true, list: { id, name, count: ids.length, updated_at: now } });
});

voiceRouter.get("/calls/power-dialer/lists/:id", requirePass, (req, res) => {
  const row = db.prepare(`SELECT * FROM power_dialer_lists WHERE id = ?`).get(req.params.id) as ReturnType<typeof powerDialerListRows>[number] | undefined;
  if (!row || !powerDialerListRows(req).some((item) => item.id === row.id)) {
    res.status(404).json({ error: "call list not found" });
    return;
  }
  const ids = safeParse<string[]>(row.lead_ids, []);
  const leads = ids.map((id) => getLead(id)).filter((lead): lead is Lead => canAccessLead(req, lead));
  res.json({ ok: true, list: listSummary(row), leads });
});

voiceRouter.patch("/calls/power-dialer/lists/:id", requirePass, (req, res) => {
  const row = db.prepare(`SELECT * FROM power_dialer_lists WHERE id = ?`).get(req.params.id) as ReturnType<typeof powerDialerListRows>[number] | undefined;
  if (!row || !powerDialerListRows(req).some((item) => item.id === row.id)) {
    res.status(404).json({ error: "call list not found" });
    return;
  }

  const body = (req.body ?? {}) as { name?: string; ids?: string[]; source?: string; filters?: Record<string, unknown> };
  const hasName = Object.prototype.hasOwnProperty.call(body, "name");
  const name = (hasName ? cleanText(body.name) : row.name).slice(0, 120);
  if (!name) {
    res.status(400).json({ error: "name the call list" });
    return;
  }

  let ids = safeParse<string[]>(row.lead_ids, []);
  if (Array.isArray(body.ids)) {
    ids = Array.from(new Set(body.ids.filter((id) => typeof id === "string")))
      .filter((id) => canAccessLead(req, getLead(id)))
      .slice(0, 5000);
    if (!ids.length) {
      res.status(400).json({ error: "select at least one callable lead" });
      return;
    }
  }

  const source = Object.prototype.hasOwnProperty.call(body, "source") ? cleanText(body.source, "manual").slice(0, 80) : row.source;
  const filters = Object.prototype.hasOwnProperty.call(body, "filters")
    ? JSON.stringify(body.filters && typeof body.filters === "object" ? body.filters : {})
    : row.filters;
  const now = Date.now();
  db.prepare(
    `UPDATE power_dialer_lists
        SET updated_at = @now,
            name = @name,
            source = @source,
            lead_ids = @leadIds,
            filters = @filters
      WHERE id = @id`,
  ).run({
    id: row.id,
    now,
    name,
    source,
    leadIds: JSON.stringify(ids),
    filters,
  });
  const updated = db.prepare(`SELECT * FROM power_dialer_lists WHERE id = ?`).get(row.id) as ReturnType<typeof powerDialerListRows>[number];
  const leads = ids.map((id) => getLead(id)).filter((lead): lead is Lead => canAccessLead(req, lead));
  res.json({ ok: true, list: listSummary(updated), leads });
});

voiceRouter.delete("/calls/power-dialer/lists/:id", requirePass, (req, res) => {
  const allowed = powerDialerListRows(req).some((row) => row.id === req.params.id);
  if (!allowed) {
    res.status(404).json({ error: "call list not found" });
    return;
  }
  db.prepare(`DELETE FROM power_dialer_lists WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

voiceRouter.post("/calls/power-dialer/lists/:id/delete", requirePass, (req, res) => {
  const allowed = powerDialerListRows(req).some((row) => row.id === req.params.id);
  if (!allowed) {
    res.status(404).json({ error: "call list not found" });
    return;
  }
  db.prepare(`DELETE FROM power_dialer_lists WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

voiceRouter.post("/calls/power-dialer/disposition", requirePass, (req, res) => {
  const body = (req.body ?? {}) as { leadId?: string; outcome?: string; note?: string };
  const lead = getLead(cleanText(body.leadId));
  if (!canAccessLead(req, lead)) {
    res.status(404).json({ error: "lead not found" });
    return;
  }
  const outcome = cleanText(body.outcome, "note").slice(0, 60);
  const note = cleanText(body.note).slice(0, 2000);
  if (note) addNote(lead!.id, note, "power-dialer");
  logActivity(lead!.id, {
    type: "call",
    direction: "outbound",
    channel: "voice",
    subject: "Power Dialer disposition",
    body: note || `Power Dialer call result: ${outcome}`,
    status: outcome,
    meta: { source: "power-dialer-manual" },
  });
  powerDialerEventForLead(lead, { leadId: lead!.id, status: "manual", outcome, note });
  res.json({ ok: true, leadId: lead!.id, outcome });
});

voiceRouter.post("/calls/power-dialer/start", requirePass, async (req, res) => {
  const body = (req.body ?? {}) as { ids?: string[]; connectTo?: string; from?: string; concurrency?: number; listId?: string };
  const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === "string").slice(0, 250) : [];
  if (!ids.length) {
    res.status(400).json({ error: "pass selected lead ids" });
    return;
  }
  const list = body.listId ? powerDialerListForRequest(req, cleanText(body.listId)) : null;
  if (body.listId && !list) {
    res.status(404).json({ error: "call list not found" });
    return;
  }
  const listWindow = powerListWindow(list?.name);
  if (!listWindow.allowed) {
    res.status(403).json({ error: listWindow.reason || "call list is outside allowed hours", callWindow: listWindow });
    return;
  }
  const connectTo: PowerConnectTarget = body.connectTo === "cell" ? "cell" : "crm";
  const target = await powerDialerTarget(connectTo);
  if (!target) {
    res.status(400).json({ error: connectTo === "crm" ? "CRM softphone is not registered yet" : "MY_CELL_NUMBER is not set" });
    return;
  }
  powerDialerConcurrency = Math.max(1, Math.min(3, Number(body.concurrency) || 1));
  powerDialerStopped = false;
  powerDialerLastError = null;
  for (const id of ids) {
    const lead = getLead(id);
    if (canAccessLead(req, lead)) {
      powerDialerQueue.push({ leadId: id, connectTo, from: body.from || undefined, listId: list?.id || undefined, listName: list?.name || undefined });
      powerDialerEventForLead(lead, { leadId: id, status: "queued", listId: list?.id || undefined, listName: list?.name || undefined });
    }
  }
  pumpPowerDialer();
  res.json({ ok: true, queued: powerDialerQueue.length, active: powerDialerActive, concurrency: powerDialerConcurrency, connectTo, callWindow: listWindow });
});

voiceRouter.post("/calls/power-dialer/start-available-lists", requirePass, async (req, res) => {
  const body = (req.body ?? {}) as { connectTo?: string; from?: string; concurrency?: number; max?: number };
  const connectTo: PowerConnectTarget = body.connectTo === "cell" ? "cell" : "crm";
  const target = await powerDialerTarget(connectTo);
  if (!target) {
    res.status(400).json({ error: connectTo === "crm" ? "CRM softphone is not registered yet" : "MY_CELL_NUMBER is not set" });
    return;
  }
  const allLists = powerDialerListRows(req);
  const timedLists = allLists.filter((row) => Boolean(powerListWindow(row.name).timezone));
  const available = timedLists.filter((row) => powerListWindow(row.name).allowed);
  const unavailable = timedLists
    .filter((row) => !powerListWindow(row.name).allowed)
    .map((row) => ({ id: row.id, name: row.name, callWindow: powerListWindow(row.name) }));
  if (!available.length) {
    res.status(403).json({ error: "No call lists are inside the 9:00 AM-6:00 PM local window right now.", unavailable });
    return;
  }
  const buckets = available.map((row) => ({
    row,
    ids: safeParse<string[]>(row.lead_ids, []).filter((id) => canAccessLead(req, getLead(id))),
  })).filter((bucket) => bucket.ids.length);
  if (!buckets.length) {
    res.status(400).json({ error: "Available call lists have no callable leads.", unavailable });
    return;
  }
  powerDialerConcurrency = Math.max(1, Math.min(3, Number(body.concurrency) || 1));
  powerDialerStopped = false;
  powerDialerLastError = null;
  const max = Math.max(1, Math.min(750, Number(body.max) || 250));
  const seen = new Set<string>();
  let queued = 0;
  while (queued < max && buckets.some((bucket) => bucket.ids.length)) {
    for (const bucket of buckets) {
      const id = bucket.ids.shift();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const lead = getLead(id);
      if (!canAccessLead(req, lead)) continue;
      powerDialerQueue.push({ leadId: id, connectTo, from: body.from || undefined, listId: bucket.row.id, listName: bucket.row.name });
      powerDialerEventForLead(lead, { leadId: id, status: "queued", listId: bucket.row.id, listName: bucket.row.name });
      queued++;
      if (queued >= max) break;
    }
  }
  pumpPowerDialer();
  res.json({
    ok: true,
    queued: powerDialerQueue.length,
    added: queued,
    active: powerDialerActive,
    concurrency: powerDialerConcurrency,
    connectTo,
    available: available.map(listSummary),
    unavailable,
  });
});

voiceRouter.post("/calls/power-dialer/stop", requirePass, (_req, res) => {
  const cleared = powerDialerQueue.length;
  powerDialerQueue.splice(0, powerDialerQueue.length);
  powerDialerStopped = true;
  res.json({ ok: true, cleared, active: powerDialerActive });
});

voiceRouter.post("/calls/power-dialer/lines/:ccid/monitor", requirePass, async (req, res) => {
  const ccid = req.params.ccid;
  const ctx = getCall(ccid);
  if (!ctx || !ctx.powerDialer || !ctx.primary) {
    res.status(404).json({ error: "active Power Dialer line not found" });
    return;
  }
  const body = (req.body ?? {}) as { connectTo?: string };
  const connectTo: PowerConnectTarget = body.connectTo === "cell" ? "cell" : "crm";
  const target = await powerDialerTarget(connectTo);
  if (!target) {
    res.status(400).json({ error: connectTo === "crm" ? "CRM softphone is not registered yet" : "MY_CELL_NUMBER is not set" });
    return;
  }
  try {
    const peer = await dialLeg(target, { timeoutSecs: config.inbound.cellRingSecs, from: config.telnyx.fromNumber });
    ctx.peerCcid = peer;
    setCall(peer, {
      kind: "automated",
      direction: "outbound",
      startedAt: ctx.startedAt,
      primary: false,
      leadId: ctx.leadId,
      contactPhone: ctx.contactPhone,
      role: "bridge-on-answer",
      peerCcid: ccid,
      powerDialer: true,
    });
    const lead = ctx.leadId ? getLead(ctx.leadId) : null;
    if (lead) {
      powerDialerEventForLead(lead, { leadId: lead.id, status: "monitor-ringing", callControlId: ccid, peerCcid: peer, note: `Ringing ${connectTo}` });
      logActivity(lead.id, { type: "call", direction: "outbound", channel: "voice", body: `Power Dialer monitor requested to ${connectTo}`, status: "monitor-ringing" });
    }
    res.json({ ok: true, callControlId: ccid, peerCcid: peer, connectTo });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

voiceRouter.post("/calls/power-dialer/lines/:ccid/end", requirePass, async (req, res) => {
  const ccid = req.params.ccid;
  const ctx = getCall(ccid);
  if (!ctx || !ctx.powerDialer) {
    res.status(404).json({ error: "active Power Dialer line not found" });
    return;
  }
  const peer = ctx.peerCcid;
  await hangup(ccid).catch(() => {});
  if (peer) await hangup(peer).catch(() => {});
  const lead = ctx.leadId ? getLead(ctx.leadId) : null;
  if (lead) powerDialerEventForLead(lead, { leadId: lead.id, status: "ended", outcome: "manual-end", callControlId: ccid });
  res.json({ ok: true, callControlId: ccid, peerCcid: peer || null });
});

voiceRouter.get("/calls/power-dialer/status", requirePass, (_req, res) => {
  res.json({
    ok: true,
    queued: powerDialerQueue.length,
    active: powerDialerActive,
    running: !powerDialerStopped,
    concurrency: powerDialerConcurrency,
    lastError: powerDialerLastError,
    lines: powerDialerActiveLines(),
    lists: powerDialerListRows(_req).map(listSummary),
    queue: powerDialerQueue.slice(0, 50).map((item) => {
      const lead = getLead(item.leadId);
      return { leadId: item.leadId, name: lead ? leadDisplayName(lead) : item.leadId, phone: lead?.phone || null, connectTo: item.connectTo, from: item.from || "auto", listId: item.listId, listName: item.listName };
    }),
    recent: powerDialerEvents.slice(0, 80),
  });
});

/** Call log (Dialer panel): list recent calls, delete one, or clear. Passcode-gated. */
voiceRouter.get("/api/calls/log", requirePass, (_req, res) => {
  res.json({ calls: listCallLog(200) });
});
voiceRouter.post("/api/calls/log/:id/delete", requirePass, (req, res) => {
  deleteCallLog(req.params.id);
  res.json({ ok: true });
});
voiceRouter.post("/api/calls/log/clear", requirePass, (req, res) => {
  const outcome = typeof (req.body ?? {}).outcome === "string" ? (req.body as { outcome: string }).outcome : undefined;
  clearCallLog(outcome);
  res.json({ ok: true });
});
voiceRouter.get("/api/deleted/calls", requirePass, (_req, res) => {
  res.json({ calls: listDeletedCallLog(300) });
});
voiceRouter.post("/api/calls/log/:id/restore", requirePass, (req, res) => {
  restoreCallLog(req.params.id);
  res.json({ ok: true });
});

/** DNC: add a number (auto-called on opt-out too). */
voiceRouter.post("/dnc", requirePass, async (req, res) => {
  const body = (req.body ?? {}) as { phone?: string; reason?: string };
  if (!body.phone) {
    res.status(400).json({ error: "pass phone" });
    return;
  }
  await addToDnc(body.phone, body.reason ?? "manual");
  res.json({ ok: true, added: toE164(body.phone) });
});

voiceRouter.get("/dnc", requirePass, async (_req, res) => {
  res.json({ numbers: await listDnc() });
});

// ── Telnyx Voice webhook (inbound calls + all call events) ───────────────────

// Last few voice events (in-memory) so /calls/diag can confirm Telnyx is reaching us.
interface VoiceEventLog { at: string; type?: string; direction?: string; from?: string; to?: string; ccid?: string }
const recentVoiceEvents: VoiceEventLog[] = [];
function recordVoiceEvent(e: VoiceEventLog): void {
  recentVoiceEvents.unshift(e);
  if (recentVoiceEvents.length > 15) recentVoiceEvents.pop();
}
export function getRecentVoiceEvents(): VoiceEventLog[] {
  return recentVoiceEvents;
}

// Last few GHL call-log attempts so /calls/diag proves calls are actually reaching GHL.
// loggedToGhl=false means the call happened but GHL did NOT record it (see `error`).
interface CallLogAttempt {
  at: string;
  direction?: string;
  contactId?: string;
  durationSec?: number;
  status?: string;
  loggedToGhl: boolean;
  error?: string;
}
const recentCallLogs: CallLogAttempt[] = [];
function recordCallLog(e: CallLogAttempt): void {
  recentCallLogs.unshift(e);
  if (recentCallLogs.length > 15) recentCallLogs.pop();
}

voiceRouter.post("/webhooks/telnyx-voice", async (req, res) => {
  if (!verifyTelnyxWebhookSignature(req)) {
    res.status(401).json({ error: "invalid Telnyx webhook signature" });
    return;
  }
  const summary = acceptTelnyxCallSummaryEvent(req.body);
  res.status(200).json({ received: true }); // ack fast
  if (summary.accepted && summary.rowId) {
    void processCallSummary(summary.rowId, { inlineTranscript: summary.inlineTranscript }).catch((err) => {
      log.error("call summary async processing error", { rowId: summary.rowId, err: String(err) });
    });
  }
  const ev = (req.body ?? {}).data;
  const type: string | undefined = ev?.event_type;
  const p = ev?.payload ?? {};
  recordVoiceEvent({ at: new Date().toISOString(), type, direction: p.direction, from: p.from, to: p.to, ccid: p.call_control_id });
  log.info("telnyx voice event", { type, ccid: p.call_control_id, raw: p });
  try {
    // Voicemail-drop legs (AMD) own their own event flow — route them first.
    if (isVoicemailCall(p.call_control_id)) {
      await handleVoicemailEvent(type, p);
      return;
    }
    if (type === "call.initiated" && p.direction === "incoming") await handleInbound(p);
    else if (type === "call.answered") await handleAnswered(p.call_control_id);
    else if (type === "call.machine.detection.ended") await handleMachineDetection(p.call_control_id, p);
    else if (type === "call.gather.ended") await handleGather(p.call_control_id, p.digits);
    else if (type === "call.hangup") await handleHangup(p.call_control_id, p);
  } catch (err) {
    log.error("voice webhook handler error", { type, err: String(err) });
  }
});

async function handleInbound(p: any): Promise<void> {
  const ccid = p.call_control_id as string;
  const from = p.from as string;
  let contactId: string | undefined;
  try {
    const c = await upsertContact(from);
    contactId = c.id;
  } catch (err) {
    log.warn("inbound upsert failed", { err: String(err) });
  }
  // Thread the inbound call onto the CRM lead's timeline (find by caller number).
  const crmLead = findLead({ phone: from });
  if (crmLead) logActivity(crmLead.id, { type: "call", direction: "inbound", channel: "voice", body: `Inbound call from ${from}`, status: "received" });
  // "app-then-cell" mode answers and rings the app; otherwise the classic IVR.
  const appMode = config.inbound.mode === "app-then-cell";
  setCall(ccid, {
    kind: "inbound",
    direction: "inbound",
    startedAt: Date.now(),
    primary: true,
    contactId,
    contactPhone: from,
    stage: appMode ? "routing" : "answering",
  });
  await answer(ccid);
}

async function handleAnswered(ccid: string): Promise<void> {
  const ctx = getCall(ccid);
  if (!ctx) {
    // Unknown leg — could be an inbound app/cell dial-out leg answering.
    await onInboundLegAnswered(ccid);
    return;
  }
  ctx.answeredAt = Date.now();
  if (ctx.powerDialer && ctx.stage === "amd-wait") {
    // Power Dialer waits for AMD before ringing the agent, so voicemail/machine answers
    // do not pull the operator into a dead call.
    return;
  }

  // Conference legs (3-way): agent-create → make the conference + dial first party;
  // participant → join the conference. Handled fully here.
  if (await onConfLegAnswered(ccid)) return;

  // app-then-cell: ring the app IMMEDIATELY (no prompt/delay). TCPA opt-out is an
  // outbound concern; for inbound we connect fast, like a normal phone.
  if (ctx.kind === "inbound" && ctx.primary && ctx.stage === "routing") {
    ctx.stage = "ringing-app";
    await startInboundAppThenCell(ccid);
    return;
  }
  // app/cell dial-out legs answering → bridge to the caller.
  if (await onInboundLegAnswered(ccid)) return;

  if (ctx.kind === "inbound" && ctx.stage === "answering") {
    ctx.stage = "gathering";
    await gatherDigits(ccid, IVR_PROMPT);
    return;
  }
  if (ctx.role === "dial-peer-on-answer" && ctx.peerTarget && !ctx.peerCcid) {
    const peer = await placeCall(ctx.peerTarget, ctx.peerFrom || config.telnyx.fromNumber);
    ctx.peerCcid = peer;
    setCall(peer, {
      kind: ctx.kind,
      direction: ctx.direction,
      startedAt: ctx.startedAt,
      primary: false,
      contactId: ctx.contactId,
      contactPhone: ctx.contactPhone,
      role: "bridge-on-answer",
      peerCcid: ccid,
    });
    return;
  }
  if (ctx.role === "bridge-on-answer" && ctx.peerCcid) {
    const peer = getCall(ctx.peerCcid);
    if (peer) {
      peer.connectedAt = Date.now();
      peer.answeredAt = peer.answeredAt || Date.now();
    }
    await bridge(ccid, ctx.peerCcid);
    if (ctx.powerDialer && ctx.leadId) {
      const lead = getLead(ctx.leadId);
      if (lead) powerDialerEventForLead(lead, { leadId: lead.id, status: "agent-answered", outcome: "connected", callControlId: ctx.peerCcid, peerCcid: ccid });
    }
  }
}

async function handleMachineDetection(ccid: string, p: any): Promise<void> {
  const ctx = getCall(ccid);
  if (!ctx || !ctx.powerDialer) return;
  const result = String(p?.machine_detection_result ?? p?.result ?? p?.answering_machine_detection_result ?? "").toLowerCase();
  ctx.powerDialerResult = result || "unknown";
  const lead = ctx.leadId ? getLead(ctx.leadId) : null;
  const human = /human|not_sure|unknown/.test(result);
  if (!human) {
    if (lead) {
      logActivity(lead.id, {
        type: "call",
        direction: "outbound",
        channel: "voice",
        body: `Power Dialer skipped bridge: ${result || "machine"}`,
        status: `machine:${result || "detected"}`,
      });
      powerDialerEventForLead(lead, { leadId: lead.id, status: "machine", outcome: result || "machine", callControlId: ccid });
    }
    await hangup(ccid).catch(() => {});
    return;
  }
  if (!ctx.peerTarget) {
    if (lead) logActivity(lead.id, { type: "call", direction: "outbound", channel: "voice", body: "Power Dialer human detected but no agent target was available", status: "failed:no-agent-target" });
    if (lead) powerDialerEventForLead(lead, { leadId: lead.id, status: "failed", outcome: "no-agent-target", callControlId: ccid });
    await hangup(ccid).catch(() => {});
    return;
  }
  try {
    ctx.stage = "ringing-agent";
    const peer = await dialLeg(ctx.peerTarget, { timeoutSecs: config.inbound.cellRingSecs, from: config.telnyx.fromNumber });
    ctx.peerCcid = peer;
    setCall(peer, {
      kind: "automated",
      direction: "outbound",
      startedAt: ctx.startedAt,
      primary: false,
      leadId: ctx.leadId,
      contactPhone: ctx.contactPhone,
      role: "bridge-on-answer",
      peerCcid: ccid,
      powerDialer: true,
    });
    if (lead) {
      logActivity(lead.id, {
        type: "call",
        direction: "outbound",
        channel: "voice",
        body: "Power Dialer human detected; ringing agent",
        status: "ringing-agent",
        meta: { detection: result || "human" },
      });
      powerDialerEventForLead(lead, { leadId: lead.id, status: "ringing-agent", outcome: result || "human", callControlId: ccid, peerCcid: peer });
    }
  } catch (err) {
    if (lead) logActivity(lead.id, { type: "call", direction: "outbound", channel: "voice", body: "Power Dialer agent ring failed", status: "failed:agent-ring", meta: { error: String(err) } });
    if (lead) powerDialerEventForLead(lead, { leadId: lead.id, status: "failed", outcome: "agent-ring-failed", callControlId: ccid, note: String(err) });
    await hangup(ccid).catch(() => {});
  }
}

async function handleGather(ccid: string, digits?: string): Promise<void> {
  const ctx = getCall(ccid);
  if (!ctx || ctx.kind !== "inbound") return;

  // app-then-cell opt-out gather: 9 = opt out, anything else (incl. no input) → ring app.
  if (ctx.stage === "optout-gather") {
    if (digits === "9") {
      if (ctx.contactPhone) await addToDnc(ctx.contactPhone, "ivr-optout");
      await speak(ccid, "You have been removed from our call list. Goodbye.");
      await hangup(ccid);
      return;
    }
    ctx.stage = "ringing-app";
    await startInboundAppThenCell(ccid);
    return;
  }

  if (digits === "1" && config.voice.myCell) {
    await transfer(ccid, config.voice.myCell); // forward to my cell
  } else if (digits === "9") {
    if (ctx.contactPhone) await addToDnc(ctx.contactPhone, "ivr-optout");
    await speak(ccid, "You have been removed from our call list. Goodbye.");
    await hangup(ccid);
  } else {
    await speak(ccid, "Sorry, I didn't catch that. Goodbye.");
    await hangup(ccid);
  }
}

async function handleHangup(ccid: string, p: any): Promise<void> {
  // Conference leg ending — agent leg drop ends the whole conference, else just that party.
  if (await onConfLegHangup(ccid)) return;
  // Inbound app/cell dial-out leg ending → may trigger fall-back to the cell.
  if (await onInboundLegHangup(ccid)) return;

  const ctx = getCall(ccid);
  if (ctx && ctx.primary && !ctx.logged) {
    ctx.logged = true;
    // "Connected" = a human (CRM app or cell) actually bridged. For inbound, answeredAt is
    // unreliable because WE auto-answer the leg just to route it — so a true no-answer would
    // still look "answered". connectedAt is set only on a real bridge, so it's what decides
    // answered vs missed (and the talk-time duration). Outbound legs have no connectedAt, so
    // they fall back to answeredAt as before.
    const connectedAt = ctx.direction === "inbound" ? ctx.connectedAt : ctx.answeredAt;
    const durationSec = connectedAt ? Math.max(0, Math.round((Date.now() - connectedAt) / 1000)) : 0;
    const status = connectedAt ? "completed" : String(p?.hangup_cause ?? "no-answer");
    // Record every inbound call in the Dialer's call log (answered vs missed).
    if (ctx.direction === "inbound") {
      const crmLead = ctx.contactPhone ? findLead({ phone: ctx.contactPhone }) : null;
      const nm = crmLead ? [crmLead.first_name, crmLead.last_name].filter(Boolean).join(" ") || null : null;
      insertCallLog({
        direction: "inbound",
        phone: ctx.contactPhone ?? null,
        name: nm,
        contactId: ctx.contactId ?? null,
        leadId: crmLead?.id ?? null,
        outcome: ctx.connectedAt ? "answered" : "missed",
        durationSec,
      });
    }
    if (ctx.direction === "outbound" && ctx.leadId) {
      const crmLead = getLead(ctx.leadId);
      const nm = crmLead ? leadDisplayName(crmLead) : null;
      const outcome = ctx.powerDialer
        ? ctx.connectedAt || ctx.peerCcid ? "answered" : ctx.powerDialerResult ? `amd-${ctx.powerDialerResult}` : status
        : status;
      insertCallLog({
        direction: "outbound",
        phone: ctx.contactPhone ?? null,
        name: nm,
        leadId: ctx.leadId,
        outcome,
        durationSec,
      });
      if (crmLead) {
        logActivity(crmLead.id, {
          type: "call",
          direction: "outbound",
          channel: "voice",
          body: `Outbound call to ${ctx.contactPhone || ""}`.trim(),
          status: outcome,
          meta: { powerDialer: Boolean(ctx.powerDialer), durationSec, hangupCause: p?.hangup_cause },
        });
        if (ctx.powerDialer) {
          powerDialerEventForLead(crmLead, {
            leadId: crmLead.id,
            status: "complete",
            outcome,
            callControlId: ccid,
            note: durationSec ? `${durationSec}s` : undefined,
          });
        }
      }
    }
    if (ctx.contactId) {
      try {
        const r = await logCall({ contactId: ctx.contactId, direction: ctx.direction, durationSec, status, contactPhone: ctx.contactPhone });
        recordCallLog({
          at: new Date().toISOString(),
          direction: ctx.direction,
          contactId: ctx.contactId,
          durationSec,
          status,
          loggedToGhl: r.ok,
          error: r.ok ? undefined : `${r.status ?? ""} ${r.detail ?? ""}`.trim(),
        });
        if (!r.ok) log.error("call NOT logged to GHL", { ccid, contactId: ctx.contactId, status: r.status, detail: r.detail });
      } catch (err) {
        recordCallLog({ at: new Date().toISOString(), direction: ctx.direction, contactId: ctx.contactId, durationSec, status, loggedToGhl: false, error: String(err) });
        log.error("logCall threw", { ccid, err: String(err) });
      }
    } else {
      // No contact resolved (e.g. blocked/anonymous caller) — recorded so it isn't invisible.
      recordCallLog({ at: new Date().toISOString(), direction: ctx.direction, durationSec, status, loggedToGhl: false, error: "no contactId (caller not resolved)" });
      log.warn("call not logged: no contactId", { ccid, direction: ctx.direction, status });
    }
    log.info("call ended", { ccid, kind: ctx.kind, direction: ctx.direction, durationSec, status });
  }
  if (ctx?.powerDialer && ctx.primary) finishPowerDialerLeg();
  delCall(ccid);
}
