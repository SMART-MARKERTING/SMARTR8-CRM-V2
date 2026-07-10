import { config } from "../config";
import { log } from "../logger";

const VOICE_BASE = `${config.telnyx.apiBase}/v2`;

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${config.telnyx.apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function voicePost(p: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${VOICE_BASE}${p}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  const raw = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`Telnyx voice ${p} failed ${res.status}: ${raw}`);
  // Keep raw Telnyx responses in the logs.
  log.info(`telnyx voice ${p} ok`, { raw });
  return raw ? JSON.parse(raw) : {};
}

/** Place an outbound call via the Voice API Application. Returns call_control_id. */
export async function placeCall(to: string, from = config.telnyx.fromNumber): Promise<string> {
  const data = await voicePost("/calls", {
    connection_id: config.voice.applicationId,
    to,
    from,
  });
  return data?.data?.call_control_id as string;
}

/**
 * Place an outbound call with Answering Machine Detection (for voicemail drops).
 * Telnyx emits `call.machine.detection.ended` (result: human|machine|not_sure|silence)
 * — on "machine" we play the pre-recorded message, otherwise we hang up. Returns ccid.
 */
export async function placeCallWithAmd(
  to: string,
  from = config.telnyx.fromNumber,
  opts: { timeoutSecs?: number; amdMode?: string } = {},
): Promise<string> {
  const body: Record<string, unknown> = {
    connection_id: config.voice.applicationId,
    to,
    from,
    answering_machine_detection: opts.amdMode || config.voice.amdMode,
  };
  if (opts.timeoutSecs) body.timeout_secs = opts.timeoutSecs;
  const data = await voicePost("/calls", body);
  return data?.data?.call_control_id as string;
}

/** Play an audio file (public URL) into a call leg. Emits `call.playback.ended`. */
export async function playAudio(ccid: string, audioUrl: string): Promise<void> {
  await voicePost(`/calls/${ccid}/actions/playback_start`, { audio_url: audioUrl });
}

/**
 * Dial a target (PSTN number OR a sip: URI for the WebRTC app) with an optional
 * ring timeout, so an unanswered app leg can fall through to the cell.
 * `to` like "sip:user@sip.telnyx.com" rings the registered softphone.
 */
export async function dialLeg(
  to: string,
  opts: { from?: string; timeoutSecs?: number } = {},
): Promise<string> {
  const body: Record<string, unknown> = {
    connection_id: config.voice.applicationId,
    to,
    from: opts.from ?? config.telnyx.fromNumber,
  };
  if (opts.timeoutSecs) body.timeout_secs = opts.timeoutSecs;
  const data = await voicePost("/calls", body);
  return data?.data?.call_control_id as string;
}

export async function answer(ccid: string): Promise<void> {
  await voicePost(`/calls/${ccid}/actions/answer`, {});
}

export async function hangup(ccid: string): Promise<void> {
  await voicePost(`/calls/${ccid}/actions/hangup`, {});
}

export async function bridge(ccid: string, otherCcid: string): Promise<void> {
  await voicePost(`/calls/${ccid}/actions/bridge`, { call_control_id: otherCcid });
}

/**
 * Create a conference with an already-answered call as the first participant, and
 * return the conference id. Additional answered calls are added with joinConference().
 * This is how we do reliable 3-way calling (a 1:1 bridge can't hold a third party).
 */
export async function createConference(name: string, ccid: string): Promise<string> {
  const data = await voicePost(`/conferences`, { name, call_control_id: ccid, beep_enabled: "never" });
  return data?.data?.id as string;
}

/** Join an already-answered call into an existing conference. */
export async function joinConference(
  conferenceId: string,
  ccid: string,
  opts: { supervisorRole?: "barge" | "monitor" | "none" | "whisper" } = {},
): Promise<void> {
  const body: Record<string, unknown> = { call_control_id: ccid, beep_enabled: "never" };
  if (opts.supervisorRole) body.supervisor_role = opts.supervisorRole;
  await voicePost(`/conferences/${conferenceId}/actions/join`, body);
}

export async function updateConferenceParticipant(
  conferenceId: string,
  ccid: string,
  supervisorRole: "barge" | "monitor" | "none" | "whisper",
): Promise<void> {
  await voicePost(`/conferences/${conferenceId}/actions/update`, {
    call_control_id: ccid,
    supervisor_role: supervisorRole,
  });
}

export async function leaveConference(conferenceId: string, ccid: string): Promise<void> {
  await voicePost(`/conferences/${conferenceId}/actions/leave`, {
    call_control_id: ccid,
    beep_enabled: "never",
  });
}

export async function transfer(ccid: string, to: string, from = config.telnyx.fromNumber): Promise<void> {
  await voicePost(`/calls/${ccid}/actions/transfer`, { to, from });
}

export async function speak(ccid: string, text: string): Promise<void> {
  await voicePost(`/calls/${ccid}/actions/speak`, {
    payload: text,
    voice: "female",
    language: "en-US",
  });
}

/**
 * Read-only diagnostics (no call placed). Verifies the API key can see the
 * Voice API Application, that it has an outbound voice profile + the bridge
 * webhook URL set, and that the from-number is on the account and assigned to
 * that app — the usual reasons an outbound call 403s or never bridges.
 */
export async function voiceDiag(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  try {
    const res = await fetch(`${VOICE_BASE}/call_control_applications/${config.voice.applicationId}`, {
      headers: headers(),
    });
    const body: any = res.ok ? await res.json().catch(() => ({})) : {};
    const app = body?.data;
    out.voiceApp = {
      status: res.status, // 200 ok · 401 bad key · 403 key lacks permission · 404 wrong app id
      ok: res.ok,
      outboundVoiceProfileId: app?.outbound?.outbound_voice_profile_id ?? null, // null → outbound calls fail
      webhookUrl: app?.webhook_event_url ?? null, // must end in /webhooks/telnyx-voice for the bridge
    };
  } catch (err) {
    out.voiceApp = { error: String(err) };
  }
  try {
    const url = `${VOICE_BASE}/phone_numbers?filter[phone_number]=${encodeURIComponent(config.telnyx.fromNumber)}`;
    const res = await fetch(url, { headers: headers() });
    const body: any = res.ok ? await res.json().catch(() => ({})) : {};
    const rec = body?.data?.[0];
    out.fromNumber = {
      status: res.status,
      found: Boolean(rec),
      connectionId: rec?.connection_id ?? null,
      // false → the from-number isn't assigned to the Voice App (common outbound 403/422 cause)
      matchesVoiceApp: rec?.connection_id ? String(rec.connection_id) === String(config.voice.applicationId) : null,
    };
  } catch (err) {
    out.fromNumber = { error: String(err) };
  }
  return out;
}

/** Speak a prompt and collect a single DTMF digit (emits call.gather.ended). */
export async function gatherDigits(
  ccid: string,
  text: string,
  opts: { validDigits?: string; timeoutMs?: number } = {},
): Promise<void> {
  const body: Record<string, unknown> = {
    payload: text,
    voice: "female",
    language: "en-US",
    valid_digits: opts.validDigits ?? "19",
    max: 1,
    inter_digit_timeout_millis: 5000,
  };
  // Short overall wait so an unanswered prompt proceeds quickly (app-mode opt-out).
  if (opts.timeoutMs) body.timeout_millis = opts.timeoutMs;
  await voicePost(`/calls/${ccid}/actions/gather_using_speak`, body);
}
