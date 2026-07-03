import { Router } from "express";
import { sendOutbound } from "../services/router";
import { getContact, updateMessageStatus } from "../services/ghl";
import { log } from "../logger";

export const providerRouter = Router();

/**
 * GHL conversation-provider Delivery URL. GHL POSTs here when a user sends an
 * outbound message from the conversation tab. We resolve the phone, run the
 * iMessage-first / SMS-fallback send (services/router.ts), then report status.
 */
providerRouter.post("/messages", async (req, res) => {
  const b = (req.body ?? {}) as Record<string, any>;
  log.info("GHL provider delivery payload", b);

  // Ack fast — GHL expects a prompt 200; the send + status update happen after.
  res.status(200).json({ received: true });

  const contactId: string | undefined = b.contactId ?? b.contact_id;
  const messageId: string | undefined = b.messageId ?? b.message_id ?? b.id;
  const message: string = b.message ?? b.body ?? b.text ?? "";
  let phone: string | undefined = b.phone ?? b.to ?? b.contactPhone;

  try {
    if (!phone && contactId) {
      const contact = await getContact(contactId);
      phone = contact.phone;
    }
    if (!phone) {
      log.error("provider delivery: could not resolve a phone number", { contactId });
      if (messageId) await updateMessageStatus(messageId, "failed", "no phone on contact");
      return;
    }

    // iMessage-first, automatic silent SMS fallback.
    const result = await sendOutbound({ phone, message });
    log.info("provider send result", { path: result.path, ok: result.ok, detail: result.detail });

    // GHL already created this outbound message (it's what triggered this webhook),
    // so we report its STATUS rather than logging a duplicate. `delivered` shows it
    // as a sent outbound bubble; the channel/path detail lives in the logs above.
    if (messageId) {
      if (result.ok) await updateMessageStatus(messageId, "delivered");
      else await updateMessageStatus(messageId, "failed", result.detail);
    }
  } catch (err) {
    log.error("provider delivery handler error", { err: String(err) });
    if (messageId) await updateMessageStatus(messageId, "failed", String(err)).catch(() => undefined);
  }
});
