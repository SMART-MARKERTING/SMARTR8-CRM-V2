import { config } from "../config";
import { log } from "../logger";

export interface EmailResult {
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
