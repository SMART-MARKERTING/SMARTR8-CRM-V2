import type { Env } from "../env";
import { toE164 } from "../util/phone";
import {
  findLeadByPhone,
  getOrCreateConversation,
  recordMessage,
  insertOptOut,
} from "../db/repo";

const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "end", "cancel", "quit", "revoke"]);

function firstWord(text: string): string {
  return (text ?? "").trim().toLowerCase().replace(/[^a-z]/g, " ").trim().split(/\s+/)[0] ?? "";
}

/** True if an inbound text is an opt-out keyword. */
export function isOptOutKeyword(text: string): boolean {
  return STOP_WORDS.has(firstWord(text));
}

/** Record an inbound message against the matching lead, and honor STOP immediately. */
export async function recordInbound(
  env: Env,
  opts: { fromRaw: string; text: string; channel: "sms" | "imessage"; providerId?: string },
): Promise<{ recorded: boolean; leadId: string | null; optedOut: boolean }> {
  const phone = toE164(opts.fromRaw);
  if (!phone) return { recorded: false, leadId: null, optedOut: false };

  const lead = await findLeadByPhone(env, phone);
  const leadId = lead?.lead_id ?? null;
  const conversationId = await getOrCreateConversation(env, { leadId, phone });

  await recordMessage(env, {
    conversation_id: conversationId,
    lead_id: leadId,
    phone_e164: phone,
    direction: "in",
    channel: opts.channel,
    body: opts.text,
    status: "received",
    provider_id: opts.providerId ?? null,
    temp_guid: null,
    error: null,
    created_at: Date.now(),
  });

  let optedOut = false;
  if (isOptOutKeyword(opts.text)) {
    await insertOptOut(env, {
      phone,
      leadId,
      reason: "inbound opt-out keyword",
      keyword: firstWord(opts.text),
      source: opts.channel,
    });
    optedOut = true;
  }

  return { recorded: true, leadId, optedOut };
}
