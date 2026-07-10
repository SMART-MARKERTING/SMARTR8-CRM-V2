import { createPublicKey, randomUUID, verify as verifySignature } from "crypto";
import type { Request } from "express";
import { config } from "../config";
import { log } from "../logger";
import { db } from "../store/db";
import { toE164 } from "../util/phone";
import { addNote, addTodo, Lead, listLeads, logActivity } from "./leads";
import { buildCallFollowUpRecommendation, CallFollowUpRecommendation } from "./callFollowUp";

type CallSummaryStatus = "pending" | "processed" | "unmatched" | "needs_review" | "failed" | "ignored";

export interface MortgageCallSummary {
  lead_temperature: "Hot" | "Warm" | "Cold" | "Unknown";
  call_direction: "Inbound" | "Outbound" | "Unknown";
  short_summary: string;
  detailed_summary: string;
  borrower_goal: string | null;
  loan_type:
    | "HELOC"
    | "Cash-Out Refinance"
    | "Rate/Term Refinance"
    | "Purchase"
    | "DSCR"
    | "Fix and Flip"
    | "Construction"
    | "Debt Consolidation"
    | "Other"
    | "Unknown";
  property_address: string | null;
  property_state: string | null;
  property_type: "Single Family" | "Condo" | "Townhome" | "Multi-Family" | "Commercial" | "Mixed Use" | "Unknown" | null;
  occupancy: "Primary Residence" | "Second Home" | "Investment Property" | "Unknown" | null;
  estimated_value: string | null;
  current_mortgage_balance: string | null;
  desired_loan_amount: string | null;
  desired_cash_out: string | null;
  credit_score_mentioned: string | null;
  income_type: "W2" | "Self-Employed" | "1099" | "Retired" | "Business Owner" | "Investor" | "Unknown" | null;
  documents_requested: string[];
  borrower_questions: string[];
  objections_or_concerns: string[];
  important_dates: string[];
  next_steps: string[];
  follow_up_needed: boolean;
  follow_up_date: string | null;
  compliance_flags: string[];
  missing_information: string[];
  crm_note: string;
}

interface TelnyxSummaryEvent {
  telnyxEventId: string | null;
  eventType: string;
  callControlId: string | null;
  callSessionId: string | null;
  recordingId: string | null;
  transcriptionId: string | null;
  direction: string | null;
  fromPhone: string | null;
  toPhone: string | null;
  callStartedAt: number | null;
  callEndedAt: number | null;
  durationSeconds: number | null;
  recordingUrl: string | null;
  transcriptUrl: string | null;
  inlineTranscript: string | null;
}

export interface CallSummaryRow {
  id: string;
  telnyx_event_id: string | null;
  call_control_id: string | null;
  call_session_id: string | null;
  recording_id: string | null;
  transcription_id: string | null;
  crm_contact_id: string | null;
  lead_id: string | null;
  direction: string | null;
  from_phone: string | null;
  to_phone: string | null;
  call_started_at: number | null;
  call_ended_at: number | null;
  duration_seconds: number | null;
  recording_url: string | null;
  transcript_url: string | null;
  transcript_text: string | null;
  summary_json: string | null;
  follow_up_json: string | null;
  crm_note_id: string | null;
  task_id: string | null;
  status: CallSummaryStatus;
  error_message: string | null;
  created_at: number;
  updated_at: number;
}

export interface AcceptedCallSummary {
  accepted: boolean;
  duplicate: boolean;
  ignored?: boolean;
  rowId?: string;
  inlineTranscript?: string | null;
  reason?: string;
}

export interface ProcessCallSummaryOptions {
  inlineTranscript?: string | null;
  generateSummary?: (transcript: string, metadata: Record<string, unknown>) => Promise<MortgageCallSummary>;
}

const SUMMARY_EVENT_PATTERN = /(?:call\.)?(?:recording|transcription).*?(?:saved|completed|ready|available)/i;
const SYSTEM_PROMPT =
  "You are an AI assistant summarizing mortgage loan officer phone calls. Summarize the call strictly from the transcript. Do not invent details. Extract mortgage-relevant details including loan purpose, property information, occupancy, value, loan balance, cash-out amount, credit, income type, objections, documents requested, next steps, and follow-up timing. Flag compliance or risk concerns if mentioned. Do not provide legal, financial, or underwriting advice. Return only valid JSON matching the required schema.";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function cleanText(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function nullableText(value: unknown): string | null {
  const s = cleanText(value);
  return s || null;
}

function safeError(err: unknown): string {
  return maskSensitiveTranscript(err instanceof Error ? err.message : String(err)).slice(0, 800);
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function dateMillis(value: unknown): number | null {
  const n = numberOrNull(value);
  if (n && n > 10_000_000_000) return n;
  if (n && n > 0) return n * 1000;
  const parsed = Date.parse(cleanText(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function phoneFromValue(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "object") {
    const r = asRecord(value);
    return phoneFromValue(r.phone_number || r.number || r.e164 || r.phone);
  }
  const raw = cleanText(value);
  if (!raw) return null;
  const normalized = toE164(raw);
  return normalized || raw;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (Array.isArray(value)) {
      const nested = firstString(...value);
      if (nested) return nested;
      continue;
    }
    if (value && typeof value === "object") {
      const r = asRecord(value);
      const nested = firstString(r.url, r.download_url, r.downloadUrl, r.href, r.mp3, r.wav, r.text, r.transcript);
      if (nested) return nested;
      continue;
    }
    const s = nullableText(value);
    if (s) return s;
  }
  return null;
}

function deepFindString(value: unknown, names: string[]): string | null {
  if (!value || typeof value !== "object") return null;
  const r = asRecord(value);
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(r, name)) {
      const s = firstString(r[name]);
      if (s) return s;
    }
  }
  for (const child of Object.values(r)) {
    if (child && typeof child === "object") {
      const s = deepFindString(child, names);
      if (s) return s;
    }
  }
  return null;
}

export function isTelnyxCallSummaryEvent(body: unknown): boolean {
  const data = asRecord(asRecord(body).data || body);
  const eventType = cleanText(data.event_type || data.eventType || asRecord(body).event_type);
  return SUMMARY_EVENT_PATTERN.test(eventType);
}

export function extractTelnyxCallSummaryEvent(body: unknown): TelnyxSummaryEvent | null {
  const root = asRecord(body);
  const data = asRecord(root.data || root);
  const payload = asRecord(data.payload || data);
  const eventType = cleanText(data.event_type || data.eventType || root.event_type);
  if (!SUMMARY_EVENT_PATTERN.test(eventType)) return null;

  const recording = asRecord(payload.recording);
  const transcription = asRecord(payload.transcription);
  const call = asRecord(payload.call);
  const connection = asRecord(payload.connection);
  const transcriptUrl = firstString(
    payload.transcript_url,
    payload.transcription_url,
    payload.transcription_download_url,
    transcription.url,
    transcription.download_url,
    transcription.downloadUrl,
    payload.transcript_urls,
  );
  return {
    telnyxEventId: nullableText(data.id || root.id),
    eventType,
    callControlId: nullableText(payload.call_control_id || call.call_control_id),
    callSessionId: nullableText(payload.call_session_id || call.call_session_id),
    recordingId: nullableText(payload.recording_id || recording.id || (eventType.includes("recording") ? payload.id : null)),
    transcriptionId: nullableText(payload.transcription_id || transcription.id || (eventType.includes("transcription") ? payload.id : null)),
    direction: nullableText(payload.direction || payload.call_direction || call.direction),
    fromPhone: phoneFromValue(payload.from || payload.from_phone_number || payload.from_number || call.from || connection.from),
    toPhone: phoneFromValue(payload.to || payload.to_phone_number || payload.to_number || call.to || connection.to),
    callStartedAt: dateMillis(payload.started_at || payload.start_time || call.started_at),
    callEndedAt: dateMillis(payload.ended_at || payload.end_time || payload.finished_at || data.occurred_at),
    durationSeconds: numberOrNull(payload.duration_seconds || payload.duration_secs || payload.duration || recording.duration_secs),
    recordingUrl: firstString(payload.recording_url, payload.recording_urls, recording.url, recording.download_url, recording.downloadUrl, payload.download_url),
    transcriptUrl,
    inlineTranscript: deepFindString(payload, ["transcript_text", "transcription_text", "transcript", "text", "utterance"]),
  };
}

function findExistingSummary(event: TelnyxSummaryEvent): CallSummaryRow | null {
  const lookups: Array<[string, string | null]> = [
    ["telnyx_event_id", event.telnyxEventId],
    ["transcription_id", event.transcriptionId],
    ["recording_id", event.recordingId],
  ];
  for (const [column, value] of lookups) {
    if (!value) continue;
    const row = db.prepare(`SELECT * FROM call_summaries WHERE ${column} = ? ORDER BY created_at DESC LIMIT 1`).get(value) as CallSummaryRow | undefined;
    if (row) return row;
  }
  if (event.callSessionId || event.callControlId) {
    const row = db
      .prepare(
        `SELECT * FROM call_summaries
          WHERE (@session IS NOT NULL AND call_session_id = @session)
             OR (@control IS NOT NULL AND call_control_id = @control)
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get({ session: event.callSessionId, control: event.callControlId }) as CallSummaryRow | undefined;
    if (row && (row.status === "pending" || row.status === "failed" || row.status === "unmatched" || row.status === "needs_review")) return row;
  }
  return null;
}

export function acceptTelnyxCallSummaryEvent(body: unknown): AcceptedCallSummary {
  if (!config.callSummary.enabled) return { accepted: false, duplicate: false, ignored: true, reason: "disabled" };
  const event = extractTelnyxCallSummaryEvent(body);
  if (!event) return { accepted: false, duplicate: false, ignored: true, reason: "not-call-summary-event" };

  const now = Date.now();
  const existing = findExistingSummary(event);
  if (existing) {
    db.prepare(
      `UPDATE call_summaries
          SET telnyx_event_id = COALESCE(telnyx_event_id, @telnyxEventId),
              recording_id = COALESCE(recording_id, @recordingId),
              transcription_id = COALESCE(transcription_id, @transcriptionId),
              transcript_url = COALESCE(transcript_url, @transcriptUrl),
              recording_url = COALESCE(recording_url, @recordingUrl),
              updated_at = @now
        WHERE id = @id`,
    ).run({ ...eventToDbParams(event), now, id: existing.id });
    return { accepted: true, duplicate: true, rowId: existing.id, inlineTranscript: event.inlineTranscript };
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO call_summaries (
       id, telnyx_event_id, call_control_id, call_session_id, recording_id, transcription_id,
       direction, from_phone, to_phone, call_started_at, call_ended_at, duration_seconds,
       recording_url, transcript_url, transcript_text, status, created_at, updated_at
     ) VALUES (
       @id, @telnyxEventId, @callControlId, @callSessionId, @recordingId, @transcriptionId,
       @direction, @fromPhone, @toPhone, @callStartedAt, @callEndedAt, @durationSeconds,
       @recordingUrl, @transcriptUrl, @transcriptText, 'pending', @now, @now
     )`,
  ).run({
    id,
    ...eventToDbParams(event),
    transcriptText: config.callSummary.storeTranscript && event.inlineTranscript ? maskSensitiveTranscript(event.inlineTranscript) : null,
    now,
  });
  return { accepted: true, duplicate: false, rowId: id, inlineTranscript: event.inlineTranscript };
}

function eventToDbParams(event: TelnyxSummaryEvent): Record<string, unknown> {
  return {
    telnyxEventId: event.telnyxEventId,
    callControlId: event.callControlId,
    callSessionId: event.callSessionId,
    recordingId: event.recordingId,
    transcriptionId: event.transcriptionId,
    direction: event.direction,
    fromPhone: event.fromPhone,
    toPhone: event.toPhone,
    callStartedAt: event.callStartedAt,
    callEndedAt: event.callEndedAt,
    durationSeconds: event.durationSeconds,
    recordingUrl: event.recordingUrl,
    transcriptUrl: event.transcriptUrl,
  };
}

function loadSummaryRow(id: string): CallSummaryRow | null {
  return (db.prepare(`SELECT * FROM call_summaries WHERE id = ?`).get(id) as CallSummaryRow | undefined) || null;
}

function setSummaryStatus(id: string, status: CallSummaryStatus, errorMessage?: string | null): void {
  db.prepare(`UPDATE call_summaries SET status = ?, error_message = ?, updated_at = ? WHERE id = ?`).run(status, errorMessage || null, Date.now(), id);
}

function updateProcessed(
  row: CallSummaryRow,
  summary: MortgageCallSummary,
  followUp: CallFollowUpRecommendation,
  noteId: string,
  taskId: string | null,
  leadId: string,
  transcriptText: string,
): void {
  db.prepare(
    `UPDATE call_summaries
        SET lead_id = @leadId,
            crm_contact_id = @leadId,
            summary_json = @summaryJson,
            follow_up_json = @followUpJson,
            crm_note_id = @noteId,
            task_id = @taskId,
            transcript_text = @transcriptText,
            status = 'processed',
            error_message = NULL,
            updated_at = @now
      WHERE id = @id`,
  ).run({
    id: row.id,
    leadId,
    summaryJson: JSON.stringify(summary),
    followUpJson: JSON.stringify(followUp),
    noteId,
    taskId,
    transcriptText: config.callSummary.storeTranscript ? transcriptText : null,
    now: Date.now(),
  });
}

function updateMatchedReview(rowId: string, status: "unmatched" | "needs_review", error: string, leadIds: string[] = []): void {
  db.prepare(`UPDATE call_summaries SET status = ?, lead_id = NULL, crm_contact_id = NULL, error_message = ?, summary_json = ?, updated_at = ? WHERE id = ?`).run(
    status,
    error,
    JSON.stringify({ lead_ids: leadIds }),
    Date.now(),
    rowId,
  );
}

export async function processCallSummary(rowId: string, opts: ProcessCallSummaryOptions = {}): Promise<CallSummaryRow | null> {
  const row = loadSummaryRow(rowId);
  if (!row) return null;
  if (!config.callSummary.enabled) {
    setSummaryStatus(row.id, "ignored", "CALL_SUMMARY_ENABLED=false");
    return loadSummaryRow(row.id);
  }
  if (row.status === "processed" && row.crm_note_id) return row;

  // Recording/transcription consent is an operational/legal control handled in Telnyx
  // settings, call flows, disclosures, and state-specific policy before this runs.
  try {
    const transcriptRaw = opts.inlineTranscript || row.transcript_text || (await fetchTranscriptForRow(row));
    if (!transcriptRaw) {
      setSummaryStatus(row.id, "pending", "transcript not ready");
      return loadSummaryRow(row.id);
    }
    const transcript = maskSensitiveTranscript(transcriptRaw);
    const match = matchLeadForCall(row);
    if (match.status === "none") {
      updateMatchedReview(row.id, "unmatched", "No CRM lead/contact matched the call phone number.");
      return loadSummaryRow(row.id);
    }
    if (match.status === "multiple") {
      updateMatchedReview(row.id, "needs_review", "Multiple CRM leads matched the call phone number; review before attaching a note.", match.leads.map((lead) => lead.id));
      return loadSummaryRow(row.id);
    }

    const metadata = summaryMetadata(row, match.lead);
    const summary = opts.generateSummary ? await opts.generateSummary(transcript, metadata) : await generateMortgageCallSummary(transcript, metadata);
    const validated = validateMortgageCallSummary(summary);
    const followUp = buildCallFollowUpRecommendation(validated, match.lead, row);
    const noteBody = formatCallSummaryNote(validated, row);
    const note = addNote(match.lead.id, noteBody, "Telnyx AI Call Summary");
    let taskId: string | null = null;
    if (config.callSummary.createTasks && followUp.taskTitle) {
      const todos = addTodo(match.lead.id, {
        text: followUp.taskTitle,
        due_date: followUp.dueAt,
        description: `${followUp.nextAction}\n\nReasons:\n${followUp.reasons.map((reason) => `- ${reason}`).join("\n")}`,
      });
      taskId = todos?.[todos.length - 1]?.id || null;
    }
    logActivity(match.lead.id, {
      type: "call_follow_up_recommendation",
      direction: "system",
      channel: "voice",
      subject: followUp.taskTitle || "Post-call review",
      body: followUp.nextAction,
      status: "review-required",
      meta: {
        callSummaryId: row.id,
        outcome: followUp.outcome,
        priority: followUp.priority,
        permittedChannels: followUp.permittedChannels,
        taskId,
        consumerContactedAutomatically: false,
      },
    });
    updateProcessed(row, validated, followUp, note.id, taskId, match.lead.id, transcript);
  } catch (err) {
    log.error("call summary processing failed", { rowId, err: safeError(err) });
    setSummaryStatus(row.id, "failed", safeError(err));
  }
  return loadSummaryRow(row.id);
}

function summaryMetadata(row: CallSummaryRow, lead: Lead): Record<string, unknown> {
  return {
    direction: row.direction || "unknown",
    from_phone: row.from_phone,
    to_phone: row.to_phone,
    duration_seconds: row.duration_seconds,
    lead_id: lead.id,
    lead_name: [lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.email || lead.phone,
  };
}

async function fetchTranscriptForRow(row: CallSummaryRow): Promise<string | null> {
  if (row.transcript_url) return fetchTranscriptUrl(row.transcript_url);
  if (row.transcription_id) {
    const fromId = await fetchTelnyxTranscriptById(row.transcription_id);
    if (fromId) return fromId;
  }
  if (row.recording_id) return fetchTelnyxTranscriptByRecording(row.recording_id);
  return null;
}

async function fetchTranscriptUrl(url: string): Promise<string | null> {
  const headers: Record<string, string> = { Accept: "application/json, text/plain;q=0.9" };
  if (config.telnyx.apiKey && /telnyx/i.test(url)) headers.Authorization = `Bearer ${config.telnyx.apiKey}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`transcript fetch failed ${res.status}`);
  const text = await res.text();
  try {
    return extractTranscriptText(JSON.parse(text));
  } catch {
    return text.trim() || null;
  }
}

async function fetchTelnyxJson(path: string): Promise<unknown | null> {
  if (!config.telnyx.apiKey) return null;
  const res = await fetch(`${config.telnyx.apiBase}${path}`, {
    headers: { Authorization: `Bearer ${config.telnyx.apiKey}`, Accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Telnyx transcript lookup failed ${res.status}`);
  return res.json();
}

async function fetchTelnyxTranscriptById(id: string): Promise<string | null> {
  for (const path of [`/v2/ai/transcriptions/${encodeURIComponent(id)}`, `/v2/call_transcriptions/${encodeURIComponent(id)}`]) {
    const json = await fetchTelnyxJson(path);
    const text = extractTranscriptText(json);
    if (text) return text;
  }
  return null;
}

async function fetchTelnyxTranscriptByRecording(recordingId: string): Promise<string | null> {
  const json = await fetchTelnyxJson(`/v2/recordings/${encodeURIComponent(recordingId)}/transcriptions`);
  return extractTranscriptText(json);
}

function extractTranscriptText(value: unknown): string | null {
  return deepFindString(value, ["transcript_text", "transcription_text", "transcript", "text"]);
}

export function normalPhoneKey(raw: string | null | undefined): string | null {
  const e164 = raw ? toE164(raw) : "";
  const digits = (e164 || raw || "").replace(/\D/g, "");
  if (digits.length >= 10) return digits.slice(-10);
  return digits || null;
}

function collectPhoneValues(value: unknown, out: string[] = [], keyHint = ""): string[] {
  if (value === null || value === undefined) return out;
  if (typeof value === "string" || typeof value === "number") {
    const s = String(value);
    if (/phone|mobile|cell|tel|borrower/i.test(keyHint) || /^\+?\d[\d\s().-]{6,}$/.test(s)) out.push(s);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectPhoneValues(item, out, keyHint));
    return out;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(asRecord(value))) collectPhoneValues(child, out, key);
  }
  return out;
}

function leadPhoneKeys(lead: Lead): Set<string> {
  const phones = [lead.phone, lead.whatsapp_phone, ...collectPhoneValues(lead.custom)];
  return new Set(phones.map((phone) => normalPhoneKey(phone)).filter((key): key is string => Boolean(key)));
}

export function matchLeadForCall(row: Pick<CallSummaryRow, "direction" | "from_phone" | "to_phone">):
  | { status: "one"; lead: Lead }
  | { status: "none"; searched: string[] }
  | { status: "multiple"; leads: Lead[] } {
  const direction = String(row.direction || "").toLowerCase();
  const preferred = direction === "inbound" ? row.from_phone : direction === "outbound" ? row.to_phone : row.from_phone || row.to_phone;
  const fallback = preferred === row.from_phone ? row.to_phone : row.from_phone;
  const keys = [normalPhoneKey(preferred), normalPhoneKey(fallback)].filter((key): key is string => Boolean(key));
  const leads = listLeads({ limit: 20000, includePastClients: true, includeContactOnly: true });
  for (const key of keys) {
    const matched = leads.filter((lead) => leadPhoneKeys(lead).has(key));
    if (matched.length === 1) return { status: "one", lead: matched[0] };
    if (matched.length > 1) return { status: "multiple", leads: matched };
  }
  return { status: "none", searched: keys };
}

export function maskSensitiveTranscript(input: string): string {
  return String(input || "")
    .replace(/\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/g, "[sensitive information provided]")
    .replace(/\b(?:DOB|date of birth|born)\s*[:\-]?\s*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/gi, "DOB [sensitive information provided]")
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[sensitive information provided]")
    .replace(/\b(?:routing|account|acct|bank account)\s*(?:number|#)?\s*[:\-]?\s*\d{4,17}\b/gi, "[sensitive information provided]")
    .replace(/\b\d{9,}\b/g, "[sensitive information provided]");
}

export async function generateMortgageCallSummary(transcript: string, metadata: Record<string, unknown>): Promise<MortgageCallSummary> {
  if (!config.callSummary.aiApiKey) throw new Error("AI_API_KEY is not set");
  const provider = config.callSummary.aiProvider || "openai";
  const endpoint = provider === "openrouter" ? "https://openrouter.ai/api/v1/chat/completions" : "https://api.openai.com/v1/chat/completions";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.callSummary.aiApiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = config.publicBaseUrl || config.crm.publicBaseUrl || "https://loangenius-v2.onrender.com";
    headers["X-Title"] = "LoanGenius Call Summary MVP";
  }
  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.callSummary.aiModel,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            metadata,
            transcript,
            schema: "Return the exact JSON schema requested for MortgageCallSummary. Use null, Unknown, or [] when not discussed.",
          }),
        },
      ],
    }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`AI summary failed ${res.status}: ${raw.slice(0, 500)}`);
  const body = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> };
  return validateMortgageCallSummary(parseJsonObject(body.choices?.[0]?.message?.content || ""));
}

function parseJsonObject(raw: string): unknown {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  return JSON.parse(cleaned);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`AI summary invalid: ${field} must be a string`);
  return maskSensitiveTranscript(value.trim());
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new Error(`AI summary invalid: ${field} must be string|null`);
  return maskSensitiveTranscript(value.trim());
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], field: string, nullable = false): T | null {
  if (nullable && (value === null || value === undefined || value === "")) return null;
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`AI summary invalid: ${field} enum`);
  return value as T;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`AI summary invalid: ${field} must be an array`);
  return value.map((item) => maskSensitiveTranscript(String(item || "").trim())).filter(Boolean);
}

export function validateMortgageCallSummary(value: unknown): MortgageCallSummary {
  const r = asRecord(value);
  return {
    lead_temperature: enumValue(r.lead_temperature, ["Hot", "Warm", "Cold", "Unknown"] as const, "lead_temperature") || "Unknown",
    call_direction: enumValue(r.call_direction, ["Inbound", "Outbound", "Unknown"] as const, "call_direction") || "Unknown",
    short_summary: requiredString(r.short_summary, "short_summary"),
    detailed_summary: requiredString(r.detailed_summary, "detailed_summary"),
    borrower_goal: nullableString(r.borrower_goal, "borrower_goal"),
    loan_type:
      enumValue(
        r.loan_type,
        ["HELOC", "Cash-Out Refinance", "Rate/Term Refinance", "Purchase", "DSCR", "Fix and Flip", "Construction", "Debt Consolidation", "Other", "Unknown"] as const,
        "loan_type",
      ) || "Unknown",
    property_address: nullableString(r.property_address, "property_address"),
    property_state: nullableString(r.property_state, "property_state"),
    property_type: enumValue(r.property_type, ["Single Family", "Condo", "Townhome", "Multi-Family", "Commercial", "Mixed Use", "Unknown"] as const, "property_type", true),
    occupancy: enumValue(r.occupancy, ["Primary Residence", "Second Home", "Investment Property", "Unknown"] as const, "occupancy", true),
    estimated_value: nullableString(r.estimated_value, "estimated_value"),
    current_mortgage_balance: nullableString(r.current_mortgage_balance, "current_mortgage_balance"),
    desired_loan_amount: nullableString(r.desired_loan_amount, "desired_loan_amount"),
    desired_cash_out: nullableString(r.desired_cash_out, "desired_cash_out"),
    credit_score_mentioned: nullableString(r.credit_score_mentioned, "credit_score_mentioned"),
    income_type: enumValue(r.income_type, ["W2", "Self-Employed", "1099", "Retired", "Business Owner", "Investor", "Unknown"] as const, "income_type", true),
    documents_requested: stringArray(r.documents_requested, "documents_requested"),
    borrower_questions: stringArray(r.borrower_questions, "borrower_questions"),
    objections_or_concerns: stringArray(r.objections_or_concerns, "objections_or_concerns"),
    important_dates: stringArray(r.important_dates, "important_dates"),
    next_steps: stringArray(r.next_steps, "next_steps"),
    follow_up_needed: Boolean(r.follow_up_needed),
    follow_up_date: nullableString(r.follow_up_date, "follow_up_date"),
    compliance_flags: stringArray(r.compliance_flags, "compliance_flags"),
    missing_information: stringArray(r.missing_information, "missing_information"),
    crm_note: requiredString(r.crm_note, "crm_note"),
  };
}

function bullets(values: string[]): string {
  return values.length ? values.map((v) => `- ${v}`).join("\n") : "- None mentioned";
}

function display(value: string | null | undefined): string {
  return value && value.trim() ? value.trim() : "Not discussed";
}

export function formatCallSummaryNote(summary: MortgageCallSummary, row: Pick<CallSummaryRow, "direction" | "duration_seconds" | "recording_id">): string {
  return [
    "CALL SUMMARY",
    summary.short_summary,
    "",
    "DETAILS",
    `Borrower goal: ${display(summary.borrower_goal)}`,
    `Loan type: ${summary.loan_type}`,
    `Property: ${display([summary.property_address, summary.property_state, summary.property_type].filter(Boolean).join(" / ") || null)}`,
    `Occupancy: ${display(summary.occupancy)}`,
    `Estimated value: ${display(summary.estimated_value)}`,
    `Mortgage balance: ${display(summary.current_mortgage_balance)}`,
    `Desired loan/cash out: ${display([summary.desired_loan_amount, summary.desired_cash_out].filter(Boolean).join(" / ") || null)}`,
    `Credit mentioned: ${display(summary.credit_score_mentioned)}`,
    `Income type: ${display(summary.income_type)}`,
    "",
    "QUESTIONS / CONCERNS",
    bullets([...summary.borrower_questions, ...summary.objections_or_concerns]),
    "",
    "DOCUMENTS REQUESTED",
    bullets(summary.documents_requested),
    "",
    "NEXT STEPS",
    bullets(summary.next_steps),
    "",
    "FOLLOW-UP",
    `Follow-up needed: ${summary.follow_up_needed ? "yes" : "no"}`,
    `Follow-up date: ${display(summary.follow_up_date)}`,
    "",
    "COMPLIANCE / RISK FLAGS",
    bullets(summary.compliance_flags),
    "",
    "SYSTEM",
    "Generated from Telnyx call summary.",
    `Call direction: ${display(row.direction)}`,
    `Call duration: ${row.duration_seconds ?? "unknown"}`,
    `Recording ID: ${display(row.recording_id)}`,
  ].join("\n");
}

export function parseFollowUpDate(value: string | null): number {
  if (value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    if (/tomorrow/i.test(value)) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9, 0, 0, 0);
      return tomorrow.getTime();
    }
  }
  const d = new Date();
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

function headerValue(req: Request, name: string): string {
  const value = req.get(name);
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function telnyxPublicKeyObject() {
  const raw = config.telnyx.publicKey.trim();
  if (!raw) return null;
  if (/BEGIN PUBLIC KEY/.test(raw)) return createPublicKey(raw);
  const compact = raw.replace(/\s+/g, "");
  const bytes = /^[0-9a-f]{64}$/i.test(compact) ? Buffer.from(compact, "hex") : Buffer.from(compact, "base64");
  if (bytes.length !== 32) return createPublicKey(bytes);
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  return createPublicKey({ key: Buffer.concat([spkiPrefix, bytes]), format: "der", type: "spki" });
}

export function verifyTelnyxWebhookSignature(req: Request): boolean {
  // Never accept an unsigned provider webhook. A missing key is a configuration
  // error, not permission to bypass verification.
  if (!config.telnyx.publicKey) {
    log.warn("Telnyx webhook rejected: TELNYX_PUBLIC_KEY is not configured");
    return false;
  }
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  const timestamp = headerValue(req, "telnyx-timestamp");
  const signature = headerValue(req, "telnyx-signature-ed25519");
  if (!rawBody || !timestamp || !signature) return false;
  try {
    const key = telnyxPublicKeyObject();
    if (!key) return false;
    const signedPayload = Buffer.concat([Buffer.from(`${timestamp}|`, "utf8"), rawBody]);
    return verifySignature(null, signedPayload, key, Buffer.from(signature, "base64"));
  } catch (err) {
    log.warn("Telnyx webhook signature verification failed", { err: safeError(err) });
    return false;
  }
}

export type CallSummaryView = CallSummaryRow & { follow_up_recommendation: CallFollowUpRecommendation | null };

export function listCallSummaries(limit = 100, leadId?: string): CallSummaryView[] {
  const safeLimit = Math.min(Math.max(limit, 1), 500);
  const rows = (leadId
    ? db.prepare(`SELECT * FROM call_summaries WHERE lead_id = ? ORDER BY updated_at DESC LIMIT ?`).all(leadId, safeLimit)
    : db.prepare(`SELECT * FROM call_summaries ORDER BY updated_at DESC LIMIT ?`).all(safeLimit)) as CallSummaryRow[];
  return rows.map((row) => {
    let followUp: CallFollowUpRecommendation | null = null;
    try {
      followUp = row.follow_up_json ? JSON.parse(row.follow_up_json) as CallFollowUpRecommendation : null;
    } catch {
      followUp = null;
    }
    return { ...row, follow_up_recommendation: followUp };
  });
}
