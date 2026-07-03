import { config } from "../config";
import { log } from "../logger";
import { toE164 } from "../util/phone";
import { isOnDnc } from "./dnc";
import { placeCallWithAmd, playAudio, hangup } from "./telnyxVoice";
import { defaultFrom, pickFromNumber } from "./numbers";
import { logActivity } from "./leads";
import { getDefaultVoicemailAudioUrl } from "./voicemailSettings";

/**
 * Ringless-style voicemail drop via Telnyx Answering Machine Detection:
 *   1. Place an AMD call to the contact (DNC-gated).
 *   2. On `call.machine.detection.ended` → if a machine/voicemail is detected, play the
 *      pre-recorded audio; if a human answers, hang up (don't bother a person).
 *   3. On `call.playback.ended` → hang up.
 * The terminal outcome is logged to the lead's timeline (when leadId is known).
 *
 * NOTE: this leaves a voicemail by calling and detecting the greeting — it is NOT a
 * true carrier ringless injection, so the phone may briefly ring. Compliance gates
 * (DNC + calling-hours) are enforced by the caller (the automation step).
 */
interface VmCall {
  phone: string;
  leadId?: string;
  audioUrl: string;
  played: boolean;
  startedAt: number;
}
const vmCalls = new Map<string, VmCall>();

export function voicemailConfigured(audioUrl = getDefaultVoicemailAudioUrl()): boolean {
  return Boolean(audioUrl && config.voice.applicationId && config.telnyx.apiKey && defaultFrom());
}

export type DropResult =
  | { ok: true; ccid: string }
  | { skipped: true; reason: string }
  | { error: string };

/** Initiate a voicemail drop. The audio plays asynchronously when AMD reports a machine. */
export async function dropVoicemail(opts: { phone: string; leadId?: string; from?: string; audioUrl?: string }): Promise<DropResult> {
  const audioUrl = opts.audioUrl || getDefaultVoicemailAudioUrl();
  if (!audioUrl) return { skipped: true, reason: "voicemail audio not set" };
  if (!config.voice.applicationId) return { skipped: true, reason: "TELNYX_VOICE_APP_ID or TELNYX_CONNECTION_ID not set" };
  if (!defaultFrom()) return { skipped: true, reason: "TELNYX_FROM_NUMBER or TELNYX_NUMBERS not set" };
  const to = toE164(opts.phone);
  if (!to) return { skipped: true, reason: "no phone" };
  if (await isOnDnc(to)) return { skipped: true, reason: "on-DNC" };

  const from = opts.from || pickFromNumber(to).from;
  try {
    const ccid = await placeCallWithAmd(to, from);
    vmCalls.set(ccid, { phone: to, leadId: opts.leadId, audioUrl, played: false, startedAt: Date.now() });
    log.info("voicemail drop placed", { to, ccid, from });
    return { ok: true, ccid };
  } catch (err) {
    log.error("voicemail drop failed to place", { to, err: String(err) });
    return { error: String(err) };
  }
}

export function isVoicemailCall(ccid?: string): boolean {
  return Boolean(ccid && vmCalls.has(ccid));
}

/** Handle Telnyx voice events for a voicemail-drop leg (called from the voice webhook). */
export async function handleVoicemailEvent(type: string | undefined, p: any): Promise<void> {
  const ccid = p?.call_control_id as string;
  const vm = vmCalls.get(ccid);
  if (!vm) return;

  try {
    if (type === "call.answered") {
      // Wait for AMD to classify the answerer before doing anything.
      return;
    }

    if (isMachineGreetingEnded(type)) {
      await playVoicemail(ccid, vm);
      return;
    }

    if (isMachineDetectionEnded(type)) {
      const result = String(p?.result ?? "").toLowerCase();
      if (isMachineResult(result)) {
        if (waitsForGreetingEnd()) {
          log.info("voicemail: machine detected, waiting for greeting end", { ccid, to: vm.phone, result });
        } else {
          await playVoicemail(ccid, vm);
        }
      } else if (result) {
        // Human / not_sure / silence — don't leave a robo-drop on a live person.
        log.info("voicemail: no machine, hanging up", { ccid, to: vm.phone, result });
        finalize(ccid, `no-drop (${result || "unknown"})`);
        await hangup(ccid).catch(() => {});
      } else {
        log.warn("voicemail: machine detection ended without a result", { ccid, to: vm.phone, raw: p });
      }
      return;
    }

    if (type === "call.playback.ended") {
      finalize(ccid, "voicemail-left");
      await hangup(ccid).catch(() => {});
      return;
    }

    if (type === "call.hangup") {
      // Terminal: if we never logged an outcome, record one now.
      finalize(ccid, vm.played ? "voicemail-left" : "no-answer");
      return;
    }
  } catch (err) {
    log.error("voicemail event handler error", { type, ccid, err: String(err) });
    finalize(ccid, `error: ${String(err)}`);
  }
}

function isMachineDetectionEnded(type?: string): boolean {
  return type === "call.machine.detection.ended" || type === "call.machine.premium.detection.ended";
}

function isMachineGreetingEnded(type?: string): boolean {
  return type === "call.machine.greeting.ended" || type === "call.machine.premium.greeting.ended";
}

function isMachineResult(result: string): boolean {
  return ["machine", "voicemail", "answering_machine", "fax_detected"].includes(result);
}

function waitsForGreetingEnd(): boolean {
  return ["greeting_end", "detect_beep", "detect_words"].includes(String(config.voice.amdMode || "").toLowerCase());
}

async function playVoicemail(ccid: string, vm: VmCall): Promise<void> {
  if (vm.played) return;
  vm.played = true;
  await playAudio(ccid, vm.audioUrl);
  log.info("voicemail: playing message", { ccid, to: vm.phone, audioUrl: vm.audioUrl });
}

/** Log the outcome on the lead's timeline (once) and drop the in-memory state. */
function finalize(ccid: string, status: string): void {
  const vm = vmCalls.get(ccid);
  if (!vm) return;
  vmCalls.delete(ccid);
  if (vm.leadId) {
    logActivity(vm.leadId, {
      type: "voicemail",
      direction: "outbound",
      channel: "voice",
      body: `Voicemail drop to ${vm.phone}`,
      status,
    });
  }
  log.info("voicemail drop finalized", { ccid, to: vm.phone, status });
}
