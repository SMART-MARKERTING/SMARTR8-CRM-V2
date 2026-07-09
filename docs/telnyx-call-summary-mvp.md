# Telnyx Call Summary MVP

This is Option 1 only: post-call AI summaries for Telnyx calls. It does not add an AI voice bot, does not speak to borrowers, and does not change the live call flow.

## What It Does

Telnyx sends a recording/transcription webhook to the CRM after a call. The backend accepts the event idempotently, retrieves or reads the transcript, masks sensitive numbers, matches the call to a CRM lead by phone, asks the configured AI provider for strict JSON, saves a structured note on the lead, and optionally creates a follow-up task.

## Required Env Vars

```env
TELNYX_API_KEY=...
TELNYX_PUBLIC_KEY=...                 # optional but recommended for webhook signature verification
AI_PROVIDER=openai                    # openai or openrouter
AI_API_KEY=...
AI_MODEL=gpt-4o-mini
CALL_SUMMARY_ENABLED=true
CALL_SUMMARY_STORE_TRANSCRIPT=false
CALL_SUMMARY_CREATE_TASKS=true
```

Keep `CALL_SUMMARY_STORE_TRANSCRIPT=false` unless transcript storage has been approved. When enabled, the app stores the sanitized transcript, not raw sensitive values.

## Telnyx Webhook URL

Use the existing voice webhook:

```text
https://loangenius-v2.onrender.com/webhooks/telnyx-voice
https://loangenius-v2.onrender.com/v2/webhooks/telnyx-voice
https://crm.smartr8.com/v2/webhooks/telnyx-voice
```

Subscribe the Telnyx Voice Application to recording/transcription completed events such as `call.recording.saved`, `call.transcription.saved`, or `call.recording.transcription.saved`. Event names are handled flexibly by pattern so Telnyx naming changes are easy to adjust in `src/services/callSummary.ts`.

Operational note: call recording/transcription consent must be handled in Telnyx account settings, call flows, state-law policy, and borrower disclosures before enabling recording.

## CRM Matching

The matcher normalizes phone numbers to the last 10 digits and checks:

- inbound calls: borrower is usually `from_phone`
- outbound calls: borrower is usually `to_phone`
- lead `phone`
- lead `whatsapp_phone`
- phone-like fields inside lead `custom`

If exactly one lead matches, the note is saved there. If none match, the row is marked `unmatched`. If multiple match, the row is marked `needs_review`; the system does not guess.

## Retry Failed Summaries

List recent rows:

```http
GET /api/call-summaries?limit=100
```

Retry one row:

```http
POST /api/call-summaries/{id}/retry
```

Both endpoints require the normal CRM session token/pass gate.

## Known Limitations

- There is no background queue yet; processing starts after the webhook is accepted in the current Node process.
- If Telnyx sends a recording event before the transcript is ready, the row stays `pending` until a transcription event arrives or you retry after transcript availability.
- Transcript fetch endpoints are best-effort because Telnyx payload shape can vary by product; direct transcript text or transcript URLs are preferred.
- AI summaries are factual note drafts only. They do not make approval, credit, pricing, legal, or underwriting decisions.
