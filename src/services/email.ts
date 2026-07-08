import { config } from "../config";
import { log } from "../logger";

export interface EmailResult {
  ok: boolean;
  id?: string;
  detail?: string;
}

export interface ResendUpdateEmailResult {
  ok: boolean;
  id?: string;
  detail?: string;
}

export interface ResendCancelEmailResult {
  ok: boolean;
  id?: string;
  detail?: string;
}

export type EmailRecipient = string | string[];

export interface ResendEmailTemplate {
  id: string;
  variables?: Record<string, string | number>;
}

export interface ResendEmailTag {
  name: string;
  value: string;
}

export interface SendEmailOptions {
  to: EmailRecipient;
  subject: string;
  from?: string;
  html?: string;
  text?: string;
  replyTo?: EmailRecipient;
  cc?: string[];
  bcc?: string[];
  scheduledAt?: string;
  topicId?: string;
  tags?: ResendEmailTag[];
  template?: ResendEmailTemplate;
  idempotencyKey?: string;
  attachments?: Array<{ filename: string; content: string }>;
  headers?: Record<string, string>;
}

export interface ResendReceivedEmail {
  object?: string;
  id?: string;
  email_id?: string;
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  created_at?: string;
  html?: string | null;
  text?: string | null;
  attachments?: Array<Record<string, unknown>>;
  headers?: Record<string, string>;
  message_id?: string;
  raw?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ResendSentEmail {
  object?: string;
  id: string;
  message_id?: string;
  to?: string[];
  from?: string;
  created_at?: string;
  subject?: string;
  html?: string | null;
  text?: string | null;
  bcc?: string[];
  cc?: string[];
  reply_to?: string[];
  last_event?: string;
  scheduled_at?: string | null;
  tags?: ResendEmailTag[];
  [key: string]: unknown;
}

export interface ResendSentAttachment {
  object?: string;
  id: string;
  filename?: string;
  size?: number;
  content_type?: string;
  content_disposition?: string;
  content_id?: string;
  download_url?: string;
  expires_at?: string;
  [key: string]: unknown;
}

export interface ListSentEmailsOptions {
  limit?: number;
  after?: string;
  before?: string;
}

export interface ResendWebhook {
  object?: string;
  id: string;
  created_at?: string;
  status?: string;
  endpoint?: string;
  events?: string[];
  signing_secret?: string;
  [key: string]: unknown;
}

export function emailConfigured(): boolean {
  return Boolean(config.email.resendApiKey && config.email.fromEmail);
}

export function resendApiConfigured(): boolean {
  return Boolean(config.email.resendApiKey);
}

const RESEND_USER_AGENT = "LoanGenius/0.1 (https://crm.smartr8.com)";

function resendHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${config.email.resendApiKey}`,
    "Content-Type": "application/json",
    "User-Agent": RESEND_USER_AGENT,
    ...extra,
  };
}

async function resendGet<T>(path: string): Promise<{ ok: boolean; data?: T; detail?: string; status?: number }> {
  if (!resendApiConfigured()) return { ok: false, detail: "RESEND_API_KEY is not set" };
  try {
    const res = await fetch(`https://api.resend.com${path}`, {
      method: "GET",
      headers: resendHeaders(),
    });
    const raw = await res.text().catch(() => "");
    const data = raw ? JSON.parse(raw) as T : undefined;
    if (!res.ok) return { ok: false, status: res.status, detail: raw || res.statusText, data };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, detail: String(err) };
  }
}

async function resendPatch<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; data?: T; detail?: string; status?: number }> {
  if (!resendApiConfigured()) return { ok: false, detail: "RESEND_API_KEY is not set" };
  try {
    const res = await fetch(`https://api.resend.com${path}`, {
      method: "PATCH",
      headers: resendHeaders(),
      body: JSON.stringify(body),
    });
    const raw = await res.text().catch(() => "");
    const data = raw ? JSON.parse(raw) as T : undefined;
    if (!res.ok) return { ok: false, status: res.status, detail: raw || res.statusText, data };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, detail: String(err) };
  }
}

async function resendPost<T>(
  path: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; data?: T; detail?: string; status?: number }> {
  if (!resendApiConfigured()) return { ok: false, detail: "RESEND_API_KEY is not set" };
  try {
    const res = await fetch(`https://api.resend.com${path}`, {
      method: "POST",
      headers: resendHeaders(),
      body: body ? JSON.stringify(body) : undefined,
    });
    const raw = await res.text().catch(() => "");
    const data = raw ? JSON.parse(raw) as T : undefined;
    if (!res.ok) return { ok: false, status: res.status, detail: raw || res.statusText, data };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, detail: String(err) };
  }
}

export async function listResendWebhooks(): Promise<{ ok: boolean; webhooks: ResendWebhook[]; detail?: string }> {
  const result = await resendGet<{ object?: string; data?: ResendWebhook[] }>("/webhooks");
  if (!result.ok) return { ok: false, webhooks: [], detail: result.detail };
  return { ok: true, webhooks: Array.isArray(result.data?.data) ? result.data.data : [] };
}

export async function retrieveResendWebhook(webhookId: string): Promise<ResendWebhook | null> {
  if (!webhookId) return null;
  const result = await resendGet<ResendWebhook>(`/webhooks/${encodeURIComponent(webhookId)}`);
  return result.ok && result.data ? result.data : null;
}

export async function listReceivedEmails(limit = 10): Promise<{ ok: boolean; emails: ResendReceivedEmail[]; detail?: string }> {
  const result = await resendGet<{ object?: string; data?: ResendReceivedEmail[] }>(`/emails/receiving?limit=${Math.max(1, Math.min(limit, 100))}`);
  if (!result.ok) return { ok: false, emails: [], detail: result.detail };
  return { ok: true, emails: Array.isArray(result.data?.data) ? result.data.data : [] };
}

export async function listSentEmails(
  opts: ListSentEmailsOptions = {},
): Promise<{ ok: boolean; emails: ResendSentEmail[]; has_more: boolean; detail?: string }> {
  if (opts.after && opts.before) {
    return { ok: false, emails: [], has_more: false, detail: "Use either after or before, not both" };
  }
  const parsedLimit = Number(opts.limit || 20);
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 100)) : 20;
  const query = new URLSearchParams({ limit: String(limit) });
  if (opts.after) query.set("after", opts.after);
  if (opts.before) query.set("before", opts.before);
  const result = await resendGet<{ object?: string; data?: ResendSentEmail[]; has_more?: boolean }>(`/emails?${query.toString()}`);
  if (!result.ok) return { ok: false, emails: [], has_more: false, detail: result.detail };
  return {
    ok: true,
    emails: Array.isArray(result.data?.data) ? result.data.data : [],
    has_more: Boolean(result.data?.has_more),
  };
}

export async function listSentEmailAttachments(
  emailId: string,
  opts: ListSentEmailsOptions = {},
): Promise<{ ok: boolean; attachments: ResendSentAttachment[]; has_more: boolean; detail?: string }> {
  const id = String(emailId || "").trim();
  if (!id) return { ok: false, attachments: [], has_more: false, detail: "email id is required" };
  if (opts.after && opts.before) {
    return { ok: false, attachments: [], has_more: false, detail: "Use either after or before, not both" };
  }
  const parsedLimit = Number(opts.limit || 20);
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 100)) : 20;
  const query = new URLSearchParams({ limit: String(limit) });
  if (opts.after) query.set("after", opts.after);
  if (opts.before) query.set("before", opts.before);
  const result = await resendGet<{ object?: string; data?: ResendSentAttachment[]; has_more?: boolean }>(
    `/emails/${encodeURIComponent(id)}/attachments?${query.toString()}`,
  );
  if (!result.ok) return { ok: false, attachments: [], has_more: false, detail: result.detail };
  return {
    ok: true,
    attachments: Array.isArray(result.data?.data) ? result.data.data : [],
    has_more: Boolean(result.data?.has_more),
  };
}

/**
 * Send a transactional email via the Resend HTTP API (no SDK — keeps deps minimal,
 * matching how Telnyx/GHL are called). `html` is optional; if omitted, `text` is sent.
 */
export async function sendEmail(opts: {
  to: EmailRecipient;
  subject: string;
  from?: string;
  html?: string;
  text?: string;
  replyTo?: EmailRecipient;
  /** Carbon-copy recipients (one address or a list) — e.g. a co-borrower or a partner. */
  cc?: string[];
  bcc?: string[];
  scheduledAt?: string;
  topicId?: string;
  tags?: ResendEmailTag[];
  template?: ResendEmailTemplate;
  idempotencyKey?: string;
  /** File attachments: filename + base64-encoded content (what Resend's API expects). */
  attachments?: Array<{ filename: string; content: string }>;
  /** Extra MIME headers, e.g. List-Unsubscribe / List-Unsubscribe-Post for
   *  Gmail + Yahoo one-click unsubscribe (CAN-SPAM / bulk sender rules). */
  headers?: Record<string, string>;
}): Promise<EmailResult> {
  if (!emailConfigured()) {
    return { ok: false, detail: "email not configured (set RESEND_API_KEY + EMAIL_FROM)" };
  }
  let to: string[];
  let cc: string[];
  let bcc: string[];
  try {
    to = normalizeRecipients(opts.to, "to", 50);
    cc = normalizeRecipients(opts.cc ?? [], "cc", 50);
    bcc = normalizeRecipients(opts.bcc ?? [], "bcc", 50);
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
  if (!to.length) return { ok: false, detail: "no recipient" };
  if (opts.template && (opts.html || opts.text)) {
    return { ok: false, detail: "Resend template sends cannot include html or text in the same payload" };
  }

  const body: Record<string, unknown> = {
    from: opts.from || config.email.fromEmail,
    to,
    subject: opts.subject,
  };
  if (cc.length) body.cc = cc;
  if (bcc.length) body.bcc = bcc;
  if (opts.attachments && opts.attachments.length) {
    body.attachments = opts.attachments
      .filter((a) => a && a.filename && a.content)
      .map((a) => ({ filename: a.filename, content: a.content }));
  }
  if (opts.template) {
    body.template = {
      id: opts.template.id,
      ...(opts.template.variables ? { variables: opts.template.variables } : {}),
    };
  } else {
    if (opts.html) body.html = opts.html;
    if (opts.text) body.text = opts.text;
    if (!opts.html && !opts.text) body.text = opts.subject;
  }
  const replyTo = opts.replyTo || config.email.replyTo;
  if (replyTo) body.reply_to = replyTo;
  if (opts.scheduledAt) body.scheduled_at = opts.scheduledAt;
  if (opts.topicId) body.topic_id = opts.topicId;
  if (opts.tags?.length) body.tags = sanitizeTags(opts.tags);
  if (opts.headers && Object.keys(opts.headers).length) body.headers = opts.headers;

  try {
    const headers = resendHeaders(opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {});
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const raw = await res.text().catch(() => "");
    if (!res.ok) {
      log.error(`Resend send failed ${res.status}: ${raw}`);
      return { ok: false, detail: `${res.status}: ${raw}` };
    }
    const data = raw ? (JSON.parse(raw) as { id?: string }) : {};
    log.info("email sent", { to, id: data.id });
    return { ok: true, id: data.id };
  } catch (err) {
    log.error("Resend send threw", { err: String(err) });
    return { ok: false, detail: String(err) };
  }
}

function normalizeRecipients(value: EmailRecipient | EmailRecipient[] | undefined, field: string, max: number): string[] {
  const raw = Array.isArray(value) ? value.flatMap((v) => (Array.isArray(v) ? v : [v])) : value ? [value] : [];
  const out = raw.map((v) => String(v).trim()).filter(Boolean);
  if (out.length > max) throw new Error(`${field} supports at most ${max} recipients`);
  return out;
}

function sanitizeTags(tags: ResendEmailTag[]): ResendEmailTag[] {
  return tags
    .map((tag) => ({ name: String(tag.name || "").trim(), value: String(tag.value || "").trim() }))
    .filter((tag) => tag.name && tag.value)
    .slice(0, 20);
}

function batchPayloadFromOptions(opts: SendEmailOptions): { ok: true; payload: Record<string, unknown> } | { ok: false; detail: string } {
  if (!emailConfigured()) return { ok: false, detail: "email not configured (set RESEND_API_KEY + EMAIL_FROM)" };
  if (opts.attachments?.length) return { ok: false, detail: "Resend batch does not support attachments yet" };
  if (opts.scheduledAt) return { ok: false, detail: "Resend batch does not support scheduled_at yet" };
  if (opts.template && (opts.html || opts.text)) {
    return { ok: false, detail: "Resend template sends cannot include html or text in the same payload" };
  }
  let to: string[];
  let cc: string[];
  let bcc: string[];
  try {
    to = normalizeRecipients(opts.to, "to", 50);
    cc = normalizeRecipients(opts.cc ?? [], "cc", 50);
    bcc = normalizeRecipients(opts.bcc ?? [], "bcc", 50);
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
  if (!to.length) return { ok: false, detail: "no recipient" };
  const payload: Record<string, unknown> = {
    from: opts.from || config.email.fromEmail,
    to,
    subject: opts.subject,
  };
  if (cc.length) payload.cc = cc;
  if (bcc.length) payload.bcc = bcc;
  const replyTo = opts.replyTo || config.email.replyTo;
  if (replyTo) payload.reply_to = replyTo;
  if (opts.topicId) payload.topic_id = opts.topicId;
  if (opts.tags?.length) payload.tags = sanitizeTags(opts.tags);
  if (opts.headers && Object.keys(opts.headers).length) payload.headers = opts.headers;
  if (opts.template) {
    payload.template = {
      id: opts.template.id,
      ...(opts.template.variables ? { variables: opts.template.variables } : {}),
    };
  } else {
    if (opts.html) payload.html = opts.html;
    if (opts.text) payload.text = opts.text;
    if (!opts.html && !opts.text) payload.text = opts.subject;
  }
  return { ok: true, payload };
}

export async function sendBatchEmails(
  emails: SendEmailOptions[],
  opts: { idempotencyKey?: string } = {},
): Promise<{ ok: boolean; ids: string[]; data?: Array<{ id?: string }>; detail?: string }> {
  if (!emailConfigured()) return { ok: false, ids: [], detail: "email not configured (set RESEND_API_KEY + EMAIL_FROM)" };
  if (!emails.length) return { ok: false, ids: [], detail: "batch requires at least one email" };
  if (emails.length > 100) return { ok: false, ids: [], detail: "Resend batch supports at most 100 emails per request" };
  const payload: Record<string, unknown>[] = [];
  for (const email of emails) {
    const built = batchPayloadFromOptions(email);
    if (!built.ok) return { ok: false, ids: [], detail: built.detail };
    payload.push(built.payload);
  }
  try {
    const headers = resendHeaders(opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {});
    const res = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const raw = await res.text().catch(() => "");
    if (!res.ok) {
      log.error(`Resend batch send failed ${res.status}: ${raw}`);
      return { ok: false, ids: [], detail: `${res.status}: ${raw}` };
    }
    const data = raw ? (JSON.parse(raw) as { data?: Array<{ id?: string }> }) : {};
    const rows = Array.isArray(data.data) ? data.data : [];
    return { ok: true, ids: rows.map((row) => row.id || "").filter(Boolean), data: rows };
  } catch (err) {
    log.error("Resend batch send threw", { err: String(err) });
    return { ok: false, ids: [], detail: String(err) };
  }
}

export async function retrieveReceivedEmail(emailId: string): Promise<ResendReceivedEmail | null> {
  if (!resendApiConfigured()) return null;
  if (!emailId) return null;

  try {
    const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}?html_format=data_uri`, {
      method: "GET",
      headers: resendHeaders(),
    });
    const raw = await res.text().catch(() => "");
    if (!res.ok) {
      log.error(`Resend received email retrieve failed ${res.status}: ${raw}`);
      return null;
    }
    return raw ? (JSON.parse(raw) as ResendReceivedEmail) : null;
  } catch (err) {
    log.error("Resend received email retrieve threw", { err: String(err), emailId });
    return null;
  }
}

export async function retrieveSentEmail(emailId: string): Promise<ResendSentEmail | null> {
  if (!emailId) return null;
  const result = await resendGet<ResendSentEmail>(`/emails/${encodeURIComponent(emailId)}`);
  return result.ok && result.data ? result.data : null;
}

export async function retrieveSentEmailAttachment(
  emailId: string,
  attachmentId: string,
): Promise<ResendSentAttachment | null> {
  const eid = String(emailId || "").trim();
  const aid = String(attachmentId || "").trim();
  if (!eid || !aid) return null;
  const result = await resendGet<ResendSentAttachment>(
    `/emails/${encodeURIComponent(eid)}/attachments/${encodeURIComponent(aid)}`,
  );
  return result.ok && result.data ? result.data : null;
}

export async function updateScheduledEmail(
  emailId: string,
  scheduledAt: string,
): Promise<ResendUpdateEmailResult> {
  const id = String(emailId || "").trim();
  const schedule = String(scheduledAt || "").trim();
  if (!id) return { ok: false, detail: "email id is required" };
  if (!schedule) return { ok: false, detail: "scheduled_at is required" };
  const when = Date.parse(schedule);
  if (!Number.isFinite(when)) return { ok: false, detail: "scheduled_at must be an ISO 8601 date" };
  const result = await resendPatch<{ object?: string; id?: string }>(`/emails/${encodeURIComponent(id)}`, {
    scheduled_at: new Date(when).toISOString(),
  });
  if (!result.ok) return { ok: false, detail: result.detail };
  return { ok: true, id: result.data?.id || id };
}

export async function cancelScheduledEmail(emailId: string): Promise<ResendCancelEmailResult> {
  const id = String(emailId || "").trim();
  if (!id) return { ok: false, detail: "email id is required" };
  const result = await resendPost<{ object?: string; id?: string }>(`/emails/${encodeURIComponent(id)}/cancel`);
  if (!result.ok) return { ok: false, detail: result.detail };
  return { ok: true, id: result.data?.id || id };
}
