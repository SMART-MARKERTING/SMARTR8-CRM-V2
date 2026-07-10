import { Direction } from "./ghl";

export type CallKind = "click" | "automated" | "inbound" | "conference";
export type CallRole =
  | "dial-peer-on-answer"
  | "bridge-on-answer"
  // Conference (3-way) legs: the agent leg that creates the conference on answer,
  // and any participant leg that joins the conference on answer.
  | "conf-agent-create"
  | "conf-join";

export interface CallContext {
  kind: CallKind;
  direction: Direction;
  startedAt: number; // epoch ms
  primary: boolean; // the leg we log against (carries contactId)
  contactId?: string;
  leadId?: string;
  contactPhone?: string;
  role?: CallRole;
  peerTarget?: string; // number to dial when role = dial-peer-on-answer
  peerFrom?: string; // caller ID to use when dialing peerTarget (smart routing)
  peerCcid?: string; // the bridged peer leg
  answeredAt?: number;
  /** Set ONLY when a human leg (CRM app or cell) actually bridges to the caller. Distinct
   *  from answeredAt, which fires when WE auto-answer the inbound leg just to route it —
   *  so this is what tells "answered" from "missed" for the inbound call log. */
  connectedAt?: number;
  stage?: string;
  logged?: boolean;
  // Inbound "app-then-cell" routing: the original inbound caller leg this dial-out
  // is trying to reach, the stage of the fallback chain, and whether it's bridged.
  inboundCcid?: string; // the caller's leg (set on app/cell dial legs)
  fallbackStage?: "ringing-app" | "ringing-cell" | "bridged";
  triedCell?: boolean;
  noCellFallback?: boolean; // when call-forwarding is OFF: ring the app only, never the cell
  // Conference (3-way) routing: the session name this leg belongs to, and (for the
  // agent-create leg) the first participant to dial once the conference exists.
  confName?: string;
  joinPhone?: string;
  powerDialer?: boolean;
  powerDialerResult?: string;
}

// In-memory call context, keyed by Telnyx call_control_id. Calls are short-lived;
// fine for this volume (lost on restart, which only affects calls mid-flight).
const calls = new Map<string, CallContext>();

export function setCall(ccid: string, ctx: CallContext): void {
  calls.set(ccid, ctx);
}
export function getCall(ccid: string): CallContext | undefined {
  return calls.get(ccid);
}
export function listCalls(): Array<{ ccid: string; ctx: CallContext }> {
  return Array.from(calls.entries()).map(([ccid, ctx]) => ({ ccid, ctx }));
}
export function delCall(ccid: string): void {
  calls.delete(ccid);
}
