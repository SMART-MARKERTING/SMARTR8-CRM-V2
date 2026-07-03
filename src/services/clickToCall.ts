import { config } from "../config";
import { log } from "../logger";
import { toE164 } from "../util/phone";
import { getContact, upsertContact } from "./ghl";
import { checkManualCall } from "./compliance";
import { placeCall } from "./telnyxVoice";
import { setCall } from "./callState";
import { pickFromNumber } from "./numbers";

export type ClickResult =
  | { ok: true; callControlId: string; contact: string }
  | { skipped: true; reason?: string }
  | { error: string; status: number };

/**
 * Agent-first click-to-call: ring your cell, then dial the contact and bridge.
 * DNC gate applies (it's an outbound call); consent + hours are exempt because a
 * human is placing an individual call. Shared by the HTTP endpoints and the
 * call-now tag poller.
 */
export async function startClickToCall(input: { contactId?: string; phone?: string }): Promise<ClickResult> {
  let phone: string | undefined;
  let contactId: string | undefined;
  if (input.contactId) {
    const c = await getContact(input.contactId);
    phone = c.phone;
    contactId = c.id;
  } else if (input.phone) {
    phone = input.phone;
    const c = await upsertContact(toE164(input.phone));
    contactId = c.id;
  }
  if (!phone) return { error: "pass contactId or phone", status: 400 };

  const e164 = toE164(phone);
  const gate = await checkManualCall(e164);
  if (!gate.allowed) {
    log.warn("click-to-call SKIPPED", { phone: e164, reason: gate.reason });
    return { skipped: true, reason: gate.reason };
  }
  if (!config.voice.myCell) return { error: "MY_CELL_NUMBER not set", status: 500 };

  // Smart caller-ID: dial the contact from a number matching their area code/state.
  const pick = pickFromNumber(e164);
  const ccid = await placeCall(config.voice.myCell); // ring agent first
  setCall(ccid, {
    kind: "click",
    direction: "outbound",
    startedAt: Date.now(),
    primary: true,
    contactId,
    contactPhone: e164,
    role: "dial-peer-on-answer",
    peerTarget: e164,
    peerFrom: pick.from, // caller ID shown to the contact
    stage: "ringing-agent",
  });
  log.info("click-to-call placed (ringing agent, will bridge to contact)", { contactId, contact: e164, ccid, from: pick.from, route: pick.reason });
  return { ok: true, callControlId: ccid, contact: e164 };
}
