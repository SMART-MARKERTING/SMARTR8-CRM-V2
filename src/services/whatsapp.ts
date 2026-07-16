import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { Request } from "express";
import { config } from "../config";
import { log } from "../logger";
import { db } from "../store/db";
import { toE164 } from "../util/phone";
import { createLead, findLead, getLead, Lead, leadName, logActivity, updateLead } from "./leads";
import { createNotificationEvent } from "./notifications";

export type WhatsAppProvider = "twilio" | "meta";
export type WhatsAppDirection = "inbound" | "outbound";

const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60_000;

export interface WhatsAppSendResult {
  ok: boolean;
  contactId: string;
  provider: WhatsAppProvider;
  providerMessageId?: string;
  status: string;
  detail?: string;
  errorCode?: string;
}

export interface WhatsAppMessageLog {
  id: string;
  contact_id: string;
  channel: "whatsapp";
  direction: WhatsAppDirection;
  provider: WhatsAppProvider;
  provider_message_id: string | null;
  body: string | null;
  template_name: string | null;
  status: string;
  error_code: string | null;
  created_at: number;
}

interface SendBaseInput {
  contactId?: string;
  phone?: string;
  actor?: string;
  aiAutoSend?: boolean;
}

interface SendTextInput extends SendBaseInput {
  body: string;
}

interface SendTemplateInput extends SendBaseInput {
  templateName: string;
  variables?: Record<string, string | number | null | undefined>;
}

export const WHATSAPP_TEMPLATES = [
  {
    name: "heloc_follow_up",
    label: "HELOC follow-up",
    body:
      "Hi {{first_name}}, Mykoal with Adaxa Home here. Still interested in checking home equity options? Reply HELOC and I can send next steps. Subject to approval.",
  },
  {
    name: "quote_app_link",
    label: "Quote / app link",
    body:
      "Hi {{first_name}}, here is the secure link to check available home equity options: {{quote_link}}. Options may vary and are subject to approval.",
  },
  {
    name: "appointment_follow_up",
    label: "Appointment follow-up",
    body:
      "Hi {{first_name}}, I am following up on your home equity request. If you still want to review options, reply with a good time or use this link: {{appointment_link}}.",
  },
] as const;

export function whatsappTemplateOptions(): Array<{ name: string; label: string; body: string }> {
  return WHATSAPP_TEMPLATES.map((t) => ({ ...t }));
}

export function whatsAppProviderStatus(): {
  configured: boolean;
  provider: WhatsAppProvider;
  twilioReady: boolean;
  metaReady: boolean;
  warnings: string[];
  templates: Array<{ name: string; label: string; body: string }>;
} {
  const twilioReady = Boolean(
    config.whatsapp.twilioAccountSid && config.whatsapp.twilioAuthToken && config.whatsapp.twilioFrom,
  );
  const metaReady = Boolean(config.whatsapp.accessToken && config.whatsapp.phoneNumberId);
  const warnings: string[] = [];
  if (!twilioReady && !metaReady) {
    warnings.push("WhatsApp is not configured. Add Twilio WhatsApp vars or Meta Cloud API vars.");
  }
  if (metaReady && !config.whatsapp.verifyToken) warnings.push("Meta webhook verification token is missing.");
  if (metaReady && !config.whatsapp.appSecret) warnings.push("Meta app secret is missing; webhook signature verification is disabled.");
  return {
    configured: twilioReady || metaReady,
    provider: twilioReady ? "twilio" : "meta",
    twilioReady,
    metaReady,
    warnings,
    templates: whatsappTemplateOptions(),
  };
}

function renderTemplate(name: string, lead: Lead, vars: Record<string, string | number | null | undefined> = {}): string {
  const template = WHATSAPP_TEMPLATES.find((t) => t.name === name);
  if (!template) throw new Error(`unknown WhatsApp template: ${name}`);
  const firstName = lead.first_name || leadName(lead).split(/\s+/)[0] || "there";
  const values: Record<string, string> = {
    first_name: firstName,
    quote_link: String(vars.quote_link || config.optionsLinkUrl || config.crm.publicBaseUrl || ""),
    appointment_link: String(vars.appointment_link || config.optionsLinkUrl || config.crm.publicBaseUrl || ""),
  };
  for (const [key, value] of Object.entries(vars)) values[key] = value == null ? "" : String(value);
  return template.body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) => values[key] ?? "");
}

function normalizeWhatsAppAddress(phone: string): string {
  return toE164(phone);
}

function metaTo(phone: string): string {
  return normalizeWhatsAppAddress(phone).replace(/^\+/, "");
}

function twilioAddress(phone: string): string {
  const e164 = normalizeWhatsAppAddress(phone);
  return e164.startsWith("whatsapp:") ? e164 : `whatsapp:${e164}`;
}

function recordWhatsAppMessage(input: {
  contactId: string;
  direction: WhatsAppDirection;
  provider: WhatsAppProvider;
  providerMessageId?: string | null;
  body?: string | null;
  templateName?: string | null;
  status: string;
  errorCode?: string | null;
  createdAt?: number;
}): WhatsAppMessageLog {
  const row: WhatsAppMessageLog = {
    id: randomUUID(),
    contact_id: input.contactId,
    channel: "whatsapp",
    direction: input.direction,
    provider: input.provider,
    provider_message_id: input.providerMessageId ?? null,
    body: input.body ?? null,
    template_name: input.templateName ?? null,
    status: input.status,
    error_code: input.errorCode ?? null,
    created_at: input.createdAt ?? Date.now(),
  };
  db.prepare(
    `INSERT INTO whatsapp_messages
      (id, contact_id, channel, direction, provider, provider_message_id, body, template_name, status, error_code, created_at)
     VALUES
      (@id, @contact_id, @channel, @direction, @provider, @provider_message_id, @body, @template_name, @status, @error_code, @created_at)`,
  ).run(row);
  return row;
}

export function listWhatsAppMessages(contactId?: string, limit = 50): WhatsAppMessageLog[] {
  if (contactId) {
    return db
      .prepare(`SELECT * FROM whatsapp_messages WHERE contact_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(contactId, Math.min(limit, 500)) as WhatsAppMessageLog[];
  }
  return db
    .prepare(`SELECT * FROM whatsapp_messages ORDER BY created_at DESC LIMIT ?`)
    .all(Math.min(limit, 500)) as WhatsAppMessageLog[];
}

function resolveProvider(): WhatsAppProvider {
  return whatsAppProviderStatus().provider;
}

function resolveContactByWhatsAppPhone(phone: string): Lead | null {
  const e164 = normalizeWhatsAppAddress(phone);
  const row = db
    .prepare(
      `SELECT * FROM leads
       WHERE deleted_at IS NULL AND (whatsapp_phone = @phone OR phone = @phone)
       ORDER BY COALESCE(last_activity_at, updated_at, created_at) DESC
       LIMIT 1`,
    )
    .get({ phone: e164 }) as { id: string } | undefined;
  return row ? getLead(row.id) : null;
}

function resolveOutboundLead(input: SendBaseInput): { lead: Lead; phone: string } {
  let lead = input.contactId ? getLead(input.contactId) : null;
  if (!lead && input.phone) lead = resolveContactByWhatsAppPhone(input.phone) ?? findLead({ phone: input.phone });
  if (!lead && input.phone) {
    lead = createLead({ phone: normalizeWhatsAppAddress(input.phone), source: "whatsapp" });
  }
  if (!lead) throw new Error("pass contactId or phone");
  const phone = normalizeWhatsAppAddress(input.phone || lead.whatsapp_phone || lead.phone || "");
  if (!phone || phone.replace(/\D/g, "").length < 10) throw new Error("contact has no valid WhatsApp phone");
  if (lead.whatsapp_phone !== phone) {
    updateLead(lead.id, { whatsapp_phone: phone });
    lead = getLead(lead.id) ?? lead;
  }
  return { lead, phone };
}

function resolveInboundLead(phone: string, source: string): Lead {
  const e164 = normalizeWhatsAppAddress(phone);
  let lead = resolveContactByWhatsAppPhone(e164) ?? findLead({ phone: e164 });
  if (!lead) lead = createLead({ phone: e164, whatsapp_phone: e164, source });
  const updated = updateLead(lead.id, {
    whatsapp_phone: e164,
    whatsapp_opt_in_status: true,
    whatsapp_opt_in_source: source,
    whatsapp_last_inbound_at: Date.now(),
    preferred_channel: "whatsapp",
  });
  return updated ?? lead;
}

function withinCustomerServiceWindow(lead: Lead): boolean {
  return Boolean(lead.whatsapp_last_inbound_at && Date.now() - lead.whatsapp_last_inbound_at <= CUSTOMER_SERVICE_WINDOW_MS);
}

function blockedOutboundResult(
  lead: Lead,
  provider: WhatsAppProvider,
  body: string,
  status: string,
  detail: string,
  templateName?: string,
): WhatsAppSendResult {
  recordWhatsAppMessage({
    contactId: lead.id,
    direction: "outbound",
    provider,
    body,
    templateName,
    status,
    errorCode: status,
  });
  logActivity(lead.id, {
    type: "whatsapp",
    direction: "outbound",
    channel: "whatsapp",
    body,
    status,
    meta: { provider, detail, templateName: templateName ?? null },
  });
  return { ok: false, contactId: lead.id, provider, status, detail, errorCode: status };
}

async function sendTwilioWhatsApp(to: string, body: string): Promise<{ id?: string; status: string; detail?: string; errorCode?: string }> {
  const sid = config.whatsapp.twilioAccountSid;
  const token = config.whatsapp.twilioAuthToken;
  const from = config.whatsapp.twilioFrom;
  if (!sid || !token || !from) throw new Error("Twilio WhatsApp is not configured");
  const form = new URLSearchParams();
  form.set("To", twilioAddress(to));
  form.set("From", from.startsWith("whatsapp:") ? from : `whatsapp:${from}`);
  form.set("Body", body);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    return {
      status: "failed",
      detail: String(data.message || data.error_message || res.statusText),
      errorCode: String(data.code || res.status),
    };
  }
  return {
    id: typeof data.sid === "string" ? data.sid : undefined,
    status: typeof data.status === "string" ? data.status : "queued",
  };
}

async function sendMetaWhatsAppText(to: string, body: string): Promise<{ id?: string; status: string; detail?: string; errorCode?: string }> {
  const token = config.whatsapp.accessToken;
  const phoneNumberId = config.whatsapp.phoneNumberId;
  if (!token || !phoneNumberId) throw new Error("Meta WhatsApp Cloud API is not configured");
  const res = await fetch(`https://graph.facebook.com/${config.whatsapp.graphVersion}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: metaTo(to),
      type: "text",
      text: { preview_url: true, body },
    }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = data.error as Record<string, unknown> | undefined;
    return { status: "failed", detail: String(err?.message || res.statusText), errorCode: String(err?.code || res.status) };
  }
  const messages = Array.isArray(data.messages) ? (data.messages as Array<Record<string, unknown>>) : [];
  return { id: typeof messages[0]?.id === "string" ? messages[0].id : undefined, status: "sent" };
}

async function sendMetaWhatsAppTemplate(
  to: string,
  templateName: string,
  vars: Record<string, string | number | null | undefined>,
): Promise<{ id?: string; status: string; detail?: string; errorCode?: string }> {
  const token = config.whatsapp.accessToken;
  const phoneNumberId = config.whatsapp.phoneNumberId;
  if (!token || !phoneNumberId) throw new Error("Meta WhatsApp Cloud API is not configured");
  const variableValues = Object.values(vars).filter((v) => v !== undefined && v !== null).map((v) => String(v));
  const bodyComponents = variableValues.length
    ? [{
        type: "body",
        parameters: variableValues.map((text) => ({ type: "text", text })),
      }]
    : undefined;
  const res = await fetch(`https://graph.facebook.com/${config.whatsapp.graphVersion}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: metaTo(to),
      type: "template",
      template: {
        name: templateName,
        language: { code: "en_US" },
        ...(bodyComponents ? { components: bodyComponents } : {}),
      },
    }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = data.error as Record<string, unknown> | undefined;
    return { status: "failed", detail: String(err?.message || res.statusText), errorCode: String(err?.code || res.status) };
  }
  const messages = Array.isArray(data.messages) ? (data.messages as Array<Record<string, unknown>>) : [];
  return { id: typeof messages[0]?.id === "string" ? messages[0].id : undefined, status: "sent" };
}

function outboundAllowed(lead: Lead, provider: WhatsAppProvider, body: string, templateName?: string): WhatsAppSendResult | null {
  if (!lead.whatsapp_opt_in_status) {
    return blockedOutboundResult(lead, provider, body, "blocked:no-whatsapp-opt-in", "WhatsApp opt-in is not recorded.", templateName);
  }
  if (!templateName && !withinCustomerServiceWindow(lead)) {
    return blockedOutboundResult(
      lead,
      provider,
      body,
      "blocked:template-required",
      "A free-form WhatsApp message requires a customer inbound message within the last 24 hours. Use an approved template.",
    );
  }
  return null;
}

export async function sendWhatsAppText(input: SendTextInput): Promise<WhatsAppSendResult> {
  const { lead, phone } = resolveOutboundLead(input);
  const provider = resolveProvider();
  if (input.aiAutoSend && !config.whatsapp.aiAutoSendEnabled) {
    return blockedOutboundResult(lead, provider, input.body, "blocked:ai-auto-send-disabled", "AI auto-send for WhatsApp is disabled.");
  }
  const blocked = outboundAllowed(lead, provider, input.body);
  if (blocked) return blocked;
  if (!whatsAppProviderStatus().configured) {
    return blockedOutboundResult(lead, provider, input.body, "failed:not-configured", "WhatsApp provider is not configured.");
  }
  const result = provider === "twilio"
    ? await sendTwilioWhatsApp(phone, input.body)
    : await sendMetaWhatsAppText(phone, input.body);
  recordWhatsAppMessage({
    contactId: lead.id,
    direction: "outbound",
    provider,
    providerMessageId: result.id,
    body: input.body,
    status: result.status,
    errorCode: result.errorCode,
  });
  logActivity(lead.id, {
    type: "whatsapp",
    direction: "outbound",
    channel: "whatsapp",
    body: input.body,
    status: result.errorCode ? "failed" : "sent",
    meta: { provider, providerMessageId: result.id ?? null, detail: result.detail ?? null, actor: input.actor ?? null },
  });
  updateLead(lead.id, { whatsapp_phone: phone, whatsapp_last_outbound_at: Date.now(), preferred_channel: "whatsapp" });
  return { ok: !result.errorCode, contactId: lead.id, provider, providerMessageId: result.id, status: result.status, detail: result.detail, errorCode: result.errorCode };
}

export async function sendWhatsAppTemplate(input: SendTemplateInput): Promise<WhatsAppSendResult> {
  const { lead, phone } = resolveOutboundLead(input);
  const provider = resolveProvider();
  if (input.aiAutoSend && !config.whatsapp.aiAutoSendEnabled) {
    return blockedOutboundResult(lead, provider, input.templateName, "blocked:ai-auto-send-disabled", "AI auto-send for WhatsApp is disabled.", input.templateName);
  }
  const body = renderTemplate(input.templateName, lead, input.variables);
  if (!lead.whatsapp_opt_in_status) {
    return blockedOutboundResult(lead, provider, body, "blocked:no-whatsapp-opt-in", "WhatsApp opt-in is not recorded.", input.templateName);
  }
  if (!whatsAppProviderStatus().configured) {
    return blockedOutboundResult(lead, provider, body, "failed:not-configured", "WhatsApp provider is not configured.", input.templateName);
  }
  const result = provider === "twilio"
    ? await sendTwilioWhatsApp(phone, body)
    : await sendMetaWhatsAppTemplate(phone, input.templateName, input.variables ?? {});
  recordWhatsAppMessage({
    contactId: lead.id,
    direction: "outbound",
    provider,
    providerMessageId: result.id,
    body,
    templateName: input.templateName,
    status: result.status,
    errorCode: result.errorCode,
  });
  logActivity(lead.id, {
    type: "whatsapp",
    direction: "outbound",
    channel: "whatsapp",
    body,
    status: result.errorCode ? "failed" : "sent",
    meta: { provider, providerMessageId: result.id ?? null, templateName: input.templateName, detail: result.detail ?? null, actor: input.actor ?? null },
  });
  updateLead(lead.id, { whatsapp_phone: phone, whatsapp_last_outbound_at: Date.now(), preferred_channel: "whatsapp" });
  return { ok: !result.errorCode, contactId: lead.id, provider, providerMessageId: result.id, status: result.status, detail: result.detail, errorCode: result.errorCode };
}

export function updateWhatsAppMessageStatus(providerMessageId: string, status: string, errorCode?: string | null): boolean {
  if (!providerMessageId) return false;
  const now = Date.now();
  const existing = db
    .prepare(`SELECT * FROM whatsapp_messages WHERE provider_message_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(providerMessageId) as WhatsAppMessageLog | undefined;
  const r = db
    .prepare(`UPDATE whatsapp_messages SET status = ?, error_code = COALESCE(?, error_code) WHERE provider_message_id = ?`)
    .run(status, errorCode ?? null, providerMessageId);
  if (existing) {
    logActivity(existing.contact_id, {
      type: "whatsapp_status",
      direction: "system",
      channel: "whatsapp",
      body: `WhatsApp message ${status}`,
      status,
      meta: { providerMessageId, errorCode: errorCode ?? null, updatedAt: now },
    });
  }
  return (r.changes ?? 0) > 0;
}

function verifyMetaSignature(req: Request): boolean {
  if (!config.whatsapp.appSecret) return !config.webhooks.enforceMeta;
  const header = req.get("x-hub-signature-256") || "";
  if (!header.startsWith("sha256=")) return false;
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!rawBody) return false;
  const expected = `sha256=${createHmac("sha256", config.whatsapp.appSecret).update(rawBody).digest("hex")}`;
  const given = Buffer.from(header);
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

function verifyTwilioSignature(req: Request): boolean {
  const token = config.whatsapp.twilioAuthToken;
  if (!token) return !config.webhooks.enforceTwilio;
  const provided = req.get("x-twilio-signature") || "";
  if (!provided) return false;
  const forwardedHost = (req.get("x-forwarded-host") || req.get("host") || "").split(",")[0].trim();
  const forwardedProto = (req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim();
  const url = `${forwardedProto}://${forwardedHost}${req.originalUrl}`;
  const body = bodyAsRecord(req);
  const signed = Object.keys(body).sort().reduce((value, key) => `${value}${key}${String(body[key] ?? "")}`, url);
  const expected = createHmac("sha1", token).update(signed).digest("base64");
  const given = Buffer.from(provided);
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

function bodyAsRecord(req: Request): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

function logInboundWhatsApp(lead: Lead, provider: WhatsAppProvider, providerMessageId: string | undefined, body: string): boolean {
  if (providerMessageId) {
    const existing = db.prepare(`SELECT id FROM whatsapp_messages WHERE provider_message_id = ? LIMIT 1`).get(providerMessageId);
    if (existing) return false;
  }
  const message = recordWhatsAppMessage({
    contactId: lead.id,
    direction: "inbound",
    provider,
    providerMessageId,
    body,
    status: "received",
  });
  const activity = logActivity(lead.id, {
    type: "whatsapp",
    direction: "inbound",
    channel: "whatsapp",
    body,
    status: "received",
    meta: { provider, providerMessageId: providerMessageId ?? null },
  });
  createNotificationEvent({
    kind: "incoming_message",
    provider,
    providerEventId: providerMessageId || message.id,
    sourceType: "activity",
    sourceRecordId: activity.id,
    leadId: lead.id,
    deepLink: `/v2/?page=messages&lead=${encodeURIComponent(lead.id)}`,
    contactFirstName: lead.first_name,
  });
  return true;
}

function handleTwilioWebhook(req: Request): { inbound: number; statuses: number } {
  if (!verifyTwilioSignature(req)) throw new Error("invalid Twilio webhook signature");
  const b = bodyAsRecord(req);
  const fromRaw = String(b.From || "");
  const from = fromRaw.replace(/^whatsapp:/, "");
  const body = String(b.Body || "");
  const sid = typeof b.MessageSid === "string" ? b.MessageSid : typeof b.SmsSid === "string" ? b.SmsSid : undefined;
  const status = typeof b.MessageStatus === "string" ? b.MessageStatus : typeof b.SmsStatus === "string" ? b.SmsStatus : "";
  if (status && sid && !body && !from) {
    updateWhatsAppMessageStatus(sid, status, typeof b.ErrorCode === "string" ? b.ErrorCode : null);
    return { inbound: 0, statuses: 1 };
  }
  if (status && sid && !body) {
    updateWhatsAppMessageStatus(sid, status, typeof b.ErrorCode === "string" ? b.ErrorCode : null);
    return { inbound: 0, statuses: 1 };
  }
  if (!from || !body) return { inbound: 0, statuses: 0 };
  const lead = resolveInboundLead(from, "twilio_whatsapp_inbound");
  const stored = logInboundWhatsApp(lead, "twilio", sid, body);
  return { inbound: stored ? 1 : 0, statuses: 0 };
}

function handleMetaWebhook(req: Request): { inbound: number; statuses: number } {
  if (!verifyMetaSignature(req)) throw new Error("invalid Meta webhook signature");
  const payload = bodyAsRecord(req);
  let inbound = 0;
  let statuses = 0;
  const entries = Array.isArray(payload.entry) ? payload.entry as Array<Record<string, unknown>> : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry.changes) ? entry.changes as Array<Record<string, unknown>> : [];
    for (const change of changes) {
      const value = (change.value ?? {}) as Record<string, unknown>;
      const statusRows = Array.isArray(value.statuses) ? value.statuses as Array<Record<string, unknown>> : [];
      for (const row of statusRows) {
        const id = typeof row.id === "string" ? row.id : "";
        const status = typeof row.status === "string" ? row.status : "updated";
        const errors = Array.isArray(row.errors) ? row.errors as Array<Record<string, unknown>> : [];
        updateWhatsAppMessageStatus(id, status, errors[0]?.code ? String(errors[0].code) : null);
        statuses++;
      }
      const messages = Array.isArray(value.messages) ? value.messages as Array<Record<string, unknown>> : [];
      for (const message of messages) {
        const from = typeof message.from === "string" ? message.from : "";
        const text = (message.text ?? {}) as Record<string, unknown>;
        const body = typeof text.body === "string" ? text.body : "";
        const id = typeof message.id === "string" ? message.id : undefined;
        if (!from || !body) continue;
        const lead = resolveInboundLead(from, "meta_whatsapp_inbound");
        if (logInboundWhatsApp(lead, "meta", id, body)) inbound++;
      }
    }
  }
  return { inbound, statuses };
}

export async function handleInboundWhatsAppWebhook(req: Request): Promise<{ ok: boolean; provider: WhatsAppProvider; inbound: number; statuses: number }> {
  const b = bodyAsRecord(req);
  const looksTwilio = Boolean(b.From || b.MessageSid || b.SmsSid || b.MessageStatus || b.SmsStatus);
  try {
    if (looksTwilio) {
      const result = handleTwilioWebhook(req);
      return { ok: true, provider: "twilio", ...result };
    }
    const result = handleMetaWebhook(req);
    return { ok: true, provider: "meta", ...result };
  } catch (err) {
    log.error("WhatsApp webhook failed", { err: String(err) });
    throw err;
  }
}

export function simulateInboundWhatsApp(input: { phone: string; body: string; provider?: WhatsAppProvider }): { lead: Lead; message: WhatsAppMessageLog } {
  const provider = input.provider ?? resolveProvider();
  const lead = resolveInboundLead(input.phone, "debug_whatsapp_inbound");
  const message = recordWhatsAppMessage({
    contactId: lead.id,
    direction: "inbound",
    provider,
    providerMessageId: `debug_${randomUUID()}`,
    body: input.body,
    status: "received",
  });
  logActivity(lead.id, {
    type: "whatsapp",
    direction: "inbound",
    channel: "whatsapp",
    body: input.body,
    status: "received",
    meta: { provider, debug: true },
  });
  return { lead, message };
}
