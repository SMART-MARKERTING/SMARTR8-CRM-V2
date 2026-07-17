# Emergency Provider Lockdown Operations Guide

This guide covers the Phase 1 provider-perimeter lockdown. It does not enable
webhook enforcement, change Cloudflare routing, harden WhatsApp delivery, or
change ordinary voice/fax/email delivery and call-routing behavior, PWA, Web
Push, Notification Center, or `/console` assets.

## Disabled routes

The retired GHL conversation-provider delivery bridge is permanently blocked
before request-body parsing:

| Route | Response | Former risk |
|---|---:|---|
| `POST /providers/ghl/messages` | `410 {"error":"gone"}` | Accepted an unauthenticated recipient/message and invoked iMessage/SMS delivery. |
| `POST /v2/providers/ghl/messages` | `410 {"error":"gone"}` | Same router mounted beneath `/v2`. |

The bridge has no environment-variable bypass and no longer imports or calls
`sendOutbound`, GHL contact/status methods, Telnyx, or BlueBubbles.

These historical test/simulator actions are permanent `404` tombstones in all
environments and run before body parsing:

- `POST /api/whatsapp/debug/simulate-inbound`
- `POST /v2/api/whatsapp/debug/simulate-inbound`
- `GET /api/telnyx/test-send`
- `GET /v2/api/telnyx/test-send`
- `GET /calls/diag?place=1`
- `GET /v2/calls/diag?place=1`

The ordinary read-only `GET /calls/diag` remains available to an administrator.
WhatsApp diagnostics remain administrator-only, read-only, and redact contact
IDs, phone numbers, provider message IDs, and message bodies. Parser and provider
behavior must be tested with fixtures and mocks, not production simulators.

## Step-up administrator authorization

The retained high-risk operations now require all of the following:

1. A valid server-side session token.
2. An enabled administrator user.
3. A recent portal/session step-up verification.
4. Server-derived actor identity.

The legacy `APP_PASSCODE` cannot satisfy this gate. Top-level client-supplied
`actor`, `userId`, `ownerId`, `role`, `provider`, or recipient identity fields are
rejected. Successful mutations create an audit event derived from the session.

The stronger gate covers global GHL import/status/diagnostics, source audit,
import purge/revert, global contact deduplication, lead-pool repair, Classic CRM
reconciliation, Resend inbound sync, provider settings writes, voicemail media
configuration, the BlueBubbles registration helper, Telnyx SIP-URI configuration,
global messaging-mode changes, and Render redeploy.

## Redacted provider security inventory

No secret values belong in this inventory, Git, screenshots, tickets, or chat.
The root aliases reach the Render service directly; `/v2` aliases are also
reachable through the existing Cloudflare `/v2*` route.

| Provider | Current public callbacks and aliases | Verification variables and current state | Raw bytes / URL exactness | Replay identifier and mutations | Dashboard and safe rollout |
|---|---|---|---|---|---|
| Telnyx SMS | `POST /webhooks/telnyx`; `POST /v2/webhooks/telnyx` | `TELNYX_PUBLIC_KEY`; `WEBHOOK_ENFORCE_TELNYX_SMS`. Currently rollout-optional: absent key is accepted while enforcement is false. | Original raw JSON is required for Ed25519. Signature does not depend on callback URL, but the configured URL must not redirect. | `data.id` or message payload ID. Creates/updates leads, consent/DNC keyword state, messages, activities, notifications, and may invoke the iMessage probe. | Telnyx Mission Control Portal → Messaging → Messaging Profiles → selected profile → Webhook URL. Confirm signed fixtures and delivery history, then enable only this flag. [Telnyx guidance](https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks). |
| BlueBubbles | `POST /webhooks/bluebubbles`; `POST /v2/webhooks/bluebubbles` | `BLUEBUBBLES_WEBHOOK_SECRET`; `WEBHOOK_ENFORCE_BLUEBUBBLES`. Currently rollout-optional. `BLUEBUBBLES_URL` and `BLUEBUBBLES_PASSWORD` authenticate server API calls, not inbound callbacks. | Raw bytes are not used. The callback URL is not part of the shared-secret check. | Message GUID when present. Creates/updates leads, DNC keyword state, messages, activities, notifications, and GHL mirrors. | BlueBubbles Server → API & Webhooks → Manage Webhooks. Configure the shared secret at both ends, validate a mocked/signed fixture, then enable only this flag. [BlueBubbles setup](https://docs.bluebubbles.app/server/developer-guides/simple-web-server-for-webhooks). |
| Resend | `POST /api/webhooks/resend`; `POST /v2/api/webhooks/resend` | `RESEND_WEBHOOK_SECRET`; `WEBHOOK_ENFORCE_RESEND`. Currently rollout-optional. `RESEND_API_KEY` is outbound/API authentication. | Exact original raw body plus `svix-id`, `svix-timestamp`, and `svix-signature` are required. URL is not part of Svix verification. | `svix-id` is the delivery identifier; email/message ID is also available. Stores inbound email, creates/updates leads and activities, and creates notifications. | Resend Dashboard → Webhooks → selected endpoint. Confirm raw-body verification and replay handling before enabling only this flag. [Resend verification](https://resend.com/docs/webhooks/verify-webhooks-requests). |
| Meta WhatsApp | `GET/POST /api/webhooks/whatsapp`; `GET/POST /v2/api/webhooks/whatsapp` | `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`; `WEBHOOK_ENFORCE_META_WHATSAPP`. Currently shared-route/rollout-optional. | Original raw JSON is required for `X-Hub-Signature-256`. The GET callback URL must match the Meta configuration but is not signed into the HMAC. | `messages[].id` and `statuses[].id`. Mutates leads, WhatsApp consent/window state, messages, activities, and notifications. | Meta for Developers → selected App → WhatsApp → Configuration → Webhooks. Do not update or enforce until Phase 2 creates a canonical Meta-only route and validates identity/signatures. |
| Twilio WhatsApp | `POST /api/webhooks/whatsapp`; `POST /v2/api/webhooks/whatsapp` | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`; `WEBHOOK_ENFORCE_TWILIO_WHATSAPP`. Currently shared-route/rollout-optional. | Form parameters are required. The exact externally visible URL and encoding are part of `X-Twilio-Signature` validation. | `MessageSid`/`SmsSid`. Mutates leads, WhatsApp consent/window state, messages, activities, statuses, and notifications. | Twilio Console → Messaging → Senders → WhatsApp Senders → selected sender. Do not update or enforce until Phase 2 creates distinct inbound/status routes using a trusted fixed public URL. [Twilio verification](https://www.twilio.com/docs/usage/webhooks/webhooks-security). |
| Telnyx Fax | `GET/POST /api/webhooks/telnyx/fax`; `GET/POST /v2/api/webhooks/telnyx/fax` | `TELNYX_PUBLIC_KEY` is required and verification is fail-closed. API/config variables: `TELNYX_API_KEY`, `TELNYX_FAX_APPLICATION_ID`, `TELNYX_FAX_FROM_NUMBER`. | Original raw JSON is required for Ed25519. URL is not part of the signature. | `data.id`; fax ID is also stored. The callback mutates fax records, files/documents, lead activities, and notifications. Authenticated fax operations separately write audit events. | Telnyx Mission Control Portal → Programmable Fax → Fax Applications → selected app → Webhook URL. Preserve fail-closed verification; confirm event deduplication before any dashboard change. |
| Telnyx Voice | `POST /webhooks/telnyx-voice`; `POST /v2/webhooks/telnyx-voice` | `TELNYX_PUBLIC_KEY` is required and verification is fail-closed. API/config variables: `TELNYX_API_KEY`, `TELNYX_VOICE_APP_ID`, `TELNYX_FROM_NUMBER`, `TELNYX_SIP_CONNECTION_ID`. | Original raw JSON is required for Ed25519. URL is not part of the signature; redirects are webhook failures. | `data.id`; call-control/session/leg IDs correlate calls. Mutates live call state, call logs, DNC/IVR state, summaries, activities, and notifications, and can issue call commands. | Telnyx Mission Control Portal → Voice → Programmable Voice/Call Control Applications → selected app → Webhook URLs. Do not change app-then-cell routing in this phase. [Telnyx webhook fundamentals](https://developers.telnyx.com/development/api-fundamentals/webhooks/receiving-webhooks). |
| GHL | Retired bridge: `POST /providers/ghl/messages` and `/v2/providers/ghl/messages` return 410. Shared-secret workflow callbacks remain at root and `/v2`: `/ghl/workflow/send-message`, `/place-call`, `/add-to-dnc`. OAuth remains under `/oauth/*` and `/v2/oauth/*`. | Retired bridge has no re-enable switch. Workflow callbacks require `GHL_ACTION_SECRET` or return 503/401. OAuth/API variables include `GHL_CLIENT_ID`, `GHL_CLIENT_SECRET`, `GHL_REDIRECT_URI`, `GHL_LOCATION_ID`, and provider IDs. | GHL workflow shared-secret validation does not use raw bytes or URL signing. OAuth redirect exactness matters. | Workflow payload has no durable replay ledger. Depending on action, it can send messages, place a call, alter DNC, and update GHL. | GoHighLevel Marketplace → selected private app → Conversation Providers / Workflow Actions / Auth. Remove the retired Delivery URL; preserve historical data and OAuth during Phase 1. Do not invent a signature scheme or restore the bridge. |

## Pre-deployment checklist

- Confirm the deploy branch contains the 410 GHL tombstone and the pre-parser
  production safety router.
- Confirm no `WEBHOOK_ENFORCE_*` value changed in Render.
- Confirm the existing Cloudflare `crm.smartr8.com/v2*` route is unchanged.
- Confirm the Render environment contains only privately managed values. Do not
  paste or print them while checking variable presence.
- Export provider-dashboard delivery history if suspicious GHL deliveries,
  unexpected messages, or unknown callbacks are visible.
- Run Node 22 `npm ci`, typecheck, tests, builds, and production dependency audit.

## Harmless post-deployment verification

These requests exercise only permanent tombstones or static/read-only paths. Do
not include a phone number, message body, provider signature, or credential.

```bash
curl -i -X POST https://loangenius-v2.onrender.com/providers/ghl/messages -H 'Content-Type: application/json' --data '{}'
curl -i -X POST https://crm.smartr8.com/v2/providers/ghl/messages -H 'Content-Type: application/json' --data '{}'
curl -i -X POST https://crm.smartr8.com/v2/api/whatsapp/debug/simulate-inbound -H 'Content-Type: application/json' --data '{}'
curl -i 'https://crm.smartr8.com/v2/api/telnyx/test-send'
curl -i 'https://crm.smartr8.com/v2/calls/diag?place=1'
curl -i https://crm.smartr8.com/v2/
curl -i https://crm.smartr8.com/v2/manifest.webmanifest
curl -i https://crm.smartr8.com/v2/sw.js
curl -i https://crm.smartr8.com/console
```

Expected: both retired GHL routes return 410; simulator/test paths return 404;
the V2 shell, manifest, service worker, and `/console` remain available. Do not
send forged payloads to active provider callbacks as a production test.

## Suspicious-activity and credential-rotation guidance

If logs or provider dashboards show unexplained outbound activity:

1. Preserve request IDs, timestamps, delivery logs, deploy IDs, and affected
   provider/message IDs without copying message bodies or recipient data.
2. Disable the affected outbound integration in its provider dashboard.
3. Rotate only credentials that may have been exposed: GHL action/OAuth secrets,
   Telnyx API keys, BlueBubbles password/webhook secret, Resend API/webhook keys,
   or selected WhatsApp credentials.
4. Update private Render variables, redeploy, revoke old credentials, and confirm
   old credentials no longer appear in provider audit logs.
5. Review the repository incident-response plan and determine whether vendor,
   customer, legal, or regulatory notification is required.

## Rollback without reopening the bridge

Never roll production back to a commit where the GHL bridge can send. If another
Phase 1 change must be rolled back, revert that change selectively while retaining:

- the `providerRouter` 410 tombstone,
- its pre-body-parser root and `/v2` mounts, and
- the production safety tombstones.

If a full application rollback is unavoidable, first deploy a minimal hotfix on
the target commit that preserves those tombstones. Do not use an environment flag
or ordinary CRM login to restore the former route.

No iPhone Home Screen reinstall is required for this backend-only lockdown.
