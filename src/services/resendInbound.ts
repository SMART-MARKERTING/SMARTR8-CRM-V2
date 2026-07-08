import { createHmac, timingSafeEqual } from "crypto";
import type { Request, Response } from "express";
import { config } from "../config";
import { log } from "../logger";
import { db } from "../store/db";
import { createLead, findLead, logActivity } from "./leads";
import { retrieveReceivedEmail, type ResendReceivedEmail } from "./email";

interface ResendWebhookEvent {
  type?: string;
  created_at?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface StoreReceivedEmailResult {
  ok: boolean;
  stored?: boolean;
  duplicate?: boolean;
  leadId?: string;
  activityId?: string;
  emailId?: string | null;
  error?: string;
}

export interface ResendInboundWebhookHit {
  at: string;
  ok: boolean;
  status: number;
  reason: string;
  type: string | null;
  emailId: string | null;
  from: string | null;
  to: string[];
  hasSvixHeaders: boolean;
  stored?: boolean;
  duplicate?: boolean;
  leadId?: string;
  activityId?: string;
}

const recentWebhookHits: ResendInboundWebhookHit[] = [];

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function rawPayload(req: Request): string {
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  if (typeof req.body === "string") return req.body;
  return JSON.stringify(req.body ?? {});
}

function decodeSvixSecret(secret: string): Buffer {
  const cleaned = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : "";
  if (cleaned) {
    const normalized = cleaned.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return Buffer.from(padded, "base64");
  }
  return Buffer.from(secret, "utf8");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function verifySvixSignatureHeaders(
  headers: { id?: string; timestamp?: string; signature?: string },
  payload: string,
  now = Date.now(),
): { ok: boolean; reason: string; hasSvixHeaders: boolean } {
  const secret = config.email.resendWebhookSecret;
  if (!secret) {
    log.warn("RESEND_WEBHOOK_SECRET is not set; accepting Resend inbound webhook without signature verification");
    return { ok: true, reason: "secret-not-set", hasSvixHeaders: Boolean(headers.id || headers.timestamp || headers.signature) };
  }

  const id = headers.id || "";
  const timestamp = headers.timestamp || "";
  const signature = headers.signature || "";
  const hasSvixHeaders = Boolean(id || timestamp || signature);
  if (!id || !timestamp || !signature) return { ok: false, reason: "missing-svix-headers", hasSvixHeaders };

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) return { ok: false, reason: "bad-svix-timestamp", hasSvixHeaders };
  const driftSeconds = Math.abs(now / 1000 - sentAt);
  if (driftSeconds > 5 * 60) return { ok: false, reason: "stale-svix-timestamp", hasSvixHeaders };

  const signedContent = `${id}.${timestamp}.${payload}`;
  const expected = createHmac("sha256", decodeSvixSecret(secret)).update(signedContent).digest("base64");
  const candidates = signature
    .split(" ")
    .flatMap((part) => part.split(","))
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => part !== "v1");
  const ok = candidates.some((candidate) => safeEqual(candidate, expected));
  return { ok, reason: ok ? "verified" : "signature-mismatch", hasSvixHeaders };
}

function verifySvixSignature(req: Request, payload: string): { ok: boolean; reason: string; hasSvixHeaders: boolean } {
  return verifySvixSignatureHeaders(
    {
      id: headerValue(req.headers["svix-id"] as string | string[] | undefined),
      timestamp: headerValue(req.headers["svix-timestamp"] as string | string[] | undefined),
      signature: headerValue(req.headers["svix-signature"] as string | string[] | undefined),
    },
    payload,
  );
}

function parseJson(payload: string): ResendWebhookEvent | null {
  try {
    return JSON.parse(payload) as ResendWebhookEvent;
  } catch {
    return null;
  }
}

function addressToString(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return addressToString(value[0]);
  if (typeof value === "object") {
    const row = value as Record<string, unknown>;
    const email = String(row.email || row.address || "").trim();
    const name = String(row.name || "").trim();
    if (email && name) return `${name} <${email}>`;
    return email || name;
  }
  return String(value);
}

function addressList(value: unknown): string[] {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map(addressToString).map((s) => s.trim()).filter(Boolean);
}

function emailFromAddress(value: string): string {
  const match = value.match(/<([^<>@\s]+@[^<>@\s]+)>/);
  if (match) return match[1].trim().toLowerCase();
  const bare = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return bare ? bare[0].trim().toLowerCase() : "";
}

function displayNameFromAddress(value: string): string {
  const before = value.split("<")[0]?.trim().replace(/^"|"$/g, "");
  return before || emailFromAddress(value);
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function mergeReceived(data: Record<string, unknown>, fetched: ResendReceivedEmail | null): Record<string, unknown> {
  return { ...data, ...(fetched || {}) };
}

function eventSummary(event: ResendWebhookEvent | null): Pick<ResendInboundWebhookHit, "type" | "emailId" | "from" | "to"> {
  const data = event?.data || {};
  return {
    type: event?.type || null,
    emailId: asString(data.email_id || data.id) || null,
    from: addressToString(data.from) || null,
    to: addressList(data.to),
  };
}

function recordWebhookHit(hit: Omit<ResendInboundWebhookHit, "at">): void {
  recentWebhookHits.unshift({ at: new Date().toISOString(), ...hit });
  if (recentWebhookHits.length > 25) recentWebhookHits.pop();
}

export function getRecentResendInboundWebhookHits(): ResendInboundWebhookHit[] {
  return recentWebhookHits.slice();
}

export function selfTestResendWebhookSignature(): boolean | null {
  if (!config.email.resendWebhookSecret) return null;
  const payload = `{"type":"email.received","data":{"email_id":"self-test"}}`;
  const id = "msg_self_test";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", decodeSvixSecret(config.email.resendWebhookSecret))
    .update(`${id}.${timestamp}.${payload}`)
    .digest("base64");
  return verifySvixSignatureHeaders({ id, timestamp, signature: `v1,${signature}` }, payload).ok;
}

function inboundAlreadyStored(emailId: string, messageId: string): boolean {
  const needle = emailId || messageId;
  if (!needle) return false;
  const row = db
    .prepare(
      `SELECT id FROM activities
       WHERE type = 'email'
         AND direction = 'inbound'
         AND deleted_at IS NULL
         AND meta LIKE ?
       LIMIT 1`,
    )
    .get(`%${needle}%`) as { id: string } | undefined;
  return Boolean(row);
}

export async function storeReceivedEmail(
  eventData: Record<string, unknown>,
  opts: { eventCreatedAt?: string; verified?: boolean; fetchFull?: boolean } = {},
): Promise<StoreReceivedEmailResult> {
  const emailId = asString(eventData.email_id || eventData.id);
  const fetched = emailId && opts.fetchFull !== false ? await retrieveReceivedEmail(emailId) : null;
  const data = mergeReceived(eventData, fetched);
  const from = addressToString(data.from);
  const fromEmail = emailFromAddress(from);
  const displayName = displayNameFromAddress(from);
  const messageId = asString(data.message_id || (data.headers as Record<string, unknown> | undefined)?.["message-id"]);

  if (!fromEmail) {
    return { ok: false, emailId: emailId || null, error: "received email missing sender address" };
  }
  if (inboundAlreadyStored(emailId, messageId)) {
    return { ok: true, duplicate: true, emailId: emailId || null };
  }

  const lead = findLead({ email: fromEmail }) || createLead({
    name: displayName || fromEmail,
    email: fromEmail,
    source: "resend-inbound",
    contact_only: true,
    tags: ["email inbound"],
  });
  const subject = asString(data.subject) || "(no subject)";
  const text = asString(data.text);
  const html = asString(data.html);
  const body = text || (html && !html.startsWith("data:") ? stripHtml(html) : "") || "Inbound email received via Resend.";
  const receivedFor = addressList(data.received_for).length ? addressList(data.received_for) : addressList(data.to);
  const activity = logActivity(lead.id, {
    type: "email",
    direction: "inbound",
    channel: "email",
    subject,
    body,
    status: "received",
    meta: {
      resend: true,
      resend_email_id: emailId || null,
      message_id: messageId || null,
      from,
      from_email: fromEmail,
      to: addressList(data.to),
      cc: addressList(data.cc),
      bcc: addressList(data.bcc),
      received_for: receivedFor,
      attachments: Array.isArray(data.attachments) ? data.attachments : [],
      raw: data.raw || null,
      html: html || null,
      webhook_created_at: opts.eventCreatedAt || null,
      verified: opts.verified ?? Boolean(config.email.resendWebhookSecret),
      sync_source: opts.eventCreatedAt ? "webhook" : "manual_sync",
    },
  });

  return { ok: true, stored: true, leadId: lead.id, activityId: activity.id, emailId: emailId || null };
}

export async function handleResendInboundWebhook(req: Request, res: Response): Promise<void> {
  const payload = rawPayload(req);
  const verification = verifySvixSignature(req, payload);
  if (!verification.ok) {
    const summary = eventSummary(parseJson(payload));
    recordWebhookHit({
      ok: false,
      status: 401,
      reason: verification.reason,
      hasSvixHeaders: verification.hasSvixHeaders,
      ...summary,
    });
    res.status(401).json({ error: "invalid Resend webhook signature" });
    return;
  }

  const event = parseJson(payload);
  if (!event) {
    recordWebhookHit({
      ok: false,
      status: 400,
      reason: "invalid-json",
      hasSvixHeaders: verification.hasSvixHeaders,
      type: null,
      emailId: null,
      from: null,
      to: [],
    });
    res.status(400).json({ error: "invalid JSON webhook payload" });
    return;
  }
  if (event.type !== "email.received") {
    recordWebhookHit({
      ok: true,
      status: 200,
      reason: "ignored-event-type",
      hasSvixHeaders: verification.hasSvixHeaders,
      ...eventSummary(event),
    });
    res.json({ ok: true, ignored: true, type: event.type || null });
    return;
  }

  const result = await storeReceivedEmail(event.data || {}, {
    eventCreatedAt: event.created_at,
    verified: Boolean(config.email.resendWebhookSecret),
  });
  if (!result.ok) {
    recordWebhookHit({
      ok: false,
      status: 400,
      reason: result.error || "store-failed",
      hasSvixHeaders: verification.hasSvixHeaders,
      ...eventSummary(event),
    });
    res.status(400).json({ error: result.error || "received email could not be stored", emailId: result.emailId || null });
    return;
  }
  recordWebhookHit({
    ok: true,
    status: 200,
    reason: result.duplicate ? "duplicate" : "stored",
    hasSvixHeaders: verification.hasSvixHeaders,
    stored: Boolean(result.stored),
    duplicate: Boolean(result.duplicate),
    leadId: result.leadId,
    activityId: result.activityId,
    ...eventSummary(event),
  });
  res.json(result);
}
