import { sendImessage } from "./bluebubbles";
import { addTags, logMessage, GhlContact } from "./ghl";
import { log } from "../logger";

const PROBE_TEXT =
  "Hey, it's Mike — texting you from my cell too so you've got my direct line. Talk soon.";

/**
 * One-time iMessage capability probe. Fired ONLY from the inbound-SMS webhook
 * (never on outbound, never on inbound iMessage). Sends a single iMessage to the
 * SMS sender and tags the contact based on the BlueBubbles response:
 *
 *   success / timeout(524) -> iMessage-capable      -> tags "imessage" + "probed";
 *                             also threads the probe message into the GHL conversation.
 *   failed (server said 500/etc) -> NOT iMessage-capable -> tags "sms-only" + "probed"
 *                             (contact never received the probe, so it's not logged).
 *   unreachable (Mac down)  -> INCONCLUSIVE          -> no tag; re-probes next time.
 *
 * Skips entirely if the contact already has "imessage" or "probed".
 */
export async function runImessageProbe(contact: GhlContact): Promise<void> {
  const tags = contact.tags ?? [];
  if (tags.includes("imessage") || tags.includes("probed")) {
    log.info("imessage probe skipped — already probed/tagged", { contactId: contact.id, tags });
    return;
  }

  const phone = contact.phone;
  if (!phone) {
    log.warn("imessage probe skipped — contact has no phone", { contactId: contact.id });
    return;
  }

  // Direct iMessage send (NOT the SMS-fallback path — a non-capable contact should
  // simply not receive the probe).
  const result = await sendImessage(phone, PROBE_TEXT);

  // Mac unreachable -> capability unknown. Don't tag, so this contact gets re-probed
  // the next time they text in (once BlueBubbles is back up).
  if (result.outcome === "unreachable") {
    log.warn("imessage probe inconclusive — BlueBubbles unreachable; not tagging (will re-probe)", {
      contactId: contact.id,
      phone,
      raw: result.raw,
    });
    return;
  }

  const capable = result.outcome === "success" || result.outcome === "timeout";
  const channelTag = capable ? "imessage" : "sms-only";

  // Raw response + tag decision, logged for every conclusive probe.
  log.info("imessage probe result", {
    contactId: contact.id,
    phone,
    outcome: result.outcome,
    status: result.status,
    raw: result.raw,
    decision: channelTag,
  });

  // Tag the channel (imessage / sms-only) + mark probed so we don't re-probe.
  try {
    await addTags(contact.id, [channelTag, "probed"]);
    log.info("imessage probe tags applied", { contactId: contact.id, applied: [channelTag, "probed"] });
  } catch (err) {
    log.error("imessage probe tag-apply failed", { contactId: contact.id, err: String(err) });
  }

  // Only when iMessage-capable did the contact actually receive the probe — thread it
  // into their GHL conversation as an outbound message so you have the record.
  if (capable) {
    try {
      await logMessage({ contactId: contact.id, message: PROBE_TEXT, direction: "outbound" });
      log.info("probe message threaded into GHL conversation", { contactId: contact.id });
    } catch (err) {
      log.warn("probe message GHL log failed", { contactId: contact.id, err: String(err) });
    }
  }
}
