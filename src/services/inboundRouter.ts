import { config } from "../config";
import { log } from "../logger";
import { getCall, setCall, delCall } from "./callState";
import { dialLeg, answer, bridge, hangup, speak } from "./telnyxVoice";
import { getWebrtcSipUri } from "./telnyxWebrtc";
import { getMeta, setMeta } from "../store/db";

// ── Call forwarding toggle (persisted; flipped from the dialer) ──────────────
// When OFF, inbound calls ring the CRM portal only and never forward to the cell.
// When ON (default), the business-hours window below governs the cell forward.
export function isForwardingEnabled(): boolean {
  return getMeta("call_forwarding_enabled") !== "0";
}
export function setForwarding(on: boolean): void {
  setMeta("call_forwarding_enabled", on ? "1" : "0");
}

/** True during the configured business-hours window (Mon–Fri 9–5 by default, in FORWARD_TZ). */
export function withinForwardWindow(): boolean {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: config.inbound.forwardTz,
      weekday: "short",
      hour: "numeric",
      hour12: false,
    }).formatToParts(new Date());
    const wd = parts.find((p) => p.type === "weekday")?.value || "";
    const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
    const dayNum = ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as Record<string, number>)[wd] || 0;
    const days = config.inbound.forwardDays.split(",").map((d) => parseInt(d.trim(), 10));
    const h = hour === 24 ? 0 : hour;
    return days.includes(dayNum) && h >= config.inbound.forwardStart && h < config.inbound.forwardEnd;
  } catch {
    return true; // fail open — don't strand a caller on a tz parsing error
  }
}

// Last inbound routing decisions, surfaced on /calls/diag so the app-ring path is
// debuggable from the browser (no Render log digging).
interface InboundTrace { at: string; step: string; detail?: string }
const inboundTrace: InboundTrace[] = [];
export function traceInbound(step: string, detail?: string): void {
  inboundTrace.unshift({ at: new Date().toISOString(), step, detail });
  if (inboundTrace.length > 20) inboundTrace.pop();
}
export function getInboundTrace(): InboundTrace[] {
  return inboundTrace;
}

/**
 * Inbound "app-then-cell" routing (Call Control).
 *
 * Flow: caller dials in → we answer → ring the WebRTC app (sip:) with a ring
 * timeout → if the app answers, bridge. If the app leg ends without answering
 * (no app connected, declined, or timed out), dial the cell and bridge that.
 *
 * Each outbound leg carries inboundCcid (the caller) + fallbackStage so the
 * shared call.answered / call.hangup handlers know what to do. The caller's own
 * context holds triedCell so we only fall back once.
 */

/** Caller just connected: start ringing the app. Falls straight to cell if no app URI. */
export async function startInboundAppThenCell(inboundCcid: string): Promise<void> {
  // During business hours (9-5 Mon-Fri, FORWARD_* config) ring the CRM portal first (~5
  // rings) then forward to the cell on no-answer. OUTSIDE business hours, go straight to the
  // cell (the CRM isn't staffed). The cell forward ALWAYS happens — no toggle gating.
  if (!withinForwardWindow()) {
    traceInbound("off-hours", "outside business hours -> straight to cell");
    log.info("inbound: outside business hours — straight to cell", { inboundCcid });
    await ringCell(inboundCcid);
    return;
  }
  const sipUri = await getWebrtcSipUri();
  if (!sipUri) {
    // No portal to ring (WebRTC not registered / SIP-URI calling disabled). Don't strand
    // the caller — forward straight to the cell.
    traceInbound("no-sip-uri", "getWebrtcSipUri null — straight to cell");
    log.warn("inbound: no WebRTC SIP uri — going straight to cell", { inboundCcid });
    await ringCell(inboundCcid);
    return;
  }
  // The cell fallback is always allowed now (every call forwards on no-answer).
  const callerCtx = getCall(inboundCcid);
  if (callerCtx) callerCtx.noCellFallback = false;
  try {
    // Show the ACTUAL caller's number on the console (not our own 619). Telnyx may
    // reject an unowned `from` (403 D35); if so, retry with the owned number so the
    // call STILL rings (worst case the console shows our default number).
    const callerNum = getCall(inboundCcid)?.contactPhone;
    let appLeg: string;
    try {
      traceInbound("ringing-app", `dialing ${sipUri} as ${callerNum ?? "default"} for ${config.inbound.appRingSecs}s`);
      appLeg = await dialLeg(sipUri, { timeoutSecs: config.inbound.appRingSecs, from: callerNum });
    } catch (e) {
      traceInbound("ringing-app-retry", `caller-id ${callerNum} rejected, retrying with default: ${String(e)}`);
      appLeg = await dialLeg(sipUri, { timeoutSecs: config.inbound.appRingSecs });
    }
    setCall(appLeg, {
      kind: "inbound",
      direction: "inbound",
      startedAt: Date.now(),
      primary: false,
      inboundCcid,
      role: "bridge-on-answer",
      fallbackStage: "ringing-app",
    });
    const caller = getCall(inboundCcid);
    if (caller) caller.peerCcid = appLeg;
    log.info("inbound: ringing app", { inboundCcid, appLeg, sipUri, ringSecs: config.inbound.appRingSecs });
  } catch (err) {
    traceInbound("app-dial-failed", `${sipUri} -> ${String(err)}`);
    log.warn("inbound: app dial failed — falling back to cell", { inboundCcid, err: String(err) });
    await ringCell(inboundCcid);
  }
}

/** Dial the cell and bridge on answer. Marked so we never loop back to it twice. */
export async function ringCell(inboundCcid: string): Promise<void> {
  const caller = getCall(inboundCcid);
  if (caller) caller.triedCell = true;
  if (!config.voice.myCell) {
    log.warn("inbound: MY_CELL_NUMBER not set — cannot fall back", { inboundCcid });
    try {
      await speak(inboundCcid, "Sorry, no one is available to take your call right now. Goodbye.");
    } catch {}
    await hangup(inboundCcid).catch(() => {});
    return;
  }
  try {
    traceInbound("ringing-cell", config.voice.myCell);
    const cellLeg = await dialLeg(config.voice.myCell, { timeoutSecs: config.inbound.cellRingSecs });
    setCall(cellLeg, {
      kind: "inbound",
      direction: "inbound",
      startedAt: Date.now(),
      primary: false,
      inboundCcid,
      role: "bridge-on-answer",
      fallbackStage: "ringing-cell",
    });
    if (caller) caller.peerCcid = cellLeg;
    log.info("inbound: ringing cell", { inboundCcid, cellLeg });
  } catch (err) {
    log.error("inbound: cell dial failed", { inboundCcid, err: String(err) });
    await hangup(inboundCcid).catch(() => {});
  }
}

/** An app/cell leg was answered → bridge it to the caller. Returns true if handled. */
export async function onInboundLegAnswered(answeredCcid: string): Promise<boolean> {
  const leg = getCall(answeredCcid);
  if (!leg || leg.role !== "bridge-on-answer" || !leg.inboundCcid) return false;
  leg.fallbackStage = "bridged";
  leg.answeredAt = Date.now();
  const caller = getCall(leg.inboundCcid);
  if (caller) {
    caller.answeredAt = Date.now();
    caller.connectedAt = Date.now(); // a human actually picked up → "answered" for the call log
    caller.peerCcid = answeredCcid;
  }
  try {
    await bridge(answeredCcid, leg.inboundCcid);
    log.info("inbound: bridged", { answeredCcid, inboundCcid: leg.inboundCcid, stage: leg.fallbackStage });
  } catch (err) {
    log.error("inbound: bridge failed", { answeredCcid, err: String(err) });
  }
  return true;
}

/**
 * An app/cell leg hung up. If it was the APP leg and never bridged (no answer /
 * declined / timeout) and we haven't tried the cell yet, fall back to the cell.
 * Returns true if this hangup belonged to an inbound dial-out leg.
 */
export async function onInboundLegHangup(hungCcid: string): Promise<boolean> {
  const leg = getCall(hungCcid);
  if (!leg || !leg.inboundCcid) return false;
  const caller = getCall(leg.inboundCcid);
  const wasBridged = leg.fallbackStage === "bridged";
  const wasApp = leg.fallbackStage === "ringing-app";
  delCall(hungCcid);

  if (!caller) return true; // caller already gone; nothing to do
  if (wasBridged) {
    // Normal end of a connected call → tear down the caller leg too.
    await hangup(leg.inboundCcid).catch(() => {});
    return true;
  }
  if (wasApp && !caller.triedCell) {
    if (caller.noCellFallback) {
      // Forwarding is OFF — don't bounce to the cell; end the call after the portal ring.
      log.info("inbound: app unanswered & forwarding off — ending (portal-only)", { inboundCcid: leg.inboundCcid });
      await speak(leg.inboundCcid, "Sorry, we missed your call. Please try again later. Goodbye.").catch(() => {});
      await hangup(leg.inboundCcid).catch(() => {});
      return true;
    }
    log.info("inbound: app leg ended unanswered — falling back to cell", { inboundCcid: leg.inboundCcid });
    await ringCell(leg.inboundCcid);
    return true;
  }
  // Cell leg ended unanswered (or app ended after cell already tried) → give up.
  log.info("inbound: no answer on fallback — hanging up caller", { inboundCcid: leg.inboundCcid });
  await hangup(leg.inboundCcid).catch(() => {});
  return true;
}
