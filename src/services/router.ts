import { toE164 } from "../util/phone";
import { sendImessage, sendImessageAttachment } from "./bluebubbles";
import { sendSms, sendMms } from "./telnyx";
import { pickFromNumber } from "./numbers";
import { isOnDnc } from "./dnc";
import { config } from "../config";
import { getMeta, setMeta } from "../store/db";
import { log } from "../logger";

export type SendPath =
  | "imessage-success"
  | "imessage-timeout"
  | "imessage-failed"
  | "fellback-to-sms"
  | "sms-failed"
  | "suppressed-dnc";

export type MessagingMode = "auto" | "sms" | "imessage";

/**
 * Effective outbound texting mode. A console toggle (stored in DB meta) wins over the
 * MESSAGING_MODE env default, so the loan officer can flip to SMS-only without a redeploy.
 * "sms" = always Telnyx SMS, "imessage" = always try iMessage first, "auto" = iMessage-first
 * with automatic SMS fallback when BlueBubbles is unreachable.
 */
export function getMessagingMode(): MessagingMode {
  const m = (getMeta("messaging_mode") || config.messagingMode || "").toLowerCase();
  return m === "sms" || m === "imessage" ? m : "auto";
}

/** Persist the outbound texting mode (console toggle). */
export function setMessagingMode(mode: MessagingMode): void {
  setMeta("messaging_mode", mode);
}

export interface SendResult {
  path: SendPath;
  /** Whether to mark the GHL message delivered. */
  ok: boolean;
  detail: string;
}

function telnyxConfigProblem(from: string): string | null {
  if (!config.telnyx.apiKey) return "Telnyx SMS not configured: missing TELNYX_API_KEY";
  if (!from) return "Telnyx SMS not configured: missing TELNYX_FROM_NUMBER or TELNYX_NUMBERS";
  return null;
}

/**
 * iMessage-first with automatic, silent SMS fallback. For EVERY outbound message:
 *   1. Try BlueBubbles iMessage.
 *   2. success -> done (imessage-success).
 *      timeout / failed / unreachable -> automatically send via Telnyx SMS in auto mode
 *                                        (fellback-to-sms), or sms-failed if SMS also fails.
 *
 * No availability check is used (it requires the Private API and returns 500).
 * The raw BlueBubbles response and the chosen path are logged every time.
 */
export async function sendOutbound(opts: {
  phone: string;
  message: string;
  smsFrom?: string; // optional caller ID for the SMS FALLBACK leg only (not iMessage)
  /** Optional attachment: a locally-hosted file + its PUBLIC url (for MMS fetch). */
  media?: { path: string; url: string; mime: string; name: string };
}): Promise<SendResult> {
  const to = toE164(opts.phone);

  // Resolve local SMS caller-ID lazily, after BlueBubbles has actually been tried.
  // iMessage has no from-number, so SMS area-code matching cannot affect the first leg.
  const smsFallbackFrom = () => opts.smsFrom ?? pickFromNumber(to).from;

  // 0. Compliance: never message a number on the Do-Not-Contact list — this gates texts
  //    the same way calls are gated. Set via the GHL "Add to DNC" action or IVR opt-out.
  if (await isOnDnc(to)) {
    log.warn("send suppressed: recipient on DNC", { to });
    return { path: "suppressed-dnc", ok: false, detail: "recipient on DNC — not sent" };
  }

  // Lane decision. "sms" = Telnyx only. "imessage" and "auto" always call
  // BlueBubbles first; auto falls back only after that concrete result.
  const mode = getMessagingMode();
  const useImessage = mode !== "sms";
  if (!useImessage) {
    const why = "SMS-only mode";
    const smsFrom = smsFallbackFrom();
    const configProblem = telnyxConfigProblem(smsFrom);
    if (configProblem) {
      log.warn("send path = sms-failed (Telnyx not configured)", { to, why, configProblem });
      return { path: "sms-failed", ok: false, detail: `${why}; ${configProblem}` };
    }
    try {
      if (opts.media) {
        const mms = await sendMms(to, [opts.media.url], opts.message, smsFrom);
        log.info("send path = fellback-to-sms (iMessage skipped, MMS)", { to, why, status: mms.status });
        return { path: "fellback-to-sms", ok: true, detail: `${why} → MMS sent (telnyx ${mms.id}, ${mms.status})` };
      }
      const sms = await sendSms(to, opts.message, smsFrom);
      log.info("send path = fellback-to-sms (iMessage skipped)", { to, why, telnyxId: sms.id, status: sms.status });
      return { path: "fellback-to-sms", ok: true, detail: `${why} → SMS sent (telnyx ${sms.id}, ${sms.status})` };
    } catch (err) {
      log.error("send path = sms-failed (iMessage skipped; Telnyx failed)", { to, why, err: String(err) });
      return { path: "sms-failed", ok: false, detail: `${why}; Telnyx send failed: ${String(err)}` };
    }
  }

  // Attachment (image/file) send: iMessage attachment first → Telnyx MMS fallback.
  if (opts.media) {
    const m = opts.media;
    const im = await sendImessageAttachment(to, m.path, m.name, m.mime, opts.message);
    log.info("bluebubbles attachment response", { to, outcome: im.outcome, status: im.status, raw: im.raw });
    if (im.outcome === "success") {
      return { path: "imessage-success", ok: true, detail: "iMessage attachment delivered" };
    }
    // Unlike a text, an attachment that times out almost always means the BlueBubbles
    // Private API isn't active and the send stalled — we must NOT claim delivery. Every
    // non-success outcome (timeout/failed/unreachable) falls back to Telnyx MMS so the
    // image still goes out through a working lane.
    log.warn("iMessage attachment not confirmed — falling back to MMS", { to, outcome: im.outcome });
    const smsFrom = smsFallbackFrom();
    const configProblem = telnyxConfigProblem(smsFrom);
    if (configProblem) {
      log.warn("MMS fallback skipped: Telnyx not configured", { to, configProblem });
      return { path: "sms-failed", ok: false, detail: `iMessage attachment ${im.outcome}; ${configProblem}` };
    }
    try {
      const mms = await sendMms(to, [m.url], opts.message, smsFrom);
      log.info("send path = fellback-to-sms (MMS)", { to, status: mms.status });
      return {
        path: "fellback-to-sms",
        ok: true,
        detail: `iMessage attachment ${im.outcome} → MMS sent (${mms.status})`,
      };
    } catch (err) {
      log.error("MMS fallback failed", { to, err: String(err) });
      return { path: "sms-failed", ok: false, detail: `iMessage attachment ${im.outcome}; MMS failed: ${String(err)}` };
    }
  }

  // 1. Always attempt iMessage first.
  const im = await sendImessage(to, opts.message);
  // Raw BlueBubbles response, logged every time so the decision is auditable.
  log.info("bluebubbles response", { to, outcome: im.outcome, status: im.status, raw: im.raw });

  if (im.outcome === "success") {
    log.info("send path = imessage-success", { to });
    return { path: "imessage-success", ok: true, detail: "iMessage delivered (2xx)" };
  }

  if (im.outcome === "timeout" && mode === "imessage") {
    // iMessage-only mode explicitly disables SMS fallback, so do not double-send by SMS.
    log.info("send path = imessage-timeout (iMessage-only mode; no SMS fallback)", { to });
    return {
      path: "imessage-timeout",
      ok: true,
      detail: `iMessage timed out (status ${im.status ?? "none"}) — probably delivered, no fallback`,
    };
  }

  // timeout / failed / unreachable -> automatic, backend SMS fallback in auto mode.
  if (mode === "imessage") {
    log.warn(`iMessage ${im.outcome}; SMS fallback disabled by iMessage-only mode`, { to, raw: im.raw });
    return {
      path: "imessage-failed",
      ok: false,
      detail: `iMessage ${im.outcome} (${im.raw}); SMS fallback disabled`,
    };
  }

  log.warn(`iMessage ${im.outcome} — auto-falling back to Telnyx SMS`, { to, raw: im.raw });
  const smsFrom = smsFallbackFrom();
  const configProblem = telnyxConfigProblem(smsFrom);
  if (configProblem) {
    log.warn("SMS fallback skipped: Telnyx not configured", { to, configProblem });
    return {
      path: "sms-failed",
      ok: false,
      detail: `iMessage ${im.outcome} (${im.raw}); ${configProblem}`,
    };
  }
  try {
    const sms = await sendSms(to, opts.message, smsFrom);
    log.info("send path = fellback-to-sms", { to, telnyxId: sms.id, status: sms.status });
    return {
      path: "fellback-to-sms",
      ok: true,
      detail: `iMessage ${im.outcome} (${im.raw}); fell back to SMS (telnyx ${sms.id}, ${sms.status})`,
    };
  } catch (err) {
    log.error("send path = sms-failed (both channels failed)", { to, err: String(err) });
    return {
      path: "sms-failed",
      ok: false,
      detail: `iMessage ${im.outcome} AND SMS fallback failed: ${String(err)}`,
    };
  }
}
