import { randomUUID } from "crypto";
import { db } from "../store/db";
import { Lead, logActivity } from "./leads";
import { listLeadDocuments } from "./documents";
import { buildMismo34 } from "./mismo";
import { validateMismoExport } from "./mismoValidation";
import { buildUnderwritingPreview, UnderwritingPreview } from "./underwriting";

export interface AusFinding {
  id: string;
  submission_id: string;
  lead_id: string;
  created_at: number;
  severity: string;
  category: string;
  title: string;
  detail: string | null;
  status: string;
}

export interface AusSubmission {
  id: string;
  lead_id: string;
  created_at: number;
  created_by: string | null;
  provider: string;
  decision: string;
  status: string;
  score: number;
  summary: string | null;
  ratios: Record<string, unknown>;
  findings: AusFinding[];
}

function safeJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function submissionRow(row: Omit<AusSubmission, "ratios" | "findings"> & { ratios: string }): AusSubmission {
  const findings = db
    .prepare(`SELECT * FROM aus_findings WHERE submission_id = ? ORDER BY created_at ASC`)
    .all(row.id) as AusFinding[];
  return { ...row, ratios: safeJson<Record<string, unknown>>(row.ratios, {}), findings };
}

export function runAusPreview(lead: Lead, author?: string | null): { submission: AusSubmission; preview: UnderwritingPreview } {
  const docs = listLeadDocuments(lead.id);
  const xml = buildMismo34(lead);
  const mismo = validateMismoExport(lead, xml, { includeSensitive: true });
  const preview = buildUnderwritingPreview(lead, docs, mismo);
  const now = Date.now();
  const submission = {
    id: randomUUID(),
    lead_id: lead.id,
    created_at: now,
    created_by: author ?? null,
    provider: preview.provider,
    decision: preview.decision,
    status: preview.decision,
    score: preview.score,
    summary: preview.summary,
    ratios: JSON.stringify(preview.ratios),
  };
  db.prepare(
    `INSERT INTO aus_submissions
      (id, lead_id, created_at, created_by, provider, decision, status, score, summary, ratios)
     VALUES
      (@id, @lead_id, @created_at, @created_by, @provider, @decision, @status, @score, @summary, @ratios)`,
  ).run(submission);

  const insertFinding = db.prepare(
    `INSERT INTO aus_findings
      (id, submission_id, lead_id, created_at, severity, category, title, detail, status)
     VALUES
      (@id, @submission_id, @lead_id, @created_at, @severity, @category, @title, @detail, 'open')`,
  );
  for (const condition of preview.conditions) {
    insertFinding.run({
      id: randomUUID(),
      submission_id: submission.id,
      lead_id: lead.id,
      created_at: now,
      severity: condition.severity,
      category: condition.category,
      title: condition.title,
      detail: condition.detail,
    });
  }
  for (const issue of mismo.issues.filter((item) => item.severity === "error").slice(0, 10)) {
    insertFinding.run({
      id: randomUUID(),
      submission_id: submission.id,
      lead_id: lead.id,
      created_at: now,
      severity: "condition",
      category: "mismo",
      title: issue.field,
      detail: issue.message,
    });
  }

  logActivity(lead.id, {
    type: "aus_preview",
    direction: "system",
    channel: "portal",
    body: preview.summary,
    status: preview.decision,
    meta: { provider: preview.provider, score: preview.score, author: author ?? null },
  });

  return { submission: submissionRow(submission), preview };
}

export function latestAusPreview(lead: Lead): { submission: AusSubmission | null; preview: UnderwritingPreview } {
  const docs = listLeadDocuments(lead.id);
  const xml = buildMismo34(lead);
  const mismo = validateMismoExport(lead, xml, { includeSensitive: true });
  const preview = buildUnderwritingPreview(lead, docs, mismo);
  const row = db
    .prepare(`SELECT * FROM aus_submissions WHERE lead_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(lead.id) as (Omit<AusSubmission, "ratios" | "findings"> & { ratios: string }) | undefined;
  return { submission: row ? submissionRow(row) : null, preview };
}

export function listAusSubmissions(leadId: string, limit = 10): AusSubmission[] {
  const rows = db
    .prepare(`SELECT * FROM aus_submissions WHERE lead_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(leadId, Math.min(limit, 50)) as Array<Omit<AusSubmission, "ratios" | "findings"> & { ratios: string }>;
  return rows.map(submissionRow);
}
