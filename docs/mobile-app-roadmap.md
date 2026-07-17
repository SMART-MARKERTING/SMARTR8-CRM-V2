# Mobile App Roadmap

This roadmap preserves the Phase 1 implementation boundary: an installable
online PWA at `/v2`, standards-based Web Push, and mobile usability improvements.
Phase 1 does not claim native telephony, background execution beyond browser push,
offline CRM data, App Store distribution, or device-level biometric protection.

## Phase 1: installable PWA and Web Push

Delivered in the current repository:

- `/v2` manifest, iPhone icons, standalone presentation, isolated service worker,
  safe-area layout, reachable bottom navigation, and non-drag pipeline controls.
- Explicit opt-in Web Push, per-device subscription lifecycle, VAPID delivery,
  retry/expiry handling, and per-user notification preferences and receipts.
- Notifications for inbound SMS, iMessage, email, fax, WhatsApp, incoming calls,
  and missed calls after verified source persistence.
- Generic-by-default previews, safe deep links, provider deduplication, and no
  offline caching of CRM or borrower data.

Success means the team can install the CRM from Safari, receive a generic alert,
tap it to the right authorized screen, and perform common CRM work at iPhone width.

## Phase 2: Capacitor App Store app

Package a native iOS app with Capacitor only after Phase 1 production telemetry
confirms the mobile workflows. The package must ship versioned local web assets;
it must not point a production `server.url` at the hosted CRM, because that would
be a thin remote website wrapper and would weaken release integrity.

First foundation slice:

- Add Capacitor/iOS project structure that builds local `/v2` assets through a
  reproducible `mobile:prepare` step and keeps the browser PWA unchanged.
- Establish native runtime detection, Keychain-backed session storage, APNs token
  registration APIs, separate native token/outbox tables, safe native deep-link
  handling, and badge synchronization hooks.
- Keep APNs provider sending, Face ID/Touch ID re-entry, full asset extraction,
  TestFlight signing, and real-device validation as follow-up tasks.

Second native alert slice:

- Deliver ordinary native APNs alerts from `native_push_deliveries` through a
  Render-configured APNs token-auth provider adapter.
- Keep APNs delivery separate from Web Push and keep payloads generic by default,
  with allowlisted `/v2` deep links, collapse IDs, badge counts, invalid-token
  revocation, bounded retries, stale-claim recovery, and privacy-safe logs.
- Keep PushKit, VoIP APNs tokens, CallKit, native Telnyx calling, and background
  call audio out of this slice.
- Leave Face ID/Touch ID re-entry, asset extraction, TestFlight signing, and
  real-device validation as follow-up tasks.

Planned capabilities:

- Extract the large inline V2 HTML, CSS, and JavaScript into tested, versioned,
  bundled assets with a reproducible native build pipeline.
- Apple Developer enrollment, bundle identifiers, signing, provisioning profiles,
  TestFlight, production release ownership, and rollback procedures.
- Ordinary native notifications through APNs directly or FCM as a transport, with
  per-user device tokens, token rotation, logout revocation, app badges, and deep
  links/Universal Links. These are ordinary CRM alerts, not VoIP pushes.
- Keychain-based session storage, server-side session revocation, Face ID/Touch ID
  re-entry, app-switcher privacy treatment, and secure sign-out wipe.
- Native document scanning/upload with explicit permission UX, temporary-file
  cleanup, file-type/size validation, and no camera-roll retention by default.
- Secure PDF sharing through the iOS share sheet using short-lived authorized files,
  protected-data APIs, and cleanup when sharing finishes.
- Offline drafts and an idempotent retry queue for low-risk user-authored changes;
  no broad CRM/borrower cache until separately reviewed.
- Accessibility, device-size testing, crash reporting, privacy-safe telemetry, and
  native network/offline status.
- A substantive native experience that satisfies Apple App Review Guideline 4.2,
  rather than merely repackaging the website.
- App Store privacy disclosures, data-use inventory, support/privacy URLs, export
  compliance answers, review notes, and a non-production reviewer demo account.

Exit criteria include a reproducible signed build, TestFlight testing on the
supported iOS matrix, verified notification/token lifecycle, Face ID and Keychain
threat-model review, document/PDF data-cleanup tests, and App Review readiness.

## Phase 3: native incoming calling

Add true background incoming calling only after the Capacitor identity/device
foundation is stable. This phase is intentionally separate because Apple treats
VoIP pushes and call UI differently from ordinary CRM notifications.

Planned capabilities:

- Integrate the Telnyx native iOS SDK for media, registration, and call control.
- Issue a separate per-device VoIP APNs token; never reuse an ordinary APNs or Web
  Push subscription for call invitations.
- Receive legitimate incoming VoIP invitations with PushKit and immediately report
  them to CallKit within Apple's timing and lifecycle requirements.
- Implement CallKit answer, decline, mute, audio route, hold where supported,
  hangup, outgoing-call, and missed-call reconciliation.
- Build a custom Capacitor Swift plugin for Telnyx/PushKit/CallKit, or formally
  evaluate React Native if the Capacitor bridge cannot meet call-timing and audio
  requirements.
- Provision short-lived, per-user Telnyx credentials rather than sharing a browser
  softphone credential across users.
- Add explicit per-user phone-number and team routing so the server knows which
  authenticated devices may receive each call.
- Persist durable call-invitation and call-leg state with idempotent provider events,
  reconciliation after reconnect, and clear ownership/audit history.
- Configure background audio correctly and test interruptions, Bluetooth, speaker,
  cellular handoff, lock screen, app termination, weak networks, and recovery on
  real devices—not only the simulator.
- Maintain strict server, token, payload, topic, and code-path separation between
  ordinary CRM alerts and VoIP pushes. PushKit must never carry generic CRM alerts.
- Preserve the current Telnyx app-then-cell fallback until native reliability and
  operational monitoring meet an explicit cutover threshold.

Exit criteria include reliable real-device calls through foreground, background,
lock-screen, and terminated states; verified fallback; PushKit/CallKit compliance;
carrier/legal review; and an emergency switch that disables native invitations
without disabling cellular forwarding.

Offline expansion beyond Phase 2 drafts remains privacy-gated future work: it needs
field allowlists, encrypted local storage, tenant/workspace isolation, conflict
resolution, retention, remote wipe, and security approval before implementation.

## Decisions required before Phase 2 or 3

- Confirm which call paths require true native answer capability versus an alert
  that opens the existing CRM.
- Decide ownership and operating procedures for Apple accounts, certificates,
  APNs keys, App Store releases, and incident response.
- Define the canonical tenant/workspace model before any multi-tenant or offline
  replication work.
- Approve data classification, local-retention limits, mobile analytics, and
  regulated-data handling with security and compliance stakeholders.
- Establish supported iPhone/iOS versions and a representative device test matrix.
