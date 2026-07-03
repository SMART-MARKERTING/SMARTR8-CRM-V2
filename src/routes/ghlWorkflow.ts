import { Router, Request, Response } from "express";
import { config } from "../config";
import { log } from "../logger";
import { toE164 } from "../util/phone";
import { sendOutbound } from "../services/router";
import { startClickToCall } from "../services/clickToCall";
import { addToDnc } from "../services/dnc";
import { getContact, upsertContact, logMessage, addTags } from "../services/ghl";

/**
 * Backs GHL Marketplace "Custom Workflow Actions". GHL POSTs here when a workflow
 * runs the action for a contact. These endpoints are what make the app usable as a
 * first-class action inside GHL automations.
 *
 * Auth: a shared secret appended to the action's webhook URL (?key=…), set on the
 * server as GHL_ACTION_SECRET. (GHL lets you configure a static action URL, so the
 * secret rides along in that URL.)
 *
 * NOTE(verify): GHL's exact custom-action payload shape depends on the fields you
 * define in the Marketplace dashboard, so we parse defensively and log the raw body
 * once per call — confirm the real shape on the first live workflow run and tighten.
 */
export const ghlWorkflowRouter = Router();

function checkSecret(req: Request, res: Response): boolean {
  const expected = config.workflow.actionSecret;
  if (!expected) {
    res.status(503).json({ error: "GHL_ACTION_SECRET not set on the server" });
    return false;
  }
  const provided =
    (typeof req.query.key === "string" ? req.query.key : undefined) ||
    req.get("x-action-secret") ||
    (req.body && typeof req.body.key === "string" ? req.body.key : undefined);
  if (provided !== expected) {
    res.status(401).json({ error: "bad action secret" });
    return false;
  }
  return true;
}

/** Read the first present value among dot-path keys out of GHL's (variable) payload. */
function pick(body: unknown, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = k.split(".").reduce<unknown>((o, part) => {
      return o && typeof o === "object" ? (o as Record<string, unknown>)[part] : undefined;
    }, body);
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

const PHONE_KEYS = ["phone", "contact.phone", "contact_phone", "phoneNumber", "to"];
const CONTACT_KEYS = ["contactId", "contact_id", "contact.id", "contactID"];

/** Action: send a text (iMessage-first → SMS fallback) and log it to the contact. */
ghlWorkflowRouter.post("/ghl/workflow/send-message", async (req, res) => {
  if (!checkSecret(req, res)) return;
  const body = req.body ?? {};
  log.info("ghl workflow send-message payload", { body });
  const message = pick(body, ["message", "text", "body", "smsBody", "extras.message"]);
  if (!message) {
    res.status(400).json({ error: "no message field in payload (define a 'message' field on the action)" });
    return;
  }
  try {
    let phone = pick(body, PHONE_KEYS);
    let contactId = pick(body, CONTACT_KEYS);
    if (contactId && !phone) phone = (await getContact(contactId)).phone;
    if (!phone) {
      res.status(400).json({ error: "no phone in payload or on the contact" });
      return;
    }
    const e164 = toE164(phone);
    if (!contactId) contactId = (await upsertContact(e164)).id;

    const result = await sendOutbound({ phone: e164, message });
    try {
      await logMessage({ contactId, message, direction: "outbound" });
    } catch (err) {
      log.warn("workflow send: logMessage failed", { err: String(err) });
    }
    res.json({ ok: result.ok, path: result.path, detail: result.detail, contactId });
  } catch (err) {
    log.error("ghl workflow send-message error", { err: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

/** Action: place a click-to-call (rings your cell, bridges to the contact). DNC-gated. */
ghlWorkflowRouter.post("/ghl/workflow/place-call", async (req, res) => {
  if (!checkSecret(req, res)) return;
  const body = req.body ?? {};
  log.info("ghl workflow place-call payload", { body });
  const phone = pick(body, PHONE_KEYS);
  const contactId = pick(body, CONTACT_KEYS);
  if (!phone && !contactId) {
    res.status(400).json({ error: "no phone or contactId in payload" });
    return;
  }
  try {
    const result = await startClickToCall({ contactId, phone });
    res.json(result);
  } catch (err) {
    log.error("ghl workflow place-call error", { err: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

/** Action: add the contact's number to the Do-Not-Contact list — suppresses BOTH future
 *  calls (existing gate) and texts (new gate in the router). Also tags the contact `dnc`. */
ghlWorkflowRouter.post("/ghl/workflow/add-to-dnc", async (req, res) => {
  if (!checkSecret(req, res)) return;
  const body = req.body ?? {};
  log.info("ghl workflow add-to-dnc payload", { body });
  const reason = pick(body, ["reason", "note", "extras.reason"]) ?? "workflow";
  try {
    let phone = pick(body, PHONE_KEYS);
    let contactId = pick(body, CONTACT_KEYS);
    if (contactId && !phone) phone = (await getContact(contactId)).phone;
    if (!phone) {
      res.status(400).json({ error: "no phone in payload or on the contact" });
      return;
    }
    const e164 = toE164(phone);
    if (!contactId) contactId = (await upsertContact(e164)).id;
    await addToDnc(e164, reason);
    try {
      await addTags(contactId, ["dnc"]);
    } catch (err) {
      log.warn("add-to-dnc: tag failed", { err: String(err) });
    }
    res.json({ ok: true, dnc: e164, reason });
  } catch (err) {
    log.error("ghl workflow add-to-dnc error", { err: String(err) });
    res.status(500).json({ error: String(err) });
  }
});
