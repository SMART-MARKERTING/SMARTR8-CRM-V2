import { createHash, randomUUID } from "crypto";
import { db } from "../store/db";
import { Lead } from "./leads";
import { MismoValidationReport } from "./mismoValidation";

export interface MismoExportAudit {
  id: string;
  lead_id: string;
  created_at: number;
  created_by: string | null;
  filename: string;
  map_version: string | null;
  xml_sha256: string;
  validation_status: string;
  validation_score: number;
  issues: unknown[];
  contains_sensitive: number;
}

export function recordMismoExport(opts: {
  lead: Lead;
  xml: string;
  filename: string;
  report: MismoValidationReport;
  author?: string | null;
  containsSensitive?: boolean;
}): MismoExportAudit {
  const row = {
    id: randomUUID(),
    lead_id: opts.lead.id,
    created_at: Date.now(),
    created_by: opts.author ?? null,
    filename: opts.filename,
    map_version: opts.report.mapVersion ?? null,
    xml_sha256: createHash("sha256").update(opts.xml).digest("hex"),
    validation_status: opts.report.status,
    validation_score: opts.report.score,
    issues: JSON.stringify(opts.report.issues || []),
    contains_sensitive: opts.containsSensitive ? 1 : 0,
  };
  db.prepare(
    `INSERT INTO mismo_exports
      (id, lead_id, created_at, created_by, filename, map_version, xml_sha256, validation_status, validation_score, issues, contains_sensitive)
     VALUES
      (@id, @lead_id, @created_at, @created_by, @filename, @map_version, @xml_sha256, @validation_status, @validation_score, @issues, @contains_sensitive)`,
  ).run(row);
  return {
    ...row,
    issues: opts.report.issues || [],
  };
}

export function listMismoExports(leadId: string, limit = 25): MismoExportAudit[] {
  const rows = db
    .prepare(`SELECT * FROM mismo_exports WHERE lead_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(leadId, Math.min(limit, 100)) as Array<Omit<MismoExportAudit, "issues"> & { issues: string }>;
  return rows.map((row) => ({
    ...row,
    issues: safeJson(row.issues, []),
  }));
}

function safeJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
