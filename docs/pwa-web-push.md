# Phase 1 PWA and Web Push

This document covers the installable `/v2` CRM, standards-based Web Push, the
durable notification outbox, and provider-event security. Phase 1 keeps the
current Render/SQLite architecture and does not add a native iOS application.

## Scope and boundaries

- The installable app is `https://crm.smartr8.com/v2` with scope `/v2/`.
- The existing root CRM and `/console` service worker are unchanged.
- The service worker does not cache CRM pages, API responses, borrower data, or
  authenticated responses. Phase 1 is online-only.
- A push notification can open the relevant CRM screen. It cannot answer a
  Telnyx call, expose a native CallKit screen, or guarantee delivery through iOS
  Focus modes.
- Notification payloads are generic by default. Enhanced previews may contain a
  sanitized first name, but never phone numbers, email addresses, message bodies,
  document names, loan details, access tokens, or provider secrets.

## Architecture

Provider webhooks first pass authentication and persist the underlying CRM event.
Only then does the application insert a notification event, resolve its eligible
recipient, create a per-user receipt, and enqueue one delivery for each active
subscription. The HTTP response is not blocked on an Apple/Google push endpoint.

The in-process worker claims due deliveries atomically, sends them with VAPID,
and records the result. Network failures, HTTP 408/425/429, and 5xx responses use
bounded exponential backoff for up to five attempts. HTTP 404/410 responses
revoke the expired subscription. A stale claim is recovered automatically after
five minutes.

Recipient selection is deliberately conservative:

1. The lead/contact's enabled assigned owner, if that user has access to the
   corresponding feature.
2. `DEFAULT_NOTIFICATION_USER_ID`, if configured and eligible.
3. The primary enabled administrator with feature access.

Disabled users, channel opt-outs, quiet hours, and missing feature permissions
suppress delivery. Per-user receipt rows keep read, opened, dismissed, and
cleared state isolated; one user's action cannot hide another user's item.

### SQLite tables

| Table | Purpose |
|---|---|
| `push_subscriptions` | User-owned Web Push endpoint and browser key material; supports revocation and last-seen timestamps. |
| `notification_events` | Durable, deduplicated domain notification with safe deep link and payload. |
| `notification_receipts` | Durable event-recipient mapping and per-user read/open/dismiss/clear state. |
| `notification_deliveries` | Per-subscription outbox state, claim token, retries, provider response, and delivery timestamps. |
| `notification_preferences` | Channel toggles, preview mode, app badge preference, and quiet hours for each user. |

The migration is additive and runs through the existing SQLite bootstrap. It
does not rewrite legacy CRM records.

## Environment configuration

Generate a VAPID keypair once:

```bash
npx web-push generate-vapid-keys --json
```

Set both generated values in Render. A public and private value from different
pairs will fail. Do not commit or log the private key.

| Variable | Required | Notes |
|---|---:|---|
| `WEB_PUSH_VAPID_PUBLIC_KEY` | Yes for push | Public URL-safe base64 VAPID key. |
| `WEB_PUSH_VAPID_PRIVATE_KEY` | Yes for push | Secret VAPID private key. |
| `WEB_PUSH_CONTACT` | Yes for push | `mailto:` or HTTPS operator contact; default is `mailto:security@smartr8.com`. |
| `NOTIFICATION_WORKER_POLL_MS` | No | Poll period, minimum 1000 ms; default 5000. |
| `DEFAULT_NOTIFICATION_USER_ID` | No | Fallback user id, username, or display name. Otherwise an eligible admin is selected. |
| `BLUEBUBBLES_WEBHOOK_SECRET` | For BlueBubbles verification | Long random shared secret. |
| `WEBHOOK_ENFORCE_TELNYX_SMS` | Rollout | Set `true` after Telnyx is confirmed to send valid signatures. |
| `WEBHOOK_ENFORCE_BLUEBUBBLES` | Rollout | Set `true` after the shared secret is configured at both ends. |
| `WEBHOOK_ENFORCE_RESEND` | Rollout | Set `true` after the Resend signing secret is configured. |
| `WEBHOOK_ENFORCE_META_WHATSAPP` | Rollout | Set `true` after `WHATSAPP_APP_SECRET` is configured. |
| `WEBHOOK_ENFORCE_TWILIO_WHATSAPP` | Rollout | Set `true` after `TWILIO_AUTH_TOKEN` and the public webhook URL are confirmed. |

The application version stored with a subscription comes from
`RENDER_GIT_COMMIT` (or `SOURCE_VERSION` outside Render).

## API surface

Every endpoint below requires the existing authenticated CRM session. Write and
test routes are rate-limited, request sizes and Web Push key shapes are bounded,
and the server always derives the user id from the session.

| Method and path | Purpose |
|---|---|
| `GET /v2/api/push/public-key` | Fetch the public VAPID key. |
| `GET /v2/api/push/status` | Check server configuration and the signed-in user's active devices. |
| `POST /v2/api/push/subscribe` | Create or refresh this user's device subscription. |
| `DELETE /v2/api/push/subscribe` | Revoke this user's matching device endpoint. |
| `POST /v2/api/push/test` | Enqueue a generic test notification for the signed-in user. |
| `GET /v2/api/notification-preferences` | Read channel, privacy, badge, and quiet-hour settings. |
| `PATCH /v2/api/notification-preferences` | Update the signed-in user's settings. |
| `GET /v2/api/notifications` | List the signed-in user's durable notification receipts. |
| `POST /v2/api/notifications/read-all` | Mark this user's current notification receipts read. |
| `POST /v2/api/notifications/:id/read` | Mark one receipt read. |
| `POST /v2/api/notifications/:id/opened` | Record a notification click/open. |
| `POST /v2/api/notifications/:id/dismiss` | Dismiss one receipt for this user. |
| `POST /v2/api/notifications/:id/clear` | Compatibility alias for per-user dismissal. |
| `DELETE /v2/api/notifications/:id` | Explicitly delete the underlying source record when authorized. |

Equivalent non-prefixed routes remain mounted for direct service access.
Subscriptions cannot be transferred between users by replaying an endpoint; a
conflict requires the original signed-in user to disable it first.

## Cloudflare routing

The existing Worker route `crm.smartr8.com/v2*` already matches `/v2`, deeper
paths such as `/v2/sw.js`, and requests with query strings. The Worker forwards
the original path and query to Render, so no Worker change is required. Keep the
route attached to this repository's Render origin and verify these public paths
after deploy:

- `/v2`
- `/v2/manifest.webmanifest`
- `/v2/sw.js`
- `/v2/health`

Cloudflare's current route-pattern behavior is documented at
<https://developers.cloudflare.com/workers/configuration/routing/routes/>.

## Provider webhook rollout

Signature enforcement is separated by provider to avoid an all-at-once cutover.
For each provider:

1. Configure its public webhook URL and signing key/shared secret.
2. Leave that provider's enforcement flag `false` while confirming diagnostics.
3. Send a signed test event and confirm the underlying activity is persisted once
   and exactly one notification event is created.
4. Send a deliberately invalid signature and confirm it receives a 401/403,
   creates no CRM activity, and enqueues no notification.
5. Set the provider's enforcement flag to `true` and redeploy.

When a verification key/secret is already configured, invalid signatures are
rejected even during rollout. Logs include event ids and an endpoint fingerprint,
not subscription keys, secrets, or full message bodies.

BlueBubbles accepts the shared secret through `X-BlueBubbles-Secret`, a Bearer
authorization header, or the `key` query value used by the existing admin-only
webhook registration helper. The helper appends the configured secret when it
registers the URL and redacts it from application logs and diagnostics.

## iPhone install and permission test

Web Push for Home Screen web apps requires iOS/iPadOS 16.4 or later.

1. In Safari, open `https://crm.smartr8.com/v2` and sign in.
2. Tap **Share**, then **Add to Home Screen**, and confirm **Add**.
3. Launch SMARTR8 CRM from the new Home Screen icon. Do not use the original
   Safari tab for the permission test.
4. Open **Settings > Notifications** in the CRM and tap **Enable Notifications**.
   iOS permission is requested only from this explicit tap.
5. Choose **Allow**, then tap **Send Test Notification**.
6. Background the app and confirm the notification appears. Tap it and confirm
   the installed CRM focuses or opens the expected `/v2` screen.
7. If permission was denied, use iPhone **Settings > Notifications > SMARTR8 CRM**
   to enable it; reinstalling is normally unnecessary.

## Manual acceptance checklist

- [ ] Install from Safari and launch in standalone mode with the correct icon,
      name, portrait layout, theme color, and no Safari browser chrome.
- [ ] Close and relaunch the Home Screen app; confirm the expected login/session
      persistence and that an expired session returns to login safely.
- [ ] Reload `/v2?page=notifications`, sign in after session expiry, and confirm
      the same screen resumes without leaking a token into the URL.
- [ ] Enable notifications only through the visible button; confirm reload does
      not show a surprise permission prompt.
- [ ] Exercise permission granted, permission denied, and permission later disabled
      in iPhone Settings; confirm the CRM shows actionable guidance for each state.
- [ ] Send a test notification with the app foregrounded, backgrounded, fully
      terminated, and with the screen locked. Tap it and confirm the correct screen
      is focused/opened.
- [ ] Enable an iOS Focus mode and document delayed/suppressed alert behavior;
      disable Focus and verify normal delivery resumes.
- [ ] Confirm the app icon badge updates when enabled and stays clear when disabled.
- [ ] Confirm message, email, fax, WhatsApp, incoming-call, and missed-call events
      use generic text by default and the same call replaces its existing alert.
- [ ] Trigger separate real inbound SMS, iMessage, WhatsApp, Resend email, Telnyx
      fax, incoming-call, and missed-call events and verify each correct deep link.
- [ ] Let an incoming call go unanswered and confirm the existing cellular fallback
      still rings; the Web Push banner must not offer an answer action.
- [ ] Confirm notification preferences, quiet hours, channel opt-outs, badge, and
      enhanced first-name-only previews behave as configured.
- [ ] Sign in as two users and confirm read/dismiss/clear state is isolated.
- [ ] Subscribe two installed devices for one user and confirm both receive the same
      event once, while disabling one device leaves the other active.
- [ ] Disable a user and confirm queued deliveries are suppressed.
- [ ] Revoke the browser subscription or simulate a 404/410 and confirm the device
      becomes inactive without a retry loop.
- [ ] Use the narrowest supported iPhone width: bottom navigation is reachable,
      modals stay within the viewport, controls are at least 44px, and pipeline
      stages can be changed without drag-and-drop.
- [ ] Confirm the root CRM and `/console` still use their existing manifest and
      service worker.

## Security and privacy notes

- Push endpoints and keys are treated as secrets at rest. Audit logs contain only
  a short SHA-256 endpoint fingerprint.
- Deep links must be same-origin `/v2` paths. Only `page`, `lead`, `event`, `fax`,
  and `call` query parameters survive sanitization.
- Provider-event and source-event unique constraints stop webhook retries from
  creating duplicate notifications.
- A notification receipt never grants record access. The destination route still
  applies the normal authenticated CRM authorization checks.
- There is no offline cache of borrower or CRM data. If offline, the shell reports
  a network failure and data loads only after connectivity returns.

## Rollback

1. Redeploy the previous Render commit. The additive SQLite tables can remain;
   older application code ignores them.
2. To disable sends without reverting, unset either VAPID key and restart. New
   subscriptions and test sends return an unavailable response; CRM activity and
   provider webhooks continue.
3. If a provider verification rollout causes rejects, return only that provider's
   `WEBHOOK_ENFORCE_*` flag to `false` while correcting its signing setup.
4. Keep the Cloudflare `/v2*` route pointing to the last known-good service. No
   root CRM or `/console` route needs to change.

Known operational constraints are a single Render process and one persistent
SQLite database. The outbox safely survives process restarts, but horizontal
multi-region scaling and a true tenant/workspace data model belong to later work.
The new Notification Center starts with events created after this migration; old
global browser-only dismissal state is intentionally not copied.
