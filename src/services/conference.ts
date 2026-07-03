import { config } from "../config";
import { log } from "../logger";
import { toE164 } from "../util/phone";
import { checkManualCall } from "./compliance";
import { placeCall, createConference, joinConference, hangup } from "./telnyxVoice";
import { setCall, getCall, delCall } from "./callState";
import { pickFromNumber } from "./numbers";
import { findLead, logActivity } from "./leads";

/**
 * Server-side 3-way (and N-way) conferencing via Telnyx Call Control.
 *
 * A 1:1 bridge can't hold a third party, so we use a Telnyx conference. The agent joins
 * via their cell (exactly like click-to-call): we ring the cell first, and on answer we
 * create the conference and dial the first participant into it. "Add caller" dials more
 * participants into the same live conference. DNC is enforced on every dialed number;
 * consent/hours are exempt because a human is placing each call.
 */

export type ConfLegStatus = "dialing" | "joined" | "ended";
interface ConfLeg {
  ccid: string;
  phone: string;
  status: ConfLegStatus;
  isAgent?: boolean;
}
interface ConfSession {
  name: string;
  confId?: string; // Telnyx conference id (set once the agent answers)
  agentCcid: string;
  contactId?: string;
  legs: ConfLeg[];
  createdAt: number;
}

// In-memory; conferences are short-lived (lost on restart, which only affects calls
// mid-flight — same tradeoff as callState).
const sessions = new Map<string, ConfSession>(); // name -> session
const ccidToName = new Map<string, string>(); // any participant leg ccid -> conf name

function genName(): string {
  return `conf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export type ConfResult =
  | { ok: true; name: string }
  | { skipped: true; reason?: string }
  | { error: string; status: number };

/** Dial a participant and register a conf-join leg that joins the conference on answer. */
async function dialParticipant(session: ConfSession, phone: string): Promise<string> {
  const e164 = toE164(phone);
  const pick = pickFromNumber(e164); // smart caller-ID matching the dialed area code
  const ccid = await placeCall(e164, pick.from);
  session.legs.push({ ccid, phone: e164, status: "dialing" });
  ccidToName.set(ccid, session.name);
  setCall(ccid, {
    kind: "conference",
    direction: "outbound",
    startedAt: Date.now(),
    primary: false,
    contactPhone: e164,
    role: "conf-join",
    confName: session.name,
  });
  return ccid;
}

/**
 * Start a conference: ring the agent's cell. On answer (handled in the voice webhook via
 * onConfLegAnswered) we create the conference and dial the first participant.
 */
export async function startConference(input: { phone?: string; contactId?: string }): Promise<ConfResult> {
  if (!input.phone) return { error: "pass a phone number to call", status: 400 };
  if (!config.voice.myCell) return { error: "MY_CELL_NUMBER not set", status: 500 };
  const e164 = toE164(input.phone);
  const gate = await checkManualCall(e164);
  if (!gate.allowed) {
    log.warn("conference start SKIPPED", { phone: e164, reason: gate.reason });
    return { skipped: true, reason: gate.reason };
  }

  const name = genName();
  const agentCcid = await placeCall(config.voice.myCell); // ring the agent first
  const session: ConfSession = {
    name,
    agentCcid,
    contactId: input.contactId,
    createdAt: Date.now(),
    legs: [{ ccid: agentCcid, phone: config.voice.myCell, status: "dialing", isAgent: true }],
  };
  sessions.set(name, session);
  ccidToName.set(agentCcid, name);
  setCall(agentCcid, {
    kind: "conference",
    direction: "outbound",
    startedAt: Date.now(),
    primary: true,
    contactId: input.contactId,
    contactPhone: e164,
    role: "conf-agent-create",
    confName: name,
    joinPhone: e164, // dial this participant once the conference exists
  });
  // Thread a note onto the contact's CRM lead, if we recognize the number.
  const lead = findLead({ phone: e164 });
  if (lead) {
    logActivity(lead.id, { type: "call", direction: "outbound", channel: "voice", body: `Conference call started with ${e164}`, status: "initiated" });
  }
  log.info("conference: ringing agent", { name, agentCcid, firstParticipant: e164 });
  return { ok: true, name };
}

/**
 * Seed a conference from an EXISTING call leg — the browser's active WebRTC call, whose
 * call_control_id the SDK exposes. The agent stays on their current call (no cell ring); we
 * just create a conference on that leg and dial the added party in. This powers the dialer's
 * "Add caller" merge button.
 */
export async function startConferenceFromCall(input: { agentCcid?: string; phone?: string; contactId?: string }): Promise<ConfResult> {
  if (!input.agentCcid) return { error: "no active call to add to", status: 400 };
  if (!input.phone) return { error: "pass a phone number to add", status: 400 };
  const e164 = toE164(input.phone);
  const gate = await checkManualCall(e164);
  if (!gate.allowed) {
    log.warn("conference (from call) SKIPPED", { phone: e164, reason: gate.reason });
    return { skipped: true, reason: gate.reason };
  }
  const name = genName();
  const session: ConfSession = {
    name,
    agentCcid: input.agentCcid,
    contactId: input.contactId,
    createdAt: Date.now(),
    legs: [{ ccid: input.agentCcid, phone: "you", status: "joined", isAgent: true }],
  };
  sessions.set(name, session);
  ccidToName.set(input.agentCcid, name);
  try {
    // The WebRTC leg is already answered/active, so the conference can be created on it now.
    session.confId = await createConference(name, input.agentCcid);
  } catch (err) {
    sessions.delete(name);
    ccidToName.delete(input.agentCcid);
    log.error("conference: create-from-call failed", { agentCcid: input.agentCcid, err: String(err) });
    return { error: `couldn't start the conference: ${String(err)}`, status: 502 };
  }
  await dialParticipant(session, e164);
  log.info("conference: seeded from active call", { name, agentCcid: input.agentCcid, add: e164 });
  return { ok: true, name };
}

/** Add another caller to a live conference (dials them and joins on answer). */
export async function addToConference(name: string, phone: string): Promise<ConfResult> {
  const session = sessions.get(name);
  if (!session) return { error: "conference not found (it may have ended)", status: 404 };
  if (!phone) return { error: "pass a phone number to add", status: 400 };
  if (!session.confId) return { error: "conference is still connecting — try again in a moment", status: 409 };
  const e164 = toE164(phone);
  const gate = await checkManualCall(e164);
  if (!gate.allowed) {
    log.warn("conference add SKIPPED", { phone: e164, reason: gate.reason });
    return { skipped: true, reason: gate.reason };
  }
  await dialParticipant(session, e164);
  log.info("conference: dialing added participant", { name, phone: e164 });
  return { ok: true, name };
}

/** Hang up every leg of the conference and clear its session. */
async function endConference(session: ConfSession): Promise<void> {
  for (const leg of session.legs) {
    if (leg.status !== "ended") {
      try {
        await hangup(leg.ccid);
      } catch {
        /* leg may already be gone */
      }
    }
    ccidToName.delete(leg.ccid);
    delCall(leg.ccid);
  }
  sessions.delete(session.name);
}

/** End a conference on request (hangs everyone up). */
export async function hangupConference(name: string): Promise<{ ok: boolean }> {
  const session = sessions.get(name);
  if (!session) return { ok: true };
  await endConference(session);
  return { ok: true };
}

export interface ConfStatus {
  found: boolean;
  confId?: string;
  participants?: { phone: string; status: ConfLegStatus; isAgent?: boolean }[];
}

export function getConferenceStatus(name: string): ConfStatus {
  const s = sessions.get(name);
  if (!s) return { found: false };
  return {
    found: true,
    confId: s.confId,
    participants: s.legs
      .filter((l) => l.status !== "ended")
      .map((l) => ({ phone: l.phone, status: l.status, isAgent: l.isAgent })),
  };
}

// ── Voice-webhook hooks (called from the Telnyx voice event handler) ─────────

/**
 * A conference leg answered. Returns true if we handled it (so the generic handler
 * stops). Agent-create leg → create the conference + dial the first participant;
 * participant leg → join the conference.
 */
export async function onConfLegAnswered(ccid: string): Promise<boolean> {
  const ctx = getCall(ccid);
  if (!ctx || ctx.kind !== "conference" || !ctx.confName) return false;
  const session = sessions.get(ctx.confName);
  if (!session) return true; // belongs to a conference that already ended — swallow
  const leg = session.legs.find((l) => l.ccid === ccid);

  if (ctx.role === "conf-agent-create") {
    try {
      const confId = await createConference(session.name, ccid);
      session.confId = confId;
      if (leg) leg.status = "joined";
      log.info("conference: created, agent joined", { name: session.name, confId });
      if (ctx.joinPhone) await dialParticipant(session, ctx.joinPhone);
    } catch (err) {
      log.error("conference: create failed", { name: session.name, err: String(err) });
      await endConference(session);
    }
    return true;
  }

  if (ctx.role === "conf-join") {
    if (!session.confId) {
      log.warn("conference: participant answered before conference existed", { ccid });
      return true;
    }
    try {
      await joinConference(session.confId, ccid);
      if (leg) leg.status = "joined";
      log.info("conference: participant joined", { name: session.name, ccid });
    } catch (err) {
      log.error("conference: join failed", { name: session.name, ccid, err: String(err) });
    }
    return true;
  }
  return false;
}

/**
 * A conference leg hung up. Returns true if it belonged to a conference. If the AGENT
 * leg drops, the whole conference ends; otherwise just that participant leaves.
 */
export async function onConfLegHangup(ccid: string): Promise<boolean> {
  const name = ccidToName.get(ccid);
  if (!name) return false;
  const session = sessions.get(name);
  ccidToName.delete(ccid);
  delCall(ccid);
  if (!session) return true;
  const leg = session.legs.find((l) => l.ccid === ccid);
  if (leg) leg.status = "ended";
  if (ccid === session.agentCcid) {
    log.info("conference: agent hung up → ending conference", { name });
    await endConference(session);
    return true;
  }
  log.info("conference: participant left", { name, ccid });
  return true;
}
