# Smartr8 Texting + Calling System

Hybrid **SMS + iMessage + Voice** for a mortgage business (Adaxa Home Loans / Mykoal),
fronted by **GoHighLevel (GHL)** so every message and call threads on the contact.

## ⚠️ Where this runs

- This repo is developed via **Claude Code in the cloud** (attached to `mdeshazo/smartr8-texting`).
  It **cannot** reach the Mac/BlueBubbles, the live service, or dashboards directly — it builds
  and commits code; **Render auto-deploys** from branch `claude/practical-ride-3flGM`.
- The **production app is the Node/TypeScript service on Render** (`smartr8-texting-1wx7.onrender.com`).
  It is a GHL **conversation provider** + Telnyx SMS/Voice + BlueBubbles iMessage, all logging to GHL.
  (The earlier **n8n** flows were the prototype; the service supersedes them for the GHL-native path.)

| Component | Role | Where |
|-----------|------|-------|
| **GHL** | CRM / front-end (conversations, contacts, tags) | Cloud. Location `6eS74TvNAtT24FhvYn1t` |
| **This service** | Routing brain: provider delivery, webhooks, calling, compliance | Render (Starter + 1GB disk at `/data`) |
| **Telnyx** | SMS + **Voice** (number `+16197826916`, msg profile `40019e71-…`, Voice API App = `TELNYX_VOICE_APP_ID`) | Cloud |
| **BlueBubbles** | iMessage send/receive | A Mac (needs always-on) via Cloudflare tunnel |

## 🔁 PR workflow (auto-merge)

- The owner has granted **standing permission to auto-merge Claude-authored PRs**. The flow is:
  branch → push → open PR (base `claude/practical-ride-3flGM`) → **wait for the CI build check to
  pass** → **merge it** (no manual approval needed).
- **Only merge on green CI.** If the build fails, or a review comment is genuinely ambiguous or
  architecturally significant, stop and check with the owner instead of merging.

## 🔒 Secrets policy

- **Never commit secrets** — `.env` is gitignored; see `.env.example` for the full key list.
- **Rotate the two exposed creds**: GHL PIT and the BlueBubbles password.

## What the service does (endpoints)

- `GET /health` — up + BlueBubbles reachability.
- `GET /oauth/install`, `/oauth/callback` — GHL OAuth (tokens auto-refresh, stored on the disk).
- `POST /providers/ghl/messages` — GHL conversation-provider Delivery URL (outbound send).
- `POST /webhooks/telnyx` — inbound SMS → log to GHL + one-time iMessage probe.
- `POST /webhooks/bluebubbles` — inbound iMessage → log to GHL.
- `POST /webhooks/telnyx-voice` — inbound calls + all call events.
- `POST /calls/click-to-call` · `POST /calls/automated` · `GET /calls/queue` — calling.
- `POST /dnc` · `GET /dnc` — Do-Not-Call list.
- `POST /webhooks/lead` — website lead intake (secret-gated) → creates a lead + fires automations.
- `GET/POST /api/leads` · `GET/PATCH /api/leads/:id` · `POST /api/leads/:id/{notes,message,call,run-automation}` — CRM (passcode-gated).
- `GET/POST /api/automations` · `PATCH /api/automations/:id` — lead automations (passcode-gated).
- `GET /app` (softphone) · `GET /console` (Leads · Messages · Contacts · Dialer · Flows) — browser UIs.
- `POST /webrtc/token` — mint a short-lived Telnyx WebRTC token (passcode-gated).
- `POST /api/messages/send` · `GET /api/messages/:contactId` · `GET /api/contacts` — console API (passcode-gated).

### Browser softphone + console + Edge extension
- **Softphone** (`/app`, PWA-installable) and **Edge/Chrome extension** (`edge-extension/`):
  Telnyx **WebRTC** calling from the browser; audio runs in the page (extension uses a
  persistent offscreen document). Auth = short-lived token from `/webrtc/token`.
- **Console** (`/console`): outbound texting (via the same iMessage-first router), a polling
  thread view, and GHL contact search/tap-to-text/call. Gated by `APP_PASSCODE`.

### Messaging behavior
- **Outbound:** iMessage-first → on clear failure auto-falls back to **Telnyx SMS** (524/timeout = probably delivered, no fallback). GHL status reported (no duplicate logging).
- **Inbound SMS:** logged to GHL; fires a **one-time iMessage capability probe** that tags the contact `imessage` / `sms-only` (+ `probed`); threads the probe message in when iMessage-capable.

### CRM (self-contained lead management + automations)
- **System of record is SQLite** on the disk (`{TOKEN_DIR}/crm.db`), not GHL: leads, notes,
  an activity timeline, automations. GHL mirroring of texts is optional (`CRM_MIRROR_TO_GHL`).
- **Website lead intake:** `POST /webhooks/lead?key=LEAD_WEBHOOK_SECRET` (flexible body;
  extra fields → the lead's `custom`). Dedups by phone/email; a new lead fires `lead_created`.
- **Automation engine:** trigger → ordered steps (`send_email` via Resend, `send_text` via the
  iMessage-first router, `voicemail_drop` via Telnyx AMD, `add_tag`, `set_status`, `wait`),
  each with a `delayMinutes`; a background worker runs due steps. Voicemail is **calling-hours
  gated** (reschedules outside the window). A default "New Website Lead" flow is **seeded
  disabled** — enable it in the **Flows** tab after editing the copy.
- **Console:** new **Leads** tab (search, status filters, detail with timeline, notes,
  tap-to-text/call, status changes, manual add) and **Flows** tab (toggle/edit automations).

### Calling behavior + HARD compliance gates
- **Click-to-call** (manual): rings your cell → dials contact → bridges. DNC-checked; consent/hours exempt.
- **Inbound:** answer → IVR (1 = forward to cell, 9 = opt-out → DNC).
- **Automated dialer:** queued, paced (`CALL_THROTTLE_MS`), one at a time.
- A call **cannot place** unless gates pass: **consent** (`call_consent` tag, automated only), **DNC**
  (every outbound), **time-window** (`CALL_HOURS_START..END` in the contact's GHL timezone; missing tz → skip),
  **opt-out** (IVR keypress → DNC). Every skip logs its reason. **No recording.**

## Env vars
See `.env.example`. Key ones: GHL OAuth (`GHL_CLIENT_ID/SECRET/REDIRECT_URI/CONVERSATION_PROVIDER_ID`,
`GHL_LOCATION_ID`), Telnyx (`TELNYX_API_KEY/FROM_NUMBER/MESSAGING_PROFILE_ID`, `TELNYX_VOICE_APP_ID`,
`MY_CELL_NUMBER`), BlueBubbles (`BLUEBUBBLES_URL/PASSWORD`), compliance (`CALL_CONSENT_TAG`,
`CALL_HOURS_START/END`, `CALL_THROTTLE_MS`), `TOKEN_DIR=/data` on Render. CRM:
`LEAD_WEBHOOK_SECRET`, `RESEND_API_KEY` + `EMAIL_FROM` (email step), `VOICEMAIL_AUDIO_URL`
(voicemail drop), optional `CRM_DEFAULT_TIMEZONE` / `AUTOMATION_POLL_MS` / `CRM_MIRROR_TO_GHL`.

## Honest caveats / TODO(verify)
- **iMessage sending** is best-effort without the BlueBubbles Private API (SIP). Bulk → lean on SMS.
- **A2P 10DLC**: SMS submits but carrier delivery firms up only after the Telnyx campaign is approved.
- **GHL call-logging** needs a **Type: Call** conversation provider (the SMS one is rejected for type `Call`). Create a 2nd provider in GHL and set `GHL_CALL_CONVERSATION_PROVIDER_ID`; outbound logs via `/conversations/messages/outbound`, inbound via `/inbound`.
- **Reliability**: BlueBubbles needs an always-on Mac + a **named Cloudflare tunnel** (fixed URL); the
  quick-tunnel URL rotates on restart and breaks `/health`.

See `docs/architecture.md` for exact endpoints, payloads, and gotchas.
