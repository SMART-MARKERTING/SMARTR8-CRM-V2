import type { Env } from "../env";
import { sendImessage } from "./bluebubbles";
import { sendSms } from "./telnyx";
import { getContactTexting, upsertContactTexting } from "../db/repo";

export interface DeliveryResult {
  /** Channel the message actually went out on. */
  channel: "imessage" | "sms";
  /** Provider message id (Telnyx) when known. */
  providerId?: string;
  /** tempGuid (BlueBubbles) when iMessage was used. */
  tempGuid?: string;
  /** True when delivered (or probably-delivered via iMessage timeout). */
  ok: boolean;
  /** Human-readable detail of the path taken. */
  detail: string;
}

/** iMessage-first with automatic, silent SMS fallback + new-contact capability probe.
 *
 *  1. Try BlueBubbles iMessage (unique tempGuid).
 *     success -> done. timeout (524/abort) -> probably delivered, NO fallback.
 *     failed/unreachable -> silently fall back to Telnyx SMS.
 *  2. The first send to a brand-new contact doubles as the capability probe: a clean
 *     iMessage success tags the contact imessage_capable; a hard failure tags it
 *     sms-only; a timeout/unreachable leaves capability unknown (re-probe later). */
export async function sendOutbound(
  env: Env,
  opts: { leadId: string | null; phone: string; message: string },
): Promise<DeliveryResult> {
  const { leadId, phone, message } = opts;
  const now = Date.now();
  const tagProbe = async (patch: Parameters<typeof upsertContactTexting>[2]) => {
    if (leadId) await upsertContactTexting(env, leadId, patch);
  };

  /* SMS-only when BlueBubbles isn't configured at all. */
  if (!env.BLUEBUBBLES_URL) {
    const sms = await sendSms(env, phone, message);
    return { channel: "sms", providerId: sms.id, ok: true, detail: `SMS sent (telnyx ${sms.id}, ${sms.status}); iMessage not configured` };
  }

  const im = await sendImessage(env, phone, message);

  if (im.outcome === "success") {
    await tagProbe({ imessage_capable: 1, probed: 1, probed_at: now });
    return { channel: "imessage", tempGuid: im.tempGuid, ok: true, detail: "iMessage delivered (2xx)" };
  }

  if (im.outcome === "timeout") {
    /* Probably delivered; capability inconclusive — mark probed without asserting capable. */
    await tagProbe({ probed: 1, probed_at: now });
    return {
      channel: "imessage",
      tempGuid: im.tempGuid,
      ok: true,
      detail: `iMessage timed out (status ${im.status ?? "none"}) — probably delivered, no SMS fallback`,
    };
  }

  /* failed -> a real send error means this contact is not iMessage-capable.
     unreachable -> Mac/tunnel down: capability unknown, do NOT tag sms-only. */
  if (im.outcome === "failed") {
    await tagProbe({ imessage_capable: 0, probed: 1, probed_at: now });
  } else {
    /* leave imessage_capable as-is; existing probe state preserved */
    const ct = leadId ? await getContactTexting(env, leadId) : null;
    if (leadId && !ct) await tagProbe({ probed: 0 });
  }

  try {
    const sms = await sendSms(env, phone, message);
    return {
      channel: "sms",
      providerId: sms.id,
      ok: true,
      detail: `iMessage ${im.outcome} (${im.raw}); fell back to SMS (telnyx ${sms.id}, ${sms.status})`,
    };
  } catch (err) {
    return {
      channel: "sms",
      ok: false,
      detail: `iMessage ${im.outcome} AND SMS fallback failed: ${String(err)}`,
    };
  }
}
