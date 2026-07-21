import path from "path";
import { Router, type Request, type Response } from "express";
import { config } from "../config";
import { log } from "../logger";
import { requireFeatureForCurrentPath, requirePass } from "../util/auth";
import { getLead } from "../services/leads";
import { getLeadDocument, saveLeadDocument } from "../services/documents";
import { recordAudit } from "../services/audit";
import { verifyTelnyxWebhookSignature } from "../services/callSummary";
import {
  assignFaxToLead,
  deleteFaxRecord,
  faxConfiguration,
  getFaxFilePath,
  getFaxRecord,
  getFaxRecordByMediaToken,
  handleFaxWebhook,
  listFaxRecords,
  reconcileFaxStatuses,
  sendFax,
  type FaxRecord,
} from "../services/fax";

export const faxRouter = Router();

function publicBase(req: Request): string {
  return (config.publicBaseUrl || config.crm.publicBaseUrl || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
}

function author(req: Request): string | undefined {
  return req.authUser?.name || req.authUser?.username;
}

function canAccessLead(req: Request, leadId: string): boolean {
  const lead = getLead(leadId);
  if (!lead || lead.deleted_at) return false;
  return req.authUser?.role === "admin" || lead.owner_user_id === req.authUser?.id;
}

function canAccessFax(req: Request, record: FaxRecord): boolean {
  if (req.authUser?.role === "admin") return true;
  return Boolean(record.lead_id && canAccessLead(req, record.lead_id));
}

function faxView(record: FaxRecord) {
  return {
    ...record,
    access_token: undefined,
    stored_name: undefined,
    fileAvailable: Boolean(getFaxFilePath(record)),
    downloadUrl: getFaxFilePath(record) ? `/api/fax/${encodeURIComponent(record.id)}/download` : null,
  };
}

function attachmentFromBody(body: unknown): { filename: string; buffer: Buffer } | null {
  if (!body || typeof body !== "object") return null;
  const attachment = (body as Record<string, unknown>).attachment;
  if (!attachment || typeof attachment !== "object") return null;
  const row = attachment as Record<string, unknown>;
  const filename = path.basename(String(row.filename || "fax.pdf")).slice(0, 160) || "fax.pdf";
  const content = String(row.content || "").replace(/^data:application\/pdf;base64,/i, "").trim();
  if (!content) return null;
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(content)) throw new Error("fax attachment is not valid base64 data");
  return { filename, buffer: Buffer.from(content, "base64") };
}

faxRouter.get("/api/webhooks/telnyx/fax", (_req, res) => {
  res.json({
    ok: true,
    route: "/api/webhooks/telnyx/fax",
    method: "POST",
    provider: "telnyx",
    configured: faxConfiguration().configured,
    time: new Date().toISOString(),
  });
});

faxRouter.post("/api/webhooks/telnyx/fax", async (req, res) => {
  if (!verifyTelnyxWebhookSignature(req)) {
    res.status(401).json({ error: "invalid Telnyx webhook signature" });
    return;
  }
  try {
    const result = await handleFaxWebhook(req.body);
    res.json({ ok: true, duplicate: result.duplicate, eventType: result.eventType, faxId: result.record?.id || null });
  } catch (err) {
    log.error("Telnyx fax webhook failed", { err: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Telnyx fetches outbound PDFs from this random, expiring URL. It deliberately
// sits before authentication; the 256-bit token is the credential and is never
// returned by authenticated list APIs.
faxRouter.get("/api/fax/media/:token", (req, res) => {
  const record = getFaxRecordByMediaToken(req.params.token);
  if (!record || record.direction !== "outbound") {
    res.status(404).json({ error: "fax media link is invalid or expired" });
    return;
  }
  const full = getFaxFilePath(record);
  if (!full) {
    res.status(404).json({ error: "fax media file is missing" });
    return;
  }
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Type", "application/pdf");
  res.sendFile(full);
});

// Scope the authenticated permission gate to Fax API routes. This router is
// mounted at the app root so its Telnyx webhook can remain public; a global
// router middleware here would otherwise intercept unrelated routes such as
// /api/auth/login after the public fax routes fall through.
faxRouter.use("/api/fax", requirePass, requireFeatureForCurrentPath);

faxRouter.get("/api/fax/status", (req, res) => {
  const cfg = faxConfiguration();
  res.json({ ...cfg, webhookUrl: `${publicBase(req)}${cfg.webhookPath}` });
});

faxRouter.get("/api/fax", async (req, res) => {
  const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 100;
  const leadId = typeof req.query.leadId === "string" ? req.query.leadId.trim() : undefined;
  if (leadId && !canAccessLead(req, leadId)) {
    res.status(403).json({ error: "this lead is assigned to another user" });
    return;
  }
  const ownerUserId = req.authUser?.role === "admin" ? undefined : req.authUser?.id;
  const records = await reconcileFaxStatuses(listFaxRecords({ limit, leadId, ownerUserId }));
  res.json({ ok: true, records: records.map(faxView), config: faxConfiguration() });
});

faxRouter.post("/api/fax/send", async (req, res) => {
  const to = String(req.body?.to || "").trim();
  const leadId = String(req.body?.leadId || "").trim();
  const documentId = String(req.body?.documentId || "").trim();
  let lead = leadId ? getLead(leadId) : null;
  if (leadId && (!lead || !canAccessLead(req, leadId))) {
    res.status(403).json({ error: "lead not found or assigned to another user" });
    return;
  }
  if (!lead && req.authUser?.role !== "admin") {
    res.status(400).json({ error: "select a lead before sending a fax" });
    return;
  }
  try {
    let attachment = attachmentFromBody(req.body);
    let sendDocumentId = documentId || undefined;
    if (sendDocumentId) {
      const doc = getLeadDocument(sendDocumentId);
      if (!doc || !lead || doc.lead_id !== lead.id) throw new Error("selected PDF does not belong to this lead");
    } else if (attachment && lead) {
      const doc = saveLeadDocument({
        lead,
        buffer: attachment.buffer,
        filename: attachment.filename,
        displayName: attachment.filename,
        folderName: "Fax",
        docType: "fax",
        notes: `Outbound fax attachment to ${to}`,
        uploadedBy: author(req),
      });
      sendDocumentId = doc.id;
      attachment = null;
      lead = getLead(lead.id);
    }
    const record = await sendFax({
      to,
      lead,
      documentId: sendDocumentId,
      buffer: attachment?.buffer,
      filename: attachment?.filename,
      baseUrl: publicBase(req),
      author: author(req),
    });
    recordAudit({
      req,
      action: "fax.send",
      statusCode: 202,
      detail: `Fax queued to ${record.to_number}`,
      meta: { faxId: record.id, providerFaxId: record.provider_fax_id, leadId: record.lead_id },
    });
    res.status(202).json({ ok: true, record: faxView(record) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordAudit({ req, action: "fax.send", statusCode: 400, detail: message, meta: { leadId: lead?.id || null } });
    res.status(400).json({ error: message });
  }
});

faxRouter.get("/api/fax/:id/download", (req, res) => {
  const record = getFaxRecord(req.params.id);
  if (!record || !canAccessFax(req, record)) {
    res.status(404).json({ error: "fax not found" });
    return;
  }
  const full = getFaxFilePath(record);
  if (!full) {
    res.status(404).json({ error: "fax PDF is not available" });
    return;
  }
  const filename = record.original_name || `fax-${record.id}.pdf`;
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${filename.replace(/["\r\n]/g, "_")}"`);
  res.sendFile(full);
});

faxRouter.post("/api/fax/:id/assign", (req, res) => {
  const record = getFaxRecord(req.params.id);
  const leadId = String(req.body?.leadId || "").trim();
  const lead = leadId ? getLead(leadId) : null;
  if (!record || !canAccessFax(req, record)) {
    res.status(404).json({ error: "fax not found" });
    return;
  }
  if (!lead || !canAccessLead(req, lead.id)) {
    res.status(404).json({ error: "lead not found" });
    return;
  }
  try {
    const updated = assignFaxToLead(record, lead, author(req));
    recordAudit({ req, action: "fax.file", statusCode: 200, detail: `Fax filed to lead ${lead.id}`, meta: { faxId: record.id, leadId: lead.id } });
    res.json({ ok: true, record: faxView(updated) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

faxRouter.delete("/api/fax/:id", (req, res) => {
  const record = getFaxRecord(req.params.id);
  if (!record || !canAccessFax(req, record)) {
    res.status(404).json({ error: "fax not found" });
    return;
  }
  deleteFaxRecord(record);
  recordAudit({ req, action: "fax.delete", statusCode: 200, detail: `Fax removed from inbox`, meta: { faxId: record.id, leadId: record.lead_id } });
  res.json({ ok: true, id: record.id });
});
