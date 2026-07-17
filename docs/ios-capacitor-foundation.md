# iOS Capacitor Foundation

This document covers the Phase 2 Capacitor/iOS foundation and ordinary native
APNs alert-notification pipeline. It adds a native iOS container, native runtime
boundary, APNs token registration APIs, native deep-link sanitization, native
delivery outbox, APNs provider adapter, badge synchronization hooks, and safe
App Store preparation files. It does not enable provider enforcement, VoIP
pushes, PushKit, CallKit, incoming call answering, background audio, offline CRM
data, or any live SMS/WhatsApp/iMessage/email/fax/telephone traffic.

## Phase terminology

The mobile roadmap uses Phase 2 for the Capacitor App Store app. The emergency
provider guide also mentions later provider/WhatsApp routing work as a future
phase. This repository slice follows the mobile roadmap meaning: Capacitor/iOS
foundation only. Provider production enforcement remains separately gated and all
`WEBHOOK_ENFORCE_*` flags must stay false until a separate approval.

## Architecture decisions

- Capacitor serves versioned local web assets from `mobile/www`; production
  `server.url` is intentionally not configured.
- `npm run mobile:prepare` rebuilds `mobile/www` from the existing `/v2` static
  assets and injects Capacitor runtime scripts only into the native copy.
- The browser PWA remains online-only and keeps its existing Web Push service
  worker, manifest, routes, and subscription lifecycle.
- The native runtime patches API fetches through Capacitor HTTP to the approved
  CRM origin, attaches a native runtime header, and reads the server session token
  from iOS Keychain.
- Browser/PWA login remains cookie-only. Native login receives the opaque session
  token only when the request includes `x-smart-r8-native: ios`, then stores it
  via the Keychain plugin.
- APNs device tokens are stored in `native_push_devices`, separate from
  `push_subscriptions`. Native delivery queue rows are stored in
  `native_push_deliveries`, separate from the Web Push outbox.
- Native APNs alerts are delivered by a native-only worker. It atomically claims
  due `native_push_deliveries`, sends through APNs token authentication, retries
  transient failures with bounded exponential backoff, recovers stale claims, and
  revokes devices when APNs reports bad, expired, or unregistered tokens.
- APNs sandbox and production routing is selected by `APNS_ENVIRONMENT`.
  `production` and `sandbox` force one endpoint; `auto` routes development
  device rows to sandbox and production rows to production.
- Native APNs payloads are generic by default and do not include message bodies,
  email bodies, fax filenames, borrower information, loan data, phone numbers,
  credentials, documents, provider response bodies, or device tokens.
- Native links are restricted to approved `/v2/` destinations:
  notifications, conversations/messages, and dialer. External origins, API
  routes, `/console`, fragments, and unapproved query parameters are rejected.
- Badge synchronization uses the durable notification receipt count and the
  existing per-user badge preference.
- Native notification taps record an opened receipt through the authenticated
  session. iOS notification dismissal receipts are not available from the
  current Capacitor Push Notifications listener and need a later native
  extension if product requires lock-screen dismiss tracking.

## Native API additions

All endpoints require the existing authenticated CRM session. Ownership is
derived from the server session; callers cannot register or revoke another user's
device.

| Method and path | Purpose |
|---|---|
| `GET /api/native/push/status` | Return active/disabled native device state for the signed-in user. |
| `POST /api/native/push/register` | Register or refresh this user's iOS APNs token for one native device id. |
| `POST /api/native/push/disable` | Disable this user's current native device without touching Web Push. |
| `POST /api/native/push/logout` | Revoke this user's current native device for sign-out flows. |
| `POST /api/native/push/test` | Queue a generic native notification event without sending APNs traffic. |
| `GET /api/native/badge` | Return the per-user badge count to apply natively. |
| `POST /api/native/deep-link/resolve` | Validate and normalize a native deep link. |

The same routes are also mounted under `/v2`.

## APNs Render variables

Set these only in Render or another private secret manager. Do not commit, print,
or paste real values into GitHub issues, PRs, docs, screenshots, or chat.

| Variable | Required | Notes |
|---|---:|---|
| `APNS_KEY_ID` | Yes for native APNs | Apple Developer APNs authentication key id. |
| `APNS_TEAM_ID` | Yes for native APNs | Apple Developer team id that owns the app id. |
| `APNS_TOPIC` | Yes for native APNs | Bundle identifier/APNs topic, for example the app's bundle id. |
| `APNS_PRIVATE_KEY` | Yes for native APNs | APNs `.p8` private key PEM. Use escaped `\n` or Render multiline secret support. |
| `APNS_ENVIRONMENT` | Yes for native APNs | `production`, `sandbox`, or `auto`; default is `production`. |
| `NATIVE_NOTIFICATION_WORKER_POLL_MS` | No | Native APNs worker poll period; default follows `NOTIFICATION_WORKER_POLL_MS` or 5000 ms. |
| `APNS_EXPIRATION_SECONDS` | No | Alert TTL, bounded from 60 seconds to 24 hours; default 600 seconds. |

The native worker does not start unless APNs credentials validate locally. Missing
or malformed credentials leave native deliveries pending rather than draining the
outbox. Web Push continues to use only the `WEB_PUSH_*` variables and is not sent
through APNs.

## iOS project files

- `capacitor.config.json` defines the local `mobile/www` webDir and native plugin
  configuration. It has no `server.url`.
- `ios/App/App/App.entitlements` declares APNs and associated domains using build
  settings. Debug uses `APS_ENVIRONMENT=development`; Release uses
  `APS_ENVIRONMENT=production`.
- `ios/App/App/PrivacyInfo.xcprivacy` is intentionally minimal and contains no
  tracking declarations.
- `ios/App/App/Info.plist` defines the `smartr8crm://` URL scheme for native link
  opens. Universal Links still require Apple Team ID and the hosted AASA file.

## Native delivery behavior

- APNs requests use token-based authentication with ES256 JWTs derived from
  `APNS_KEY_ID`, `APNS_TEAM_ID`, and `APNS_PRIVATE_KEY`.
- Headers include `apns-topic`, `apns-push-type=alert`, `apns-priority=10`,
  `apns-expiration`, `apns-collapse-id`, and deterministic `apns-id` values from
  the delivery row id.
- APNs response handling is category-based. Successful sends mark delivery rows
  delivered. Bad or unregistered device tokens revoke that native device and mark
  pending rows for it expired. Throttling, 5xx responses, and network failures
  retry with bounded backoff. Authentication/configuration failures are retried
  up to the permanent failure limit and then marked `configuration_error`.
- Logs and stored response fields keep only safe status categories/reasons. They
  must not contain APNs authorization data, raw device tokens, payload contents,
  contact data, provider response bodies, or private Apple key material.
- Incoming-call and missed-call notifications are ordinary alerts only. They open
  the existing `/v2` dialer destination; they do not answer calls and do not use
  PushKit, VoIP APNs, CallKit, background audio, or native Telnyx calling.

## Local validation commands

Use Node 22:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm audit --omit=dev
npm run cap:sync
npm run cap:doctor
```

If the Cloudflare worker changes in a future slice, validate it separately with:

```bash
cd cloudflare-texting-mcp
npm ci
npm run build
npm audit --omit=dev
```

## Owner checklist before TestFlight

1. Install full Xcode, open `ios/App/App.xcodeproj`, and select the Apple
   Developer team that owns `com.smartr8.crm`.
2. In Apple Developer, create/confirm the App ID for the exact bundle identifier
   and enable Push Notifications. Enable Associated Domains only after the AASA
   file can be hosted.
3. Create or select an APNs authentication key. Record only the key id and team
   id in the secure owner runbook; store the `.p8` private key only in Render.
4. Publish the Associated Domains AASA file at
   `https://crm.smartr8.com/.well-known/apple-app-site-association` after the
   Apple Team ID is known.
5. In Render, set `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC`,
   `APNS_PRIVATE_KEY`, and `APNS_ENVIRONMENT`. Do not change any
   `WEBHOOK_ENFORCE_*` flag while doing this.
6. Run `npm run cap:sync`, then build Debug on a real iPhone from Xcode. Confirm
   login, Keychain session restoration, native notification permission prompt,
   APNs token registration/rotation, app relaunch refresh, account switching,
   disable, logout revocation, account-disable revocation, badge sync, foreground
   receipt, background receipt, terminated-app tap, and login-expired resume.
7. Confirm APNs sandbox routing for Debug builds if `APNS_ENVIRONMENT=sandbox` or
   `auto`, and production routing for TestFlight/Release builds.
8. Archive Release and validate signing entitlements. Confirm Release has
   `aps-environment=production`.
9. Prepare TestFlight with a non-production reviewer account and limited fixture
   data. Do not include real borrower data in App Review notes or screenshots.
10. Complete App Store privacy disclosures for account identifiers, contact
    information, CRM/customer content, diagnostics, and any analytics actually
    enabled in a later release.
11. For credential rotation, create a new APNs key, update Render variables,
    redeploy, confirm test delivery on a real iPhone, then revoke the old key in
    Apple Developer.

## Limitations remaining

- Face ID/Touch ID re-entry is documented as the next task. It should gate
  Keychain session release and app resume, then wipe or hide sensitive UI on
  failed re-entry.
- The current `/v2` UI is still a large static HTML file. Extraction into tested,
  bundled assets remains a Phase 2 task.
- No real-device, Xcode build, APNs, TestFlight, or App Store validation is
  complete until the owner performs the checklist above.
- iOS notification dismissal receipts are not captured by the current JavaScript
  Push Notifications lifecycle.

## Rollback

Backend changes are additive. To roll back the native APNs slice, deploy the
previous Render commit or unset the `APNS_*` variables and restart so the native
worker does not start. The native SQLite tables can remain; older code ignores
them. If the native app is installed during testing, disable notifications in the
app or iOS Settings, then sign out to revoke the native device row. Keep Phase 1
GHL tombstones and provider safety routes in place.

## Recommended next Phase 2 slice

Add Face ID/Touch ID re-entry and app-switcher privacy for the Keychain-backed
native session, with explicit tests for account switching and failed biometric
unlock. Keep PushKit, VoIP APNs, CallKit, and incoming-call handling out of that
slice.
