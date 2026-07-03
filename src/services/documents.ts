import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { config } from "../config";
import { db } from "../store/db";
import { Lead, getLead, logActivity, updateLead } from "./leads";

const DOCUMENT_DIR = path.resolve(process.cwd(), config.tokenDir, "documents");
fs.mkdirSync(DOCUMENT_DIR, { recursive: true });

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".heic": "image/heic",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv",
  ".txt": "text/plain",
};

const DOC_CUSTOM_KEYS: Record<string, string> = {
  photo_id: "photo_id_uploaded_at",
  borrower_authorization: "borrower_authorization_at",
  loan_application: "loan_application_at",
  credit_report: "credit_report_at",
  income_assets: "income_docs_at",
  property_insurance: "property_insurance_at",
  purchase_contract: "purchase_contract_at",
  payoff_statement: "payoff_statement_at",
  rent_roll_or_lease: "rent_roll_at",
  entity_documents: "entity_docs_at",
};

const DOC_CLASSIFIERS: Array<{ type: string; re: RegExp }> = [
  { type: "photo_id", re: /\b(driver|license|passport|photo.?id|government.?id|id.?card)\b/i },
  { type: "borrower_authorization", re: /\b(auth|authorization|consent|borrower.?cert|credit.?authorization)\b/i },
  { type: "loan_application", re: /\b(urla|1003|loan.?application|application.?summary|intake)\b/i },
  { type: "credit_report", re: /\b(credit.?report|xactus|tri.?merge|credit.?pull|fico)\b/i },
  { type: "income_assets", re: /\b(pay.?stub|payroll|w2|1099|tax.?return|bank.?statement|asset|income|profit.?loss|p&l)\b/i },
  { type: "property_insurance", re: /\b(insurance|hazard|homeowners|hoi|declarations?|policy)\b/i },
  { type: "purchase_contract", re: /\b(purchase.?contract|sales.?contract|purchase.?agreement|offer)\b/i },
  { type: "payoff_statement", re: /\b(payoff|mortgage.?statement|loan.?statement)\b/i },
  { type: "rent_roll_or_lease", re: /\b(rent.?roll|lease|rental.?agreement)\b/i },
  { type: "entity_documents", re: /\b(operating.?agreement|articles|ein|entity|llc|corporation)\b/i },
];

export interface LeadDocument {
  id: string;
  lead_id: string;
  created_at: number;
  uploaded_by: string | null;
  original_name: string;
  stored_name: string;
  mime: string;
  size: number;
  doc_type: string;
  notes: string | null;
  deleted_at: number | null;
}

function cleanFilename(name: string): string {
  return path.basename(name || "document").replace(/[^\w.\-() ]+/g, "_").slice(0, 160) || "document";
}

function docTypeLabel(docType: string): string {
  return docType
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function classifyDocumentType(filename: string, suppliedType?: string): string {
  const requested = String(suppliedType || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (requested && requested !== "auto" && requested !== "other") return requested;
  const normalizedName = cleanFilename(filename).replace(/[_-]+/g, " ");
  const hit = DOC_CLASSIFIERS.find((classifier) => classifier.re.test(normalizedName));
  return hit?.type || requested || "other";
}

function documentPath(storedName: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(storedName)) return null;
  const full = path.resolve(DOCUMENT_DIR, storedName);
  if (!full.startsWith(DOCUMENT_DIR + path.sep)) return null;
  return full;
}

export function listLeadDocuments(leadId: string): LeadDocument[] {
  return db
    .prepare(`SELECT * FROM lead_documents WHERE lead_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`)
    .all(leadId) as LeadDocument[];
}

export function getLeadDocument(id: string): LeadDocument | null {
  const row = db.prepare(`SELECT * FROM lead_documents WHERE id = ? AND deleted_at IS NULL`).get(id) as LeadDocument | undefined;
  return row || null;
}

export function getLeadDocumentPath(doc: LeadDocument): string | null {
  const full = documentPath(doc.stored_name);
  return full && fs.existsSync(full) ? full : null;
}

export function saveLeadDocument(opts: {
  lead: Lead;
  buffer: Buffer;
  filename: string;
  docType?: string;
  notes?: string;
  uploadedBy?: string;
}): LeadDocument {
  if (!opts.buffer.length) throw new Error("empty upload");
  if (opts.buffer.length > 25 * 1024 * 1024) throw new Error("document upload is limited to 25 MB");

  const originalName = cleanFilename(opts.filename);
  const ext = path.extname(originalName).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) throw new Error("unsupported document type");

  const now = Date.now();
  const id = randomUUID();
  const storedName = `${id}${ext || ".bin"}`;
  const full = documentPath(storedName);
  if (!full) throw new Error("invalid storage path");
  fs.writeFileSync(full, opts.buffer);

  const docType = classifyDocumentType(originalName, opts.docType);
  const notes = opts.notes?.trim() || null;

  db.prepare(
    `INSERT INTO lead_documents
      (id, lead_id, created_at, uploaded_by, original_name, stored_name, mime, size, doc_type, notes, deleted_at)
     VALUES
      (@id, @lead_id, @created_at, @uploaded_by, @original_name, @stored_name, @mime, @size, @doc_type, @notes, NULL)`,
  ).run({
    id,
    lead_id: opts.lead.id,
    created_at: now,
    uploaded_by: opts.uploadedBy ?? null,
    original_name: originalName,
    stored_name: storedName,
    mime,
    size: opts.buffer.length,
    doc_type: docType,
    notes,
  });

  const markerKey = DOC_CUSTOM_KEYS[docType];
  if (markerKey) {
    updateLead(opts.lead.id, {
      custom: {
        ...(getLead(opts.lead.id)?.custom || opts.lead.custom || {}),
        [markerKey]: new Date(now).toISOString(),
      },
    });
  }

  logActivity(opts.lead.id, {
    type: "document",
    direction: "system",
    channel: "system",
    subject: docTypeLabel(docType),
    body: `Document uploaded: ${originalName}`,
    status: "uploaded",
    meta: {
      documentId: id,
      docType,
      notes,
      uploadedBy: opts.uploadedBy ?? null,
      losMarker: markerKey ?? null,
    },
  });

  return getLeadDocument(id)!;
}

export function softDeleteLeadDocument(doc: LeadDocument, author?: string): void {
  db.prepare(`UPDATE lead_documents SET deleted_at = ? WHERE id = ?`).run(Date.now(), doc.id);
  logActivity(doc.lead_id, {
    type: "document",
    direction: "system",
    channel: "system",
    subject: docTypeLabel(doc.doc_type),
    body: `Document removed: ${doc.original_name}`,
    status: "deleted",
    meta: { documentId: doc.id, author: author ?? null },
  });
}
