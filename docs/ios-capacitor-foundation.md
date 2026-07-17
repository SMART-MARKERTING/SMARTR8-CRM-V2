# iOS Capacitor Foundation

This is the first Phase 2 mobile-app slice. It adds a native iOS container,
native runtime boundary, APNs token registration APIs, native deep-link
sanitization, badge synchronization hooks, and safe App Store preparation files.
It does not enable provider enforcement, VoIP pushes, PushKit, CallKit, incoming
call answering, background audio, offline CRM data, or any live outbound traffic.

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
- Native links are restricted to approved `/v2/` destinations:
  notifications, conversations/messages, and dialer. External origins, API
  routes, `/console`, fragments, and unapproved query parameters are rejected.
- Badge synchronization uses the durable notification receipt count and the
  existing per-user badge preference.

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
2. Enable Push Notifications and Associated Domains for the bundle identifier in
   Apple Developer. Do not commit certificates, provisioning profiles, APNs keys,
   private keys, or Apple credentials.
3. Create or select an APNs authentication key in Apple Developer and store it in
   Render only after a later APNs sender slice exists. This PR does not need or
   use APNs credentials.
4. Publish the Associated Domains AASA file at
   `https://crm.smartr8.com/.well-known/apple-app-site-association` after the
   Apple Team ID is known.
5. Run `npm run cap:sync`, then build Debug on a real iPhone from Xcode. Confirm
   login, Keychain session restoration, native notification permission prompt,
   APNs token registration, disable, logout revocation, and badge sync.
6. Archive Release and validate signing entitlements. Confirm Release has
   `aps-environment=production`.
7. Create a non-production reviewer account with limited data. Do not include
   real borrower data in App Review notes or screenshots.
8. Complete App Store privacy disclosures for account identifiers, contact
   information, CRM/customer content, diagnostics, and any analytics actually
   enabled in a later release.

## Limitations remaining

- APNs provider sending is not implemented in this slice; native test events are
  queued only.
- Face ID/Touch ID re-entry is documented as the next task. It should gate
  Keychain session release and app resume, then wipe or hide sensitive UI on
  failed re-entry.
- The current `/v2` UI is still a large static HTML file. Extraction into tested,
  bundled assets remains a Phase 2 task.
- No real-device, Xcode build, APNs, TestFlight, or App Store validation is
  complete until the owner performs the checklist above.

## Rollback

Backend changes are additive. To roll back the native slice, deploy the previous
Render commit. The new SQLite tables can remain; older code ignores them. If the
native app is installed during testing, disable notifications in the app or iOS
Settings, then sign out to revoke the native device row. Keep Phase 1 GHL
tombstones and provider safety routes in place.

## Recommended next Phase 2 slice

Implement APNs sending from `native_push_deliveries` with a provider abstraction,
private Render-only APNs credentials, retry/expiry handling, token invalidation,
and mocked tests. Keep PushKit, VoIP APNs, CallKit, and incoming-call handling out
of that slice.
