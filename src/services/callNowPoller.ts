import { config } from "../config";
import { searchByTag, removeTags } from "./ghl";
import { startClickToCall } from "./clickToCall";
import { log } from "../logger";

let polling = false;

/**
 * Poll GHL for contacts tagged `call-now`. Each cycle dials ONE (to avoid
 * overlapping rings to your cell), removes the tag first so it isn't re-dialed,
 * runs the DNC-gated click-to-call, and logs the result.
 */
async function pollOnce(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const contacts = await searchByTag(config.voice.callNowTag, 5);
    if (!contacts.length) return;
    const contact = contacts[0];
    await removeTags(contact.id, [config.voice.callNowTag]); // remove first so we don't re-dial
    log.info("call-now tag found — dialing", { contactId: contact.id });
    const result = await startClickToCall({ contactId: contact.id });
    log.info("call-now dial result", { contactId: contact.id, result });
  } catch (err) {
    log.error("call-now poll error", { err: String(err) });
  } finally {
    polling = false;
  }
}

export function startCallNowPoller(): void {
  if (!config.voice.applicationId || !config.voice.myCell) {
    log.warn("call-now poller NOT started - TELNYX_VOICE_APP_ID or TELNYX_CONNECTION_ID / MY_CELL_NUMBER not set");
    return;
  }
  const timer = setInterval(() => void pollOnce(), config.voice.pollMs);
  timer.unref();
  log.info("call-now poller started", { tag: config.voice.callNowTag, pollMs: config.voice.pollMs });
}
