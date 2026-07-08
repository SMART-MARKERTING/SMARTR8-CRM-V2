import { db } from "../store/db";

export interface CrmReport {
  title: string;
  created_at: number;
  range: { from: number; to: number };
  sections: Array<{ title: string; rows: Array<Record<string, string | number>> }>;
  lines: string[];
}

function count(sql: string, params: Record<string, unknown>): number {
  return (db.prepare(sql).get(params) as { n: number }).n || 0;
}

function escPdfText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function dateLabel(ms: number): string {
  return new Date(ms).toLocaleString("en-US", { timeZone: "America/Phoenix" });
}

export function buildCrmReport(opts: { from?: number; to?: number; type?: string } = {}): CrmReport {
  const now = Date.now();
  const to = opts.to || now;
  const from = opts.from || to - 30 * 24 * 60 * 60_000;
  const params = { from, to };
  const statusRows = db
    .prepare(
      `SELECT COALESCE(pipeline_stage, status, 'Lead-In') AS label, COUNT(*) AS n
         FROM leads
        WHERE deleted_at IS NULL AND created_at BETWEEN @from AND @to
        GROUP BY COALESCE(pipeline_stage, status, 'Lead-In')
        ORDER BY n DESC`,
    )
    .all(params) as Array<{ label: string; n: number }>;
  const sourceRows = db
    .prepare(
      `SELECT COALESCE(NULLIF(source,''), 'manual') AS label, COUNT(*) AS n
         FROM leads
        WHERE deleted_at IS NULL AND created_at BETWEEN @from AND @to
        GROUP BY COALESCE(NULLIF(source,''), 'manual')
        ORDER BY n DESC
        LIMIT 12`,
    )
    .all(params) as Array<{ label: string; n: number }>;
  const activityRows = db
    .prepare(
      `SELECT type AS label, COUNT(*) AS n
         FROM activities
        WHERE deleted_at IS NULL AND created_at BETWEEN @from AND @to
        GROUP BY type
        ORDER BY n DESC
        LIMIT 12`,
    )
    .all(params) as Array<{ label: string; n: number }>;
  const lines = [
    `Report range: ${dateLabel(from)} - ${dateLabel(to)}`,
    `Active leads: ${count("SELECT COUNT(*) AS n FROM leads WHERE deleted_at IS NULL AND contact_only = 0", params)}`,
    `Lead pool records: ${count("SELECT COUNT(*) AS n FROM leads WHERE deleted_at IS NULL AND contact_only = 1", params)}`,
    `Past clients: ${count("SELECT COUNT(*) AS n FROM leads WHERE deleted_at IS NULL AND past_client = 1", params)}`,
    `New leads in range: ${count("SELECT COUNT(*) AS n FROM leads WHERE deleted_at IS NULL AND created_at BETWEEN @from AND @to", params)}`,
    `Texts in range: ${count("SELECT COUNT(*) AS n FROM activities WHERE deleted_at IS NULL AND type IN ('sms','imessage') AND direction='outbound' AND created_at BETWEEN @from AND @to", params)}`,
    `Emails in range: ${count("SELECT COUNT(*) AS n FROM activities WHERE deleted_at IS NULL AND type='email' AND created_at BETWEEN @from AND @to", params)}`,
    `Calls in range: ${count("SELECT COUNT(*) AS n FROM call_log WHERE deleted_at IS NULL AND created_at BETWEEN @from AND @to", params)}`,
    "",
    "Pipeline status:",
    ...statusRows.map((r) => `- ${r.label}: ${r.n}`),
    "",
    "Top sources:",
    ...sourceRows.map((r) => `- ${r.label}: ${r.n}`),
    "",
    "Activity summary:",
    ...activityRows.map((r) => `- ${r.label}: ${r.n}`),
  ];
  return {
    title: opts.type === "activity" ? "LoanGenius Activity Report" : "LoanGenius CRM Report",
    created_at: now,
    range: { from, to },
    sections: [
      { title: "Pipeline status", rows: statusRows },
      { title: "Top sources", rows: sourceRows },
      { title: "Activity summary", rows: activityRows },
    ],
    lines,
  };
}

export function reportPdfBuffer(report: CrmReport): Buffer {
  const lines = [report.title, `Generated: ${dateLabel(report.created_at)}`, "", ...report.lines].slice(0, 70);
  const content = [
    "BT",
    "/F1 18 Tf",
    "72 750 Td",
    `(${escPdfText(lines[0] || report.title)}) Tj`,
    "/F1 10 Tf",
    "0 -24 Td",
    ...lines.slice(1).flatMap((line) => [`(${escPdfText(line)}) Tj`, "0 -14 Td"]),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "utf8")} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((obj, idx) => {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${idx + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}
