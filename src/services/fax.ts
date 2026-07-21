import fs from "fs";
import path from "path";
import { randomBytes, randomUUID } from "crypto";
import { config } from "../config";
import { log } from "../logger";
import { db } from "../store/db";
import { toE164 } from "../util/phone";
import { getLead, findLead, logActivity, type Lead } from "./leads";
import { getLeadDocument, getLeadDocumentPath, saveLeadDocument } from "./documents";
import { createNotificationEvent } from "./notifications";

const FAX_DIR = path.resolve(process.cwd(), config.tokenDir, "fax-files");
const MAX_FAX_BYTES = 25 * 1024 * 1024;
const MEDIA_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
fs.mkdirSync(FAX_DIR, { recursive: true });

export interface FaxRecord {
  id: string;
  provider_fax_id: string | null;
  lead_id: string | null;
  document_id: string | null;
  direction: "inbound" | "outbound";
  from_number: string;
  to_number: string;
  status: string;
  page_count: number | null;
  failure_reason: string | null;
  original_name: string | null;
  stored_name: string | null;
  mime: string | null;
  size: number | null;
  access_token: string | null;
  access_expires_at: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  deleted_at: number | null;
  lead_name?: string | null;
  lead_phone?: string | null;
}

export interface SendFaxOptions {
  to: string;
  lead?: Lead | null;
  documentId?: string;
  buffer?: Buffer;
  filename?: string;
  baseUrl: string;
  author?: string;
}

function safeFilename(value: string): string {
  const name = path.basename(value || "fax.pdf").replace(/[^\w.\-() ]+/g, "_").slice(0, 160) || "fax.pdf";
  return name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf`;
}

function validatePdf(buffer: Buffer): void {
  if (!buffer.length) throw new Error("fax attachment is empty");
  if (buffer.length > MAX_FAX_BYTES) throw new Error("fax attachment is limited to 25 MB");
  if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("fax attachment must be a valid PDF");
}

function normalizedFaxNumber(value: string, label: string): string {
  const number = toE164(value || "");
  if (!/^\+\d{10,15}$/.test(number)) throw new Error(`${label} must be a valid E.164 fax number`);
  return number;
}

function standalonePath(storedName: string | null): string | null {
  if (!storedName || !/^[A-Za-z0-9._-]+$/.test(storedName)) return null;
  const full = path.resolve(FAX_DIR, storedName);
  return full.startsWith(`${FAX_DIR}${path.sep}`) ? full : null;
}

function writeStandalone(recordId: string, buffer: Buffer): string {
  validatePdf(buffer);
  const storedName = `${recordId}.pdf`;
  const full = standalonePath(storedName);
  if (!full) throw new Error("invalid fax storage path");
  fs.writeFileSync(full, buffer);
  return storedName;
}

function responseDetail(data: unknown, fallback: string): string {
  if (!data || typeof data !== "object") return fallback;
  const body = data as Record<string, unknown>;
  if (typeof body.error === "string") return body.error;
  if (Array.isArray(body.errors) && body.errors.length) {
    return body.errors.map((item) => {
      if (!item || typeof item !== "object") return String(item);
      const err = item as Record<string, unknown>;
      return String(err.detail || err.title || err.code || "Telnyx fax error");
    }).join("; ");
  }
  return fallback;
}

function getByProviderId(providerFaxId: string): FaxRecord | null {
  const row = db.prepare(`SELECT * FROM fax_records WHERE provider_fax_id = ? LIMIT 1`).get(providerFaxId) as FaxRecord | undefined;
  return row || null;
}

export function getFaxRecord(id: string): FaxRecord | null {
  const row = db.prepare(`SELECT * FROM fax_records WHERE id = ? AND deleted_at IS NULL`).get(id) as FaxRecord | undefined;
  return row || null;
}

export function getFaxRecordByMediaToken(token: string): FaxRecord | null {
  const row = db
    .prepare(`SELECT * FROM fax_records WHERE access_token = ? AND access_expires_at > ? AND deleted_at IS NULL LIMIT 1`)
    .get(token, Date.now()) as FaxRecord | undefined;
  return row || null;
}

export function getFaxFilePath(record: FaxRecord): string | null {
  if (record.document_id) {
    const doc = getLeadDocument(record.document_id);
    if (doc) return getLeadDocumentPath(doc);
  }
  const full = standalonePath(record.stored_name);
  return full && fs.existsSync(full) ? full : null;
}

export function faxConfiguration() {
  const outboundConfigured = Boolean(config.telnyx.apiKey && config.fax.applicationId && config.fax.fromNumber);
  const webhookConfigured = Boolean(config.telnyx.publicKey);
  return {
    configured: outboundConfigured && webhookConfigured,
    outboundConfigured,
    webhookConfigured,
    apiKeySet: Boolean(config.telnyx.apiKey),
    publicKeySet: Boolean(config.telnyx.publicKey),
    applicationIdSet: Boolean(config.fax.applicationId),
    fromNumber: config.fax.fromNumber || null,
    webhookPath: "/api/webhooks/telnyx/fax",
  };
}

const TERMINAL_FAX_STATUSES = new Set(["delivered", "received", "failed", "canceled", "cancelled"]);

function normalizedProviderStatus(value: unknown): string {
  const raw = String(value || "").trim().toLowerCase();
  const statuses: Record<string, string> = {
    "media.processed": "media_processed",
    "media.processing": "media_processing",
    "media.processing.started": "media_processing",
    "sending.started": "sending",
    originated: "sending",
    cancelled: "canceled",
  };
  return statuses[raw] || raw.replace(/\./g, "_");
}

/** Recover final delivery state when a Telnyx webhook was missed or rejected. */
async function reconcileFaxRecord(record: FaxRecord): Promise<FaxRecord> {
  if (!config.telnyx.apiKey || !record.provider_fax_id || record.direction !== "outbound" || TERMINAL_FAX_STATUSES.has(record.status)) {
    return record;
  }
  try {
    const response = await fetch(`${config.telnyx.apiBase}/v2/faxes/${encodeURIComponent(record.provider_fax_id)}`, {
      headers: { Authorization: `Bearer ${config.telnyx.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      log.warn("Telnyx fax status reconciliation failed", { faxId: record.id, statusCode: response.status });
      return record;
    }
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    const data = body.data && typeof body.data === "object" ? body.data as Record<string, unknown> : {};
    const status = normalizedProviderStatus(data.status);
    if (!status) return record;
    const pageCount = Number.isFinite(Number(data.page_count)) ? Number(data.page_count) : record.page_count;
    const failureReason = failureText(data.failure_reason || data.error);
    const now = Date.now();
    const completedAt = TERMINAL_FAX_STATUSES.has(status) ? (record.completed_at || now) : record.completed_at;
    db.prepare(
      `UPDATE fax_records
          SET status = ?, page_count = ?, failure_reason = COALESCE(?, failure_reason),
              updated_at = ?, completed_at = ?
        WHERE id = ?`,
    ).run(status, pageCount, failureReason, now, completedAt, record.id);
    const updated = getFaxRecord(record.id) || record;
    if (!TERMINAL_FAX_STATUSES.has(record.status) && TERMINAL_FAX_STATUSES.has(status)) {
      const subject = status === "delivered" ? "Fax delivered" : status === "failed" ? "Fax failed" : "Fax canceled";
      faxActivity(updated, subject, `${subject} to ${updated.to_number}${failureReason ? `: ${failureReason}` : ""}`, status, "Telnyx status sync");
    }
    return { ...record, ...updated };
  } catch (error) {
    log.warn("Telnyx fax status reconciliation error", { faxId: record.id, err: error instanceof Error ? error.message : String(error) });
    return record;
  }
}

export async function reconcileFaxStatuses(records: FaxRecord[], limit = 25): Promise<FaxRecord[]> {
  const candidates = records
    .filter((record) => record.direction === "outbound" && Boolean(record.provider_fax_id) && !TERMINAL_FAX_STATUSES.has(record.status))
    .slice(0, Math.max(0, Math.min(limit, 25)));
  if (!candidates.length || !config.telnyx.apiKey) return records;
  const refreshed = await Promise.all(candidates.map((record) => reconcileFaxRecord(record)));
  const byId = new Map(refreshed.map((record) => [record.id, record]));
  return records.map((record) => byId.get(record.id) || record);
}

export function listFaxRecords(opts: { limit?: number; leadId?: string; ownerUserId?: string } = {}): FaxRecord[] {
  const limit = Math.max(1, Math.min(opts.limit || 100, 500));
  const where = ["f.deleted_at IS NULL"];
  const params: Record<string, unknown> = { limit };
  if (opts.leadId) {
    where.push("f.lead_id = @leadId");
    params.leadId = opts.leadId;
  }
  if (opts.ownerUserId) {
    where.push("f.lead_id IS NOT NULL");
    where.push("l.owner_user_id = @ownerUserId");
    params.ownerUserId = opts.ownerUserId;
  }
  return db.prepare(
    `SELECT f.*,
            TRIM(COALESCE(l.first_name, '') || ' ' || COALESCE(l.last_name, '')) AS lead_name,
            l.phone AS lead_phone
       FROM fax_records f
       LEFT JOIN leads l ON l.id = f.lead_id
      WHERE ${where.join(" AND ")}
      ORDER BY f.created_at DESC
      LIMIT @limit`,
  ).all(params) as FaxRecord[];
}

function faxActivity(record: FaxRecord, subject: string, body: string, status: string, author?: string): void {
  if (!record.lead_id) return;
  logActivity(record.lead_id, {
    type: "fax",
    direction: record.direction,
    channel: "fax",
    subject,
    body,
    status,
    meta: {
      faxId: record.id,
      providerFaxId: record.provider_fax_id,
      from: record.from_number,
      to: record.to_number,
      pageCount: record.page_count,
      documentId: record.document_id,
      author: author || null,
    },
  });
}

export async function sendFax(opts: SendFaxOptions): Promise<FaxRecord> {
  if (!config.telnyx.apiKey) throw new Error("TELNYX_API_KEY is not configured");
  if (!config.fax.applicationId) throw new Error("TELNYX_FAX_APPLICATION_ID is not configured");
  if (!config.fax.fromNumber) throw new Error("TELNYX_FAX_FROM_NUMBER is not configured");
  const to = normalizedFaxNumber(opts.to, "destination");
  const from = normalizedFaxNumber(config.fax.fromNumber, "fax sender");
  const now = Date.now();
  const id = randomUUID();
  const accessToken = randomBytes(32).toString("hex");
  let documentId: string | null = null;
  let originalName = safeFilename(opts.filename || "fax.pdf");
  let storedName: string | null = null;
  let size = 0;

  if (opts.documentId) {
    const doc = getLeadDocument(opts.documentId);
    if (!doc) throw new Error("selected document was not found");
    if (opts.lead && doc.lead_id !== opts.lead.id) throw new Error("selected document belongs to another lead");
    if (doc.mime !== "application/pdf" && !doc.original_name.toLowerCase().endsWith(".pdf")) {
      throw new Error("Telnyx fax attachments must be PDF files");
    }
    const full = getLeadDocumentPath(doc);
    if (!full) throw new Error("selected document file is missing");
    documentId = doc.id;
    originalName = doc.original_name;
    size = doc.size;
  } else {
    if (!opts.buffer) throw new Error("attach a PDF to send");
    validatePdf(opts.buffer);
    storedName = writeStandalone(id, opts.buffer);
    size = opts.buffer.length;
  }

  db.prepare(
    `INSERT INTO fax_records
      (id, provider_fax_id, lead_id, document_id, direction, from_number, to_number, status,
       page_count, failure_reason, original_name, stored_name, mime, size, access_token,
       access_expires_at, created_at, updated_at, completed_at, deleted_at)
     VALUES
      (@id, NULL, @lead_id, @document_id, 'outbound', @from_number, @to_number, 'preparing',
       NULL, NULL, @original_name, @stored_name, 'application/pdf', @size, @access_token,
       @access_expires_at, @created_at, @updated_at, NULL, NULL)`,
  ).run({
    id,
    lead_id: opts.lead?.id || null,
    document_id: documentId,
    from_number: from,
    to_number: to,
    original_name: originalName,
    stored_name: storedName,
    size,
    access_token: accessToken,
    access_expires_at: now + MEDIA_TOKEN_TTL_MS,
    created_at: now,
    updated_at: now,
  });

  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const mediaUrl = `${baseUrl}/api/fax/media/${accessToken}`;
  const response = await fetch(`${config.telnyx.apiBase}/v2/faxes`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.telnyx.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      connection_id: config.fax.applicationId,
      media_url: mediaUrl,
      to,
      from,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const detail = responseDetail(payload, `Telnyx fax send failed (${response.status})`);
    db.prepare(`UPDATE fax_records SET status = 'failed', failure_reason = ?, updated_at = ?, completed_at = ? WHERE id = ?`)
      .run(detail, Date.now(), Date.now(), id);
    throw new Error(detail);
  }

  const data = payload.data && typeof payload.data === "object" ? payload.data as Record<string, unknown> : {};
  const providerFaxId = String(data.id || "").trim() || null;
  const status = String(data.status || "queued").trim() || "queued";
  db.prepare(`UPDATE fax_records SET provider_fax_id = ?, status = ?, updated_at = ? WHERE id = ?`)
    .run(providerFaxId, status, Date.now(), id);
  const record = getFaxRecord(id)!;
  faxActivity(record, "Fax queued", `Fax queued to ${to}: ${originalName}`, status, opts.author);
  return record;
}

async function downloadInboundPdf(mediaUrl: string): Promise<Buffer> {
  const parsed = new URL(mediaUrl);
  if (parsed.protocol !== "https:") throw new Error("Telnyx inbound fax media URL must use HTTPS");
  const response = await fetch(parsed, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`could not download inbound fax PDF (${response.status})`);
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_FAX_BYTES) throw new Error("inbound fax exceeds the 25 MB storage limit");
  const buffer = Buffer.from(await response.arrayBuffer());
  validatePdf(buffer);
  return buffer;
}

function statusFromEvent(eventType: string, payloadStatus: unknown): string {
  const statuses: Record<string, string> = {
    "fax.queued": "queued",
    "fax.media.processed": "media_processed",
    "fax.sending.started": "sending",
    "fax.delivered": "delivered",
    "fax.receiving.started": "receiving",
    "fax.media.processing.started": "media_processing",
    "fax.received": "received",
    "fax.failed": "failed",
  };
  return statuses[eventType] || String(payloadStatus || "processing");
}

function failureText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") return value.slice(0, 1000);
  try { return JSON.stringify(value).slice(0, 1000); } catch { return String(value).slice(0, 1000); }
}

export async function handleFaxWebhook(body: unknown): Promise<{ duplicate: boolean; record: FaxRecord | null; eventType: string }> {
  const envelope = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const data = envelope.data && typeof envelope.data === "object" ? envelope.data as Record<string, unknown> : {};
  const payload = data.payload && typeof data.payload === "object" ? data.payload as Record<string, unknown> : {};
  const eventId = String(data.id || "").trim();
  const eventType = String(data.event_type || "").trim();
  const providerFaxId = String(payload.fax_id || payload.id || "").trim();
  if (!eventId || !eventType || !providerFaxId || !eventType.startsWith("fax.")) {
    throw new Error("invalid Telnyx fax webhook payload");
  }
  const seen = db.prepare(`SELECT 1 FROM fax_events WHERE event_id = ?`).get(eventId);
  if (seen) return { duplicate: true, record: getByProviderId(providerFaxId), eventType };

  const direction = String(payload.direction || "inbound") === "outbound" ? "outbound" : "inbound";
  const from = normalizedFaxNumber(String(payload.from || payload.caller_id || config.fax.fromNumber || ""), "fax sender");
  const to = normalizedFaxNumber(String(payload.to || config.fax.fromNumber || ""), "fax destination");
  const now = Date.now();
  let record = getByProviderId(providerFaxId);
  if (!record) {
    const matchedLead = findLead({ phone: direction === "inbound" ? from : to });
    const id = randomUUID();
    db.prepare(
      `INSERT INTO fax_records
        (id, provider_fax_id, lead_id, document_id, direction, from_number, to_number, status,
         page_count, failure_reason, original_name, stored_name, mime, size, access_token,
         access_expires_at, created_at, updated_at, completed_at, deleted_at)
       VALUES
        (?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL)`,
    ).run(id, providerFaxId, matchedLead?.id || null, direction, from, to, statusFromEvent(eventType, payload.status), now, now);
    record = getFaxRecord(id);
  }
  if (!record) throw new Error("could not create fax record");

  const status = statusFromEvent(eventType, payload.status);
  const pageCount = Number.isFinite(Number(payload.page_count)) ? Number(payload.page_count) : record.page_count;
  const failureReason = failureText(payload.failure_reason || payload.error);
  const complete = ["delivered", "received", "failed"].includes(status) ? now : record.completed_at;
  db.prepare(
    `UPDATE fax_records
        SET status = ?, page_count = ?, failure_reason = COALESCE(?, failure_reason),
            updated_at = ?, completed_at = ?
      WHERE id = ?`,
  ).run(status, pageCount, failureReason, now, complete, record.id);
  record = getFaxRecord(record.id)!;

  if (eventType === "fax.received" && !record.document_id && !getFaxFilePath(record)) {
    const mediaUrl = String(payload.media_url || "").trim();
    if (!mediaUrl) throw new Error("fax.received did not include a media_url");
    const buffer = await downloadInboundPdf(mediaUrl);
    const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
    const filename = safeFilename(`fax-from-${from.replace(/\D/g, "")}-${stamp}.pdf`);
    const lead = record.lead_id ? getLead(record.lead_id) : null;
    if (lead) {
      const doc = saveLeadDocument({
        lead,
        buffer,
        filename,
        displayName: `Fax from ${from}`,
        folderName: "Fax",
        docType: "fax",
        notes: `Inbound fax received by ${to}`,
        uploadedBy: "Telnyx Fax",
      });
      db.prepare(`UPDATE fax_records SET document_id = ?, original_name = ?, mime = ?, size = ?, updated_at = ? WHERE id = ?`)
        .run(doc.id, filename, "application/pdf", buffer.length, Date.now(), record.id);
    } else {
      const storedName = writeStandalone(record.id, buffer);
      db.prepare(`UPDATE fax_records SET original_name = ?, stored_name = ?, mime = ?, size = ?, updated_at = ? WHERE id = ?`)
        .run(filename, storedName, "application/pdf", buffer.length, Date.now(), record.id);
    }
    record = getFaxRecord(record.id)!;
  }

  if (["fax.received", "fax.delivered", "fax.failed"].includes(eventType)) {
    const subject = eventType === "fax.received" ? "Fax received" : eventType === "fax.delivered" ? "Fax delivered" : "Fax failed";
    const otherParty = direction === "inbound" ? from : to;
    faxActivity(record, subject, `${subject} ${direction === "inbound" ? "from" : "to"} ${otherParty}${failureReason ? `: ${failureReason}` : ""}`, status);
  }

  db.prepare(`INSERT OR IGNORE INTO fax_events (event_id, fax_id, event_type, created_at) VALUES (?, ?, ?, ?)`)
    .run(eventId, record.id, eventType, now);
  if (eventType === "fax.received" && direction === "inbound") {
    const lead = record.lead_id ? getLead(record.lead_id) : null;
    createNotificationEvent({
      kind: "incoming_fax",
      provider: "telnyx",
      providerEventId: eventId,
      sourceType: "fax",
      sourceRecordId: record.id,
      leadId: record.lead_id,
      deepLink: `/v2/?page=fax&fax=${encodeURIComponent(record.id)}`,
      contactFirstName: lead?.first_name,
    });
  }
  log.info("Telnyx fax event processed", { eventType, faxId: record.id, providerFaxId, status });
  return { duplicate: false, record, eventType };
}

export function assignFaxToLead(record: FaxRecord, lead: Lead, author?: string): FaxRecord {
  if (record.lead_id === lead.id && record.document_id) return record;
  const full = getFaxFilePath(record);
  if (!full) throw new Error("fax PDF is not available to file");
  const buffer = fs.readFileSync(full);
  const filename = safeFilename(record.original_name || `fax-${record.id}.pdf`);
  const doc = saveLeadDocument({
    lead,
    buffer,
    filename,
    displayName: record.direction === "inbound" ? `Fax from ${record.from_number}` : `Fax to ${record.to_number}`,
    folderName: "Fax",
    docType: "fax",
    notes: `${record.direction === "inbound" ? "Received" : "Sent"} fax filed from the Fax app`,
    uploadedBy: author,
  });
  if (record.stored_name) {
    const old = standalonePath(record.stored_name);
    if (old && fs.existsSync(old)) fs.unlinkSync(old);
  }
  db.prepare(`UPDATE fax_records SET lead_id = ?, document_id = ?, stored_name = NULL, updated_at = ? WHERE id = ?`)
    .run(lead.id, doc.id, Date.now(), record.id);
  const updated = getFaxRecord(record.id)!;
  faxActivity(updated, "Fax filed", `Fax filed to ${lead.first_name || "lead"}'s Fax folder`, "filed", author);
  return updated;
}

export function deleteFaxRecord(record: FaxRecord): void {
  db.prepare(`UPDATE fax_records SET deleted_at = COALESCE(deleted_at, ?), updated_at = ? WHERE id = ?`)
    .run(Date.now(), Date.now(), record.id);
}
