import { config } from "../config";
import { getContact, logCall } from "./ghl";
import { checkAutomatedCall } from "./compliance";
import { placeCall } from "./telnyxVoice";
import { setCall } from "./callState";
import { log } from "../logger";

interface QueueItem {
  contactId: string;
  deferLogged?: boolean; // log the first outside-hours defer to GHL, not every 15-min retry
}

const queue: QueueItem[] = [];
const deferred: QueueItem[] = []; // outside-hours, retried later
let running = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function enqueueAutomated(contactIds: string[]): number {
  for (const id of contactIds) queue.push({ contactId: id });
  void runQueue();
  return queue.length;
}

export function queueStatus(): { queued: number; deferred: number; running: boolean } {
  return { queued: queue.length, deferred: deferred.length, running };
}

async function runQueue(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const item = queue.shift()!;
      try {
        const contact = await getContact(item.contactId);
        const gate = await checkAutomatedCall(contact);
        if (!gate.allowed) {
          if (gate.reason === "outside-hours") {
            // TIME-WINDOW gate: queue for later, don't dial now.
            log.warn("automated call DEFERRED — outside calling hours", {
              contactId: item.contactId,
              tz: contact.timezone,
            });
            // Audit trail in GHL — once per item, not on every 15-min re-defer.
            if (!item.deferLogged) {
              item.deferLogged = true;
              void logCall({ contactId: contact.id, direction: "outbound", durationSec: 0, status: "deferred-outside-hours" }).catch(() => undefined);
            }
            deferred.push(item);
          } else {
            // Terminal skip (audit trail): on-DNC / no-consent / unknown-timezone / no-phone.
            log.warn("automated call SKIPPED", { contactId: item.contactId, reason: gate.reason });
            void logCall({ contactId: contact.id, direction: "outbound", durationSec: 0, status: `skipped-${gate.reason}` }).catch(() => undefined);
          }
          continue;
        }
        const phone = contact.phone as string;
        const ccid = await placeCall(phone); // dial the contact; bridge to agent on answer
        setCall(ccid, {
          kind: "automated",
          direction: "outbound",
          startedAt: Date.now(),
          primary: true,
          contactId: contact.id,
          contactPhone: phone,
          role: "dial-peer-on-answer",
          peerTarget: config.voice.myCell,
          stage: "ringing-contact",
        });
        log.info("automated call PLACED", { contactId: contact.id, ccid });
      } catch (err) {
        log.error("automated call error", { contactId: item.contactId, err: String(err) });
      }
      // CALL THROTTLING: pace between automated calls.
      await sleep(config.compliance.throttleMs);
    }
  } finally {
    running = false;
  }
}

// Periodically move deferred (outside-hours) items back into the queue; they get
// re-gated, so they only dial once within calling hours.
const retryTimer = setInterval(() => {
  if (deferred.length) {
    const moved = deferred.splice(0, deferred.length);
    queue.push(...moved);
    log.info("re-queueing deferred automated calls", { count: moved.length });
    void runQueue();
  }
}, 15 * 60 * 1000);
retryTimer.unref();
