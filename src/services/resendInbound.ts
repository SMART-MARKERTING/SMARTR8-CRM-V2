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
  if (cleaned) return Buffer.from(cleaned, "base64");
  return Buffer.from(secret, "utf8");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function verifySvixSignature(req: Request, payload: string): boolean {
  const secret = config.email.resendWebhookSecret;
  if (!secret) {
    log.warn("RESEND_WEBHOOK_SECRET is not set; accepting Resend inbound webhook without signature verification");
    return true;
  }

  const id = headerValue(req.headers["svix-id"] as string | string[] | undefined);
  const timestamp = headerValue(req.headers["svix-timestamp"] as string | string[] | undefined);
  const signature = headerValue(req.headers["svix-signature"] as string | string[] | undefined);
  if (!id || !timestamp || !signature) return false;

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) return false;
  const driftSeconds = Math.abs(Date.now() / 1000 - sentAt);
  if (driftSeconds > 5 * 60) return false;

  const signedContent = `${id}.${timestamp}.${payload}`;
  const expected = createHmac("sha256", decodeSvixSecret(secret)).update(signedContent).digest("base64");
  const candidates = signature
    .split(" ")
    .flatMap((part) => part.split(","))
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => part !== "v1");
  return candidates.some((candidate) => safeEqual(candidate, expected));
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

export async function handleResendInboundWebhook(req: Request, res: Response): Promise<void> {
  const payload = rawPayload(req);
  if (!verifySvixSignature(req, payload)) {
    res.status(401).json({ error: "invalid Resend webhook signature" });
    return;
  }

  const event = parseJson(payload);
  if (!event) {
    res.status(400).json({ error: "invalid JSON webhook payload" });
    return;
  }
  if (event.type !== "email.received") {
    res.json({ ok: true, ignored: true, type: event.type || null });
    return;
  }

  const eventData = event.data || {};
  const emailId = asString(eventData.email_id || eventData.id);
  const fetched = emailId ? await retrieveReceivedEmail(emailId) : null;
  const data = mergeReceived(eventData, fetched);
  const from = addressToString(data.from);
  const fromEmail = emailFromAddress(from);
  const displayName = displayNameFromAddress(from);
  const messageId = asString(data.message_id || (data.headers as Record<string, unknown> | undefined)?.["message-id"]);

  if (!fromEmail) {
    res.status(400).json({ error: "received email missing sender address" });
    return;
  }
  if (inboundAlreadyStored(emailId, messageId)) {
    res.json({ ok: true, duplicate: true, emailId: emailId || null });
    return;
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
      received_for: addressList(data.to).join(", "),
      attachments: Array.isArray(data.attachments) ? data.attachments : [],
      raw: data.raw || null,
      html: html || null,
      webhook_created_at: event.created_at || null,
      verified: Boolean(config.email.resendWebhookSecret),
    },
  });

  res.json({ ok: true, stored: true, leadId: lead.id, activityId: activity.id, emailId: emailId || null });
}
