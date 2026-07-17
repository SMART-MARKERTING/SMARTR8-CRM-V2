# Smartr8 Texting — GHL Conversation Provider

Standalone v2 CRM service for `crm.smartr8.com/v2`. This repo is split from
`SMART-MARKERTING/Smartr8-texting`, which remains the root `crm.smartr8.com` app.

## Application boundary

- This repository owns the CRM experience at `crm.smartr8.com/v2`, including the
  dashboard, conversations, appointments, campaigns, reputation, file storage,
  settings, and the CRM-facing social-planner entry point.
- `studio.smartr8.com` remains the standalone Content Studio and owns content
  generation, hashtag groups, post locations, social connections, scheduling,
  and publishing workflows.
- CRM links to Content Studio in a separate browser tab. It must not embed Studio,
  copy Studio publishing state into the browser, or replace Studio's interface.
- Authentication, records, provider integrations, and existing API contracts stay
  server-side and independent of this presentation boundary.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/SMART-MARKERTING/LOANGENIUS)

Open `/v2/` after deploy. The same backend is also mounted under `/v2/api`, `/v2/calls`,
`/v2/webrtc`, and related prefixed paths so Cloudflare can route only `/v2*` to this
service without leaking v2 calls to the root CRM repo.

## Installable `/v2` app and Web Push

Phase 1 makes the V2 CRM installable from iPhone Safari and adds authenticated,
per-user Web Push for inbound messages, email, fax, WhatsApp, incoming calls, and
missed calls. The service worker is isolated to `/v2/` and intentionally does not
cache authenticated CRM or borrower data.

Generate a VAPID pair once, then store both values in Render:

```bash
npx web-push generate-vapid-keys --json
```

Set `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`, and
`WEB_PUSH_CONTACT`. On iOS/iPadOS 16.4 or later, open `/v2/` in Safari, use
**Share > Add to Home Screen**, launch the icon, then use the explicit **Enable
Notifications** button in CRM Settings. A Web Push call alert can open the CRM;
it is not CallKit and cannot answer a Telnyx call from the lock screen.

See [Phase 1 PWA and Web Push](docs/pwa-web-push.md) for deployment variables,
API endpoints, provider-signature rollout, iPhone testing, security, and rollback.
See [Mobile App Roadmap](docs/mobile-app-roadmap.md) for native iOS/APNs/CallKit
and privacy-gated offline phases.

A small Node/TypeScript service that lets you text from inside **GoHighLevel** and
routes each message to the right channel:

- **iMessage** (via a self-hosted **BlueBubbles** server) when the contact has the `imessage` tag
- **SMS** (via **Telnyx**) otherwise
- **Inbound** SMS and iMessage are logged back into the GHL conversation

It registers as a **GHL custom conversation provider**, so the GHL "send" button
replaces the n8n form as your front door — while the routing logic lives here in code.

> New here? Read `CLAUDE.md` (project brief), `docs/architecture.md` (endpoints + gotchas),
> and `docs/telnyx-call-summary-mvp.md` for post-call AI summaries.

---

## What's in the box

```
src/
  index.ts                 Express bootstrap, /health, route mounting
  config.ts                env config (+ missing-var report)
  store/tokenStore.ts      GHL OAuth tokens: exchange, persist, auto-refresh
  services/ghl.ts          GHL API: upsert, getContact, log inbound, status callback
  services/telnyx.ts       SMS send
  services/bluebubbles.ts  iMessage send (+ 524 "likely-sent" handling) + ping
  services/router.ts       channel choice (imessage tag) + send
  routes/oauth.ts          /oauth/install, /oauth/callback
  routes/provider.ts       /providers/ghl/messages  (retired: deterministic 410)
  routes/webhooks.ts       /webhooks/telnyx, /webhooks/bluebubbles  (inbound)
render.yaml                Render blueprint
```

### Endpoints (after deploy, `BASE` = your service URL)

| Purpose | URL |
|---|---|
| Health | `GET BASE/health` |
| OAuth install (visit once) | `GET BASE/oauth/install` |
| OAuth redirect | `GET BASE/oauth/callback` |
| Retired GHL outbound Delivery URL | `POST BASE/providers/ghl/messages` (always 410; do not configure) |
| Telnyx inbound webhook | `POST BASE/webhooks/telnyx` |
| BlueBubbles inbound webhook | `POST BASE/webhooks/bluebubbles` |

---

## Local run

```bash
npm install
cp .env.example .env      # fill in values
npm run dev               # or: npm run build && npm start
curl localhost:3000/health
```

## Deploy (Render)

1. Push this repo to GitHub (already on `mdeshazo/smartr8-texting`).
2. Render → **New → Blueprint** → pick this repo (`render.yaml` is detected).
3. Set the `sync: false` secrets in the Environment tab (everything in `.env.example`).
4. Note the service URL — that's `BASE` above.

**Railway alternative:** New Project → Deploy from repo. Build `npm run build`,
start `npm start`. Add a **volume** mounted at `/data` and set `TOKEN_DIR=/data`
so OAuth tokens persist across restarts.

## Connect GoHighLevel (one-time)

1. **marketplace.gohighlevel.com** → create a **private/unpublished** app (no review needed).
2. **Auth** → add scopes: `contacts.readonly/write`, `conversations.readonly/write`,
   `conversations/message.readonly/write`. Redirect URL = `BASE/oauth/callback`.
   Copy **Client ID** + **Client Secret** into your env.
3. The historical GHL Conversation Provider delivery bridge is retired. Remove
   `BASE/providers/ghl/messages` from GHL; do not configure a replacement until
   a verified provider contract is designed and reviewed.
4. Install: open `BASE/oauth/install` in a browser, pick your sub-account, Allow.
   Tokens are saved and auto-refresh from then on.
5. Point **Telnyx** messaging-profile inbound webhook → `BASE/webhooks/telnyx`.
6. Point **BlueBubbles** webhook ("New Messages") → `BASE/webhooks/bluebubbles`.

---

## ⚠️ Before production — read these

- **Rotate the two exposed secrets** (GHL PIT, BlueBubbles password). Never commit them.
- Validate provider payloads with redacted dashboard metadata and mocked fixtures.
  Never enable raw provider-payload logging or use a live message to discover a
  callback shape. See `docs/emergency-provider-lockdown.md`.
- **iMessage sending is best-effort** without the BlueBubbles Private API (= SIP off).
  Fine for 1:1; route bulk through Telnyx SMS (the router already does this by tag).
- **Token persistence:** the file store needs a persistent disk (the Render blueprint
  mounts one at `/data`). On ephemeral hosting, tokens would vanish on restart —
  swap `store/tokenStore.ts` for a DB/Redis if needed.
- BlueBubbles needs an **always-on Mac** + ideally a **named Cloudflare tunnel**
  (fixed URL) so `BLUEBUBBLES_URL` doesn't change on restart.
