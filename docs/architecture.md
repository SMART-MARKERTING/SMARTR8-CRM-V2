# Architecture & API Reference

Hard-won reference for the Smartr8 hybrid texting system. Everything here was
verified working during the build. Endpoints/versions are exact — don't "improve"
them without re-verifying against live docs.

## Flow overview

```
INBOUND SMS:   Telnyx ──webhook──▶ n8n (telnyx-inbound)
                                     ├─ Filter: data.event_type == "message.received"  (drop the rest)
                                     ├─ Upsert contact (GHL)
                                     └─ Log message (GHL, direction inbound)

OUTBOUND:      Form / [future] GHL native app
                 ├─ Normalize phone to E.164 (+1 if missing)
                 ├─ Upsert contact (GHL)  ──▶ returns contact + tags + id
                 ├─ IF contact.tags includes "imessage"
                 │     TRUE  ─▶ BlueBubbles send (iMessage)
                 │     FALSE ─▶ Telnyx send (SMS)
                 └─ Log message (GHL, direction outbound)

INBOUND iMessage: BlueBubbles "New Message" webhook ─▶ Express ─▶ persist + notify
```

## V2 PWA notification outbox

The current V2 service now persists inbound provider activity locally and, after
that source write succeeds, creates a deduplicated `notification_events` row plus
per-user receipts and subscription deliveries. An in-process worker claims the
SQLite outbox and sends standards-based VAPID Web Push. This is separate from the
legacy n8n flow shown above and does not alter Telnyx app-then-cell forwarding.

The installable shell, API surface, provider verification rollout, and operational
model are documented in [Phase 1 PWA and Web Push](pwa-web-push.md). The V2 service
worker is scoped to `/v2/` and caches no authenticated CRM or borrower data.

## GoHighLevel (services.leadconnectorhq.com)

Headers on every call: `Authorization: Bearer <PIT or OAuth token>`,
`Version: 2021-04-15`, `Content-Type: application/json`.

- **Upsert contact** (find-or-create by phone; returns full contact incl. `tags`, `id`):
  `POST /contacts/upsert` — body `{ "locationId", "phone" }`. Keep the body minimal;
  example junk (custom fields, assignedTo) causes 400/404s.
- **Log message** (threads onto the contact's conversation):
  `POST /conversations/messages/inbound` — body
  `{ "type": "SMS", "contactId", "message", "direction": "inbound"|"outbound" }`.
  **Requires the `conversations/message.write` scope** (distinct from `conversations.write`).
  `conversationProviderId` is NOT required for the basic PIT route.
- **Search contacts** (finicky — prefer upsert): `POST /contacts/search`,
  `Version: 2023-02-21`, requires numeric `pageLimit`. Uses a `filters` array.

PIT scopes needed: `contacts.readonly`, `contacts.write`, `conversations.readonly`,
`conversations.write`, `conversations/message.write` (+ `.readonly`).

## Telnyx (api.telnyx.com)

- **Send SMS**: `POST /v2/messages`, header `Authorization: Bearer <TELNYX_API_KEY>`,
  body `{ "from": "+16197826916", "to": "<E.164>", "text", "messaging_profile_id": "40019e71-8d3d-47bc-9ac2-1f138e016dd1" }`.
  `to` must be E.164 (`+1...`) or you get error `40310 Invalid 'to' address`.
- **Inbound webhook** points at the n8n inbound URL. Telnyx fires several event
  types per message; only `data.event_type == "message.received"` is a real inbound text.
- Inbound payload paths: sender `data.payload.from.phone_number`, text `data.payload.text`.
- US A2P 10DLC registration is required (Low Volume Standard, EIN-based).

## BlueBubbles (Mac, via Cloudflare tunnel)

- Auth: server password as query param `?password=` (aliases `guid`, `token`). Use **alphanumeric only** (symbols break URL parsing).
- **Ping**: `GET {host}/api/v1/ping?password=...` → `{"status":200,...,"data":"pong"}`.
- **Send text**: `POST {host}/api/v1/message/text?password=...`, body
  `{ "chatGuid": "iMessage;-;<+E164>", "tempGuid": "<unique-per-send>", "message" }`.
- **iMessage availability check & rich features require the Private API** (= disabling
  SIP). Left disabled → availability returns 500 "iMessage Private API is not enabled".
  Hence routing uses the **`imessage` tag**, not live blue/green detection.
- Quirks: a **524** from Cloudflare usually means the text *sent* but the ack timed
  out (set the node's On Error → Continue). A reused `tempGuid` → 400 "already queued";
  generate a unique one each send.
- Inbound iMessage uses BlueBubbles **Webhooks → "New Messages"** (server v1.0.0+).

## n8n gotchas (from the build)

- Header names: no trailing spaces (`ERR_INVALID_HTTP_TOKEN`).
- Reference other nodes by **exact** name: `$('node-name')`; click-to-map to avoid typos.
- HTTP node "Parse Response" must be ON to drill into JSON (e.g. `data.contact.id`).
- Expression fields: in Expression mode write `{{ ... }}` with **no leading `=`**
  (the `=` is only for forcing a fixed field into expression mode; otherwise it leaks
  into the value, e.g. `=+16232808351`).
- IF on a boolean expression: set the operator type to **Boolean → is true**.
- Phone normalize expression:
  `{{ $json.phone.startsWith('+') ? $json.phone : '+1' + $json.phone }}`

## GHL native app (next build) — intended shape

> Security status: the historical `/providers/ghl/messages` delivery bridge is
> retired and returns 410 at both root and `/v2` aliases. The diagram below is
> historical design context, not an active or approved provider contract.

Goal: send from GHL's conversation tab; keep n8n as the routing brain.

```
GHL conversation tab (type + send)
  └─▶ GHL POSTs to the conversation provider's Delivery URL
        └─▶ OAuth app (this repo)  — validates, then routes
              ├─ imessage tag → BlueBubbles    (or hands to existing n8n flow)
              └─ else         → Telnyx SMS
        └─▶ status / inbound reported back via Conversations API
```

Needs: marketplace app (private/unpublished, no review), OAuth client id/secret +
redirect, a **conversation provider of type SMS**, and **token refresh** (access
token expires ~24h — the genuinely fiddly part). Token exchange:
`POST /oauth/token`, `Content-Type: application/x-www-form-urlencoded`.

## Telnyx Voice (calling)

Uses a **Voice API Application** (Call Control) — `TELNYX_VOICE_APP_ID` = its connection_id —
with the number assigned to it and its webhook → `/webhooks/telnyx-voice`. No recording.

- **Place call**: `POST /v2/calls` { connection_id, to, from } → `call_control_id`.
- **Actions**: `/v2/calls/{ccid}/actions/{answer|hangup|bridge|transfer|speak|gather_using_speak}`.
- **Events** (to the app webhook): `call.initiated` (direction `incoming` = inbound), `call.answered`,
  `call.gather.ended` (`digits`), `call.bridged`, `call.hangup` (`hangup_cause`).
- **DTMF** must be **RFC 2833** on the connection (the IVR keypresses rely on it).
- Outbound calls require an **Outbound Voice Profile** on the application (inbound works without).

Flows (in-memory call context keyed by call_control_id):
- **click-to-call**: dial `MY_CELL` → on answer dial contact → on answer bridge. Logs on the primary leg's hangup.
- **automated**: dial contact → on answer dial `MY_CELL` → bridge. Queued + paced + gated.
- **inbound**: answer → `gather_using_speak` IVR → digit 1 = transfer to `MY_CELL`, digit 9 = addToDnc + goodbye.

Compliance gates (`services/compliance.ts`): consent tag (automated), DNC (`services/dnc.ts`,
`{TOKEN_DIR}/dnc.json`), calling hours via the contact's IANA `timezone` (missing → skip), throttle
(`callQueue.ts`). Calls logged to GHL via `logCall` (type `Call`), which requires a **Type: Call**
conversation provider (`GHL_CALL_CONVERSATION_PROVIDER_ID`) — the SMS provider is rejected for calls;
outbound logs to `/conversations/messages/outbound`, inbound to `/inbound`.

## CRM (self-contained lead management + automations)

A self-contained CRM layered on the same service. **SQLite is the system of record**
(`{TOKEN_DIR}/crm.db`, via `better-sqlite3`) — leads/notes/activity live locally, not in
GHL. GHL mirroring of outbound texts is optional (`CRM_MIRROR_TO_GHL=true` + a linked
`ghl_contact_id`).

**Data model** (`store/db.ts`): `leads`, `notes`, `activities` (timeline), `automations`,
`automation_runs`, `automation_jobs` (the scheduler queue). Services: `services/leads.ts`
(CRUD + notes + activity), `services/automations.ts` (engine + worker), `services/email.ts`
(Resend), `services/voicemail.ts` (Telnyx AMD drop).

**Lead intake** — `POST /webhooks/lead?key=LEAD_WEBHOOK_SECRET` (public, secret-gated; point
your website form here). Body is flexible: `first_name`/`last_name` (or `name`), `email`,
`phone`, `source`, `loanType`, `message`, `timeline`; any extra fields are kept in the lead's
`custom` JSON. Intake `categorize()`s the lead (from `loanType`/`message`) into a `category`
+ `campaign`, which is how a drip claims its leads (`leadMatchesFilter` matches on
`category`/`source`). **Consent is recorded, not gating** (owner decision): `consent` (email —
implied by a website submission) and `sms_consent` (the opt-in *record*; the funnel's raw
`smsOptIn` answer is also kept in `custom.smsOptIn`, and an explicit "yes" stamps `consent_at`).
Texting is on for every lead by default — the one hard SMS suppression is the **DNC list**:
`send_text` skips any number on it (logged `skipped:dnc` on the timeline), and the router,
calls, and voicemail drops check it too. DNC is set by a STOP reply, IVR opt-out, or the
console's DNC button (`POST /api/leads/:id/dnc`). Dedup by phone/email — a re-submission
updates the lead, *upgrades* `sms_consent` if newly opted in, and **restarts** the drip
(cancels in-flight steps, then re-fires). A new lead fires the `lead_created` trigger; the
response carries a `note` (via `diagnoseEnrollment`) when nothing enrolled, so a misconfigured
drip is visible without reading logs.

**Console API** (passcode-gated, `x-app-passcode`): `GET/POST /api/leads`,
`GET/PATCH /api/leads/:id`, `POST /api/leads/:id/{notes,message,call,run-automation}`,
`GET/POST /api/automations`, `PATCH /api/automations/:id`. Console UI adds **Leads** and
**Flows** tabs (`public/console.html`).

**Automation engine** — an automation has a `trigger` (`lead_created`), an optional `filter`
(e.g. `{ source: "website" }`), and ordered `steps`. Firing creates a run and inserts one
`automation_jobs` row per step, with `run_at` staggered by each step's cumulative
`delayMinutes`. A worker (`startAutomationWorker`, every `AUTOMATION_POLL_MS`) runs due jobs:
- `send_email` → Resend (skips if lead has no email / not configured)
- `send_text` → iMessage-first router → SMS (DNC-gated in the router)
- `voicemail_drop` → Telnyx AMD; **calling-hours gated** when a timezone is known
  (lead's or `CRM_DEFAULT_TIMEZONE`) — outside the window the job **reschedules** to the
  next window start rather than skipping
- `add_tag`, `set_status`, `wait`
Templates support `{{first_name}}`, `{{last_name}}`, `{{name}}`, `{{phone}}`, `{{email}}`.
Failed steps retry up to 3× (2-min backoff). A default "New Website Lead — Welcome" flow is
**seeded disabled** on first boot — enable it in the Flows tab after setting the copy.

**Voicemail drop (Telnyx AMD)** — `placeCallWithAmd` (`answering_machine_detection: detect`)
→ on `call.machine.detection.ended` with `result == machine`, `playback_start` the
`VOICEMAIL_AUDIO_URL`; human/not_sure/silence → hang up (no robo-drop on a live person).
The voice webhook routes events for these legs to `services/voicemail.ts` first.
NOTE: this calls + detects the greeting; it is **not** a true carrier ringless injection, so
the phone may briefly ring. DNC + calling-hours gates apply.
