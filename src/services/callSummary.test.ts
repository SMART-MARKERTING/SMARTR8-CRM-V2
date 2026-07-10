import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.TOKEN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "loangenius-call-summary-"));
process.env.CRM_DB_FILE = "crm.db";
process.env.CALL_SUMMARY_ENABLED = "true";
process.env.CALL_SUMMARY_STORE_TRANSCRIPT = "false";
process.env.CALL_SUMMARY_CREATE_TASKS = "true";
process.env.AI_PROVIDER = "openai";

const fixtureDir = path.resolve(process.cwd(), "src", "services", "fixtures", "callSummary");

function readFixture<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, name), "utf8")) as T;
}

function eventClone(name: string, suffix: string, patch: Record<string, unknown> = {}) {
  const event = readFixture<Record<string, any>>(name);
  event.data.id = `${event.data.id}-${suffix}`;
  event.data.payload.call_control_id = `${event.data.payload.call_control_id}-${suffix}`;
  event.data.payload.call_session_id = `${event.data.payload.call_session_id}-${suffix}`;
  if (event.data.payload.recording_id) event.data.payload.recording_id = `${event.data.payload.recording_id}-${suffix}`;
  if (event.data.payload.transcription_id) event.data.payload.transcription_id = `${event.data.payload.transcription_id}-${suffix}`;
  Object.assign(event.data.payload, patch);
  return event;
}

test("Telnyx webhook accepts valid transcription event", async () => {
  const { acceptTelnyxCallSummaryEvent } = await import("./callSummary");
  const accepted = acceptTelnyxCallSummaryEvent(eventClone("inbound_telnyx_transcription_saved.json", "accept"));
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.duplicate, false);
  assert.ok(accepted.rowId);
});

test("duplicate webhook does not create duplicate CRM note", async () => {
  const { createLead, listNotes } = await import("./leads");
  const { acceptTelnyxCallSummaryEvent, listCallSummaries, processCallSummary, validateMortgageCallSummary } = await import("./callSummary");
  const validSummary = validateMortgageCallSummary(readFixture("ai_summary_valid.json"));
  const lead = createLead({ first_name: "Dupe", last_name: "Borrower", phone: "+16235550101", source: "test" });
  const event = eventClone("inbound_telnyx_transcription_saved.json", "dupe", { from: lead.phone });
  const first = acceptTelnyxCallSummaryEvent(event);
  assert.ok(first.rowId);
  await processCallSummary(first.rowId!, { inlineTranscript: "Borrower asked for HELOC follow-up.", generateSummary: async () => validSummary });
  const second = acceptTelnyxCallSummaryEvent(event);
  assert.equal(second.duplicate, true);
  await processCallSummary(second.rowId!, { inlineTranscript: "Borrower asked for HELOC follow-up.", generateSummary: async () => validSummary });
  assert.equal(listNotes(lead.id).filter((note) => /CALL SUMMARY/.test(note.body)).length, 1);
});

test("phone number normalization works", async () => {
  const { normalPhoneKey } = await import("./callSummary");
  assert.equal(normalPhoneKey("(623) 280-8351"), "6232808351");
  assert.equal(normalPhoneKey("+1 623-280-8351"), "6232808351");
});

test("inbound call matches from_phone to CRM contact", async () => {
  const { createLead } = await import("./leads");
  const { matchLeadForCall } = await import("./callSummary");
  const lead = createLead({ first_name: "Inbound", phone: "+16235550102", source: "test" });
  const match = matchLeadForCall({ direction: "inbound", from_phone: "+16235550102", to_phone: "+14802069290" });
  assert.equal(match.status, "one");
  if (match.status === "one") assert.equal(match.lead.id, lead.id);
});

test("outbound call matches to_phone to CRM contact", async () => {
  const { createLead } = await import("./leads");
  const { matchLeadForCall } = await import("./callSummary");
  const lead = createLead({ first_name: "Outbound", phone: "+19545550103", source: "test" });
  const match = matchLeadForCall({ direction: "outbound", from_phone: "+14802069290", to_phone: "+19545550103" });
  assert.equal(match.status, "one");
  if (match.status === "one") assert.equal(match.lead.id, lead.id);
});

test("unmatched call is marked for review", async () => {
  const { acceptTelnyxCallSummaryEvent, listCallSummaries, processCallSummary, validateMortgageCallSummary } = await import("./callSummary");
  const validSummary = validateMortgageCallSummary(readFixture("ai_summary_valid.json"));
  const event = eventClone("inbound_telnyx_transcription_saved.json", "unmatched", { from: "+17025559999" });
  const accepted = acceptTelnyxCallSummaryEvent(event);
  assert.ok(accepted.rowId);
  await processCallSummary(accepted.rowId!, { inlineTranscript: "Caller asked for options.", generateSummary: async () => validSummary });
  const row = listCallSummaries(50).find((item) => item.id === accepted.rowId);
  assert.equal(row?.status, "unmatched");
});

test("sensitive PII masking works", async () => {
  const { maskSensitiveTranscript } = await import("./callSummary");
  const masked = maskSensitiveTranscript("SSN 123-45-6789 DOB 01/02/1980 card 4111 1111 1111 1111 account number 123456789012");
  assert.doesNotMatch(masked, /123-45-6789|01\/02\/1980|4111|123456789012/);
  assert.match(masked, /sensitive information provided/);
});

test("AI JSON validation rejects invalid output", async () => {
  const { validateMortgageCallSummary } = await import("./callSummary");
  assert.throws(() => validateMortgageCallSummary(readFixture("ai_summary_invalid.json")), /AI summary invalid/);
});

test("CRM note formatting works", async () => {
  const { formatCallSummaryNote, validateMortgageCallSummary } = await import("./callSummary");
  const summary = validateMortgageCallSummary(readFixture("ai_summary_valid.json"));
  const note = formatCallSummaryNote(summary, { direction: "inbound", duration_seconds: 480, recording_id: "rec-test" });
  assert.match(note, /CALL SUMMARY/);
  assert.match(note, /DETAILS/);
  assert.match(note, /Generated from Telnyx call summary/);
});

test("structured follow-up task creation works when follow_up_needed=true", async () => {
  const { createLead, getLead } = await import("./leads");
  const { acceptTelnyxCallSummaryEvent, listCallSummaries, processCallSummary, validateMortgageCallSummary } = await import("./callSummary");
  const validSummary = validateMortgageCallSummary(readFixture("ai_summary_valid.json"));
  const lead = createLead({ first_name: "Task", phone: "+16235550104", source: "test" });
  const event = eventClone("inbound_telnyx_transcription_saved.json", "task", { from: lead.phone });
  const accepted = acceptTelnyxCallSummaryEvent(event);
  assert.ok(accepted.rowId);
  await processCallSummary(accepted.rowId!, { inlineTranscript: "Borrower wants a follow-up tomorrow.", generateSummary: async () => validSummary });
  const updated = getLead(lead.id);
  assert.ok(updated?.todos.some((todo) => todo.text === "Review requested borrower documents" && !todo.deleted_at));
  const row = listCallSummaries(50).find((item) => item.id === accepted.rowId);
  assert.equal(row?.follow_up_recommendation?.outcome, "documents_requested");
  assert.equal(row?.follow_up_recommendation?.consumerContactedAutomatically, false);
});

test("recording-only event without transcript remains pending", async () => {
  const { acceptTelnyxCallSummaryEvent, listCallSummaries, processCallSummary } = await import("./callSummary");
  const accepted = acceptTelnyxCallSummaryEvent(eventClone("telnyx_recording_saved_without_transcript.json", "pending"));
  assert.ok(accepted.rowId);
  await processCallSummary(accepted.rowId!);
  const row = listCallSummaries(50).find((item) => item.id === accepted.rowId);
  assert.equal(row?.status, "pending");
});
