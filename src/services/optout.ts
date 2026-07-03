import { log } from "../logger";
import { toE164 } from "../util/phone";
import { brand } from "../brand";
import { addToDnc, removeFromDnc, isOnDnc } from "./dnc";
import { sendSms } from "./telnyx";
import { findLead, updateLead, logActivity } from "./leads";

/**
 * Inbound SMS keyword handling for opt-out / help (TCPA + CTIA). Carriers on 10DLC
 * also enforce STOP at the network level; we additionally honor it in-app so the drip
 * stops immediately and we send exactly one confirmation.
 */
const STOP_WORDS = ["stop", "stopall", "unsubscribe", "end", "cancel", "quit"];
const HELP_WORDS = ["help", "info"];
const START_WORDS = ["start", "unstop", "yes"];

// CTIA / 10DLC-compliant keyword confirmations. Each names the program (brand), states the
// message types (account/customer-care + marketing/promotional — MARKETING is selected on the
// campaign), message frequency, "Msg & data rates may apply", and HELP/STOP. Carriers reject
// opt-in/START copy that doesn't identify the program or mention marketing on a Marketing/Mixed campaign.
const OPTOUT_CONFIRM =
  `${brand.smsName} (${brand.sender}): You're unsubscribed and will receive no more messages. Reply HELP for help.`;
const HELP_REPLY =
  `${brand.smsName} (${brand.sender}): mortgage account/customer-care & marketing texts. ` +
  `Help: call ${brand.voiceNumber}. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out.`;
const START_CONFIRM =
  `${brand.smsName} (${brand.sender}): You're subscribed to mortgage account/customer-care & marketing/promotional texts. ` +
  `Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`;

function firstWord(text: string): string {
  return (text ?? "").trim().toLowerCase().replace(/[^a-z]/g, " ").trim().split(/\s+/)[0] ?? "";
}

/** Reflect an opt-out on the matching CRM lead (best-effort; no throw). */
function markLead(phone: string, smsConsent: boolean, note: string): void {
  try {
    const lead = findLead({ phone });
    if (!lead) return;
    updateLead(lead.id, { sms_consent: smsConsent });
    logActivity(lead.id, { type: "sms", direction: "inbound", channel: "sms", body: note, status: "keyword" });
  } catch (err) {
    log.warn("optout markLead failed", { err: String(err) });
  }
}

/**
 * Handle STOP / HELP / START keywords on an inbound text. Returns true if the message
 * was a keyword (so the caller can skip the normal nurture/probe path). Confirmations
 * are sent via Telnyx directly (the router would suppress a number we just added to DNC).
 */
export async function handleInboundKeyword(fromRaw: string, text: string): Promise<boolean> {
  const word = firstWord(text);
  const phone = toE164(fromRaw);
  if (!phone) return false;

  if (STOP_WORDS.includes(word)) {
    await addToDnc(phone, "sms-stop");
    markLead(phone, false, `Opt-out keyword: ${word.toUpperCase()}`);
    try {
      await sendSms(phone, OPTOUT_CONFIRM);
    } catch (err) {
      log.warn("opt-out confirmation send failed", { phone, err: String(err) });
    }
    log.info("SMS opt-out honored", { phone, word });
    return true;
  }

  if (HELP_WORDS.includes(word)) {
    try {
      await sendSms(phone, HELP_REPLY);
    } catch (err) {
      log.warn("HELP reply send failed", { phone, err: String(err) });
    }
    log.info("SMS HELP answered", { phone });
    return true;
  }

  if (START_WORDS.includes(word) && (await isOnDnc(phone))) {
    // Re-subscribe: only act on START if they had previously opted out.
    await removeFromDnc(phone);
    markLead(phone, true, "Re-subscribe keyword: START");
    try {
      await sendSms(phone, START_CONFIRM);
    } catch (err) {
      log.warn("START confirmation send failed", { phone, err: String(err) });
    }
    log.info("SMS re-subscribe", { phone });
    return true;
  }

  return false;
}
