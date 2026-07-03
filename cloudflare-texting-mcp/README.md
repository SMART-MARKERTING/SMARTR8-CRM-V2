# Smartr8 Texting + MCP (Cloudflare Workers)

A **net-new** stack that runs **alongside** the Render service and the `smartr8`
Cloudflare Pages app. It does **not** replace anything:

- **Shares the hardware** — the same Telnyx number (`+16197826916`) and the same
  BlueBubbles Mac (via the Cloudflare tunnel URL).
- **Shares the database** — the `smartr8-leads` D1 (`b1be7618-…-9b3782e59b00`), but
  only **adds** tables (`migrations/0001_texting_layer.sql`). It never alters the
  Pages-owned `leads` / `tcpa_consents` tables.
- **Adds a second remote MCP connector** (separate from the GoHighLevel connector) so
  Claude (incl. Cowork) can read threads and reply to mortgage leads — with **all
  TCPA/compliance gates enforced server-side**.

## What's in here

```
src/
  index.ts            OAuthProvider wraps the MCP route; exports the Durable Object
  mcp.ts              McpAgent + the 6 tools (registerTools)
  router.ts           defaultHandler: /authorize UI, inbound webhooks, /health
  env.ts              bindings + secrets
  brand.ts            NMLS #1912347, opt-out line
  util/phone.ts       E.164 normalization (+1 when missing)
  util/tz.ts          US state -> IANA + business-hours gate (8am-9pm ceiling + per-state strict map)
  util/hygiene.ts     GSM-7 sanitize, footer, dedupe normalization
  services/
    telnyx.ts         outbound SMS + inbound webhook parser
    bluebubbles.ts    outbound iMessage (tempGuid) + ping, ported from the Render service
    outbound.ts       iMessage-first -> SMS fallback engine + new-contact capability probe
    inbound.ts        record inbound + honor STOP immediately
    compliance.ts     send_message gate chain + delivery + audit
  webhooks/           telnyx + bluebubbles inbound handlers
  db/repo.ts          all D1 access
migrations/0001_texting_layer.sql
```

## Inbound webhooks

- `POST /webhooks/telnyx` — inbound SMS. Reads `data.payload.from.phone_number` +
  `data.payload.text`, matches the lead by `phone_e164`, writes a `messages` row, and
  inserts into `opt_out` on a STOP keyword.
- `POST /webhooks/bluebubbles` — inbound iMessage (BlueBubbles `new-message` event:
  `data.text`, `data.isFromMe`, `data.handle.address`). Same write path.
- Both can be gated with `?key=<WEBHOOK_SECRET>` (optional secret).

## Outbound engine (iMessage-first, SMS fallback)

Ported from the Render service's router:

1. Try BlueBubbles iMessage (unique `tempGuid`).
2. `success` → done. `524`/timeout/abort → **probably delivered, no fallback**.
3. real `500`/connection error → **silently fall back to Telnyx SMS**.

The **first** send to a brand-new contact doubles as the capability **probe**: a clean
iMessage success tags `contact_texting.imessage_capable = 1`; a hard failure tags it `0`
(sms-only); a timeout/unreachable leaves capability unknown to re-probe later. The
BlueBubbles Private API is **not** required (and is disabled on the Mac).

## Compliance (enforced inside `send_message`)

Runs in order; **every** attempt — including holds/skips — is written to `send_audit`:

1. **Business hours** — timezone resolved from `leads.property_state`. Hard ceiling
   **8am–9pm recipient-local**, intersected with any stricter per-state window in
   `STRICT_WINDOWS` (`util/tz.ts`). Unknown/unmappable state → **held_unknown_timezone**;
   known but outside the window → **held_outside_hours**.
2. **Opt-out** — checks the shared `opt_out` table → **skipped_opted_out**.
3. **Consent** — first touch to a lead needs a `tcpa_consents` row; missing →
   **needs_consent**. Replies inside an existing inbound thread are exempt.
4. **Hygiene** — strips em/en dashes, smart quotes, emoji; forces GSM-7. Empty after
   cleanup → **blocked_hygiene**. Core message > 160 chars is flagged in the reason.
5. **Footer** — ensures `NMLS #1912347`; adds `Reply STOP to opt out.` on the first
   message to a contact.
6. **Dedupe + rate limit** — no near-identical outbound within 12h → **deduped**; daily
   cap (10) → **rate_limited**.
7. **Deliver + audit** → **sent_imessage** / **sent_sms**.

`send_message` returns one of: `sent_imessage`, `sent_sms`, `held_unknown_timezone`,
`held_outside_hours`, `skipped_opted_out`, `needs_consent`, `deduped`, `rate_limited`,
`blocked_hygiene`, `error` — each with a human-readable `reason`. It never sends silently.

> The `opt_out` table is the **single source of truth** for suppression. The GoHighLevel
> connector must check it too.

## MCP tools

| Tool | Purpose |
|------|---------|
| `list_conversations` | Recent threads; filter by `unread_only` / `status`. |
| `get_conversation` | Full message history for a `contactId` (= `lead_id`). |
| `get_contact` | Name, phone, property state, timezone, consent, opt-out, tags, lead status. |
| `list_new_leads` | Recent leads with a phone but no outbound message yet. |
| `send_message` | `contactId` + `body`. All compliance above runs here. |
| `update_contact` | Tags + lead status (writes only to `contact_texting`). |

## Optional: Render console tools (`crm_*`)

When `RENDER_API_BASE` + `RENDER_APP_PASSCODE` are set, the connector ALSO exposes a
family of `crm_*` tools that proxy the Render service's passcode-gated console API — so
Cowork can work the same data you see in `/console` (Leads, Pipeline, To-Do, Contacts,
Messages, Flows, Dialer). If those vars are unset, the tools simply aren't registered.

> Heads-up on data source: the `crm_*` tools operate on the **Render CRM** (its SQLite +
> GHL). The non-`crm_` tools above operate on the **website lead-capture (D1)**. They are
> different lead stores with different ids.
>
> Compliance note: `crm_send_message` uses Render's send path (DNC-checked, iMessage-first)
> — NOT the stricter TCPA engine in the D1 `send_message` (hours/consent/hygiene/footer).

| Tool | Purpose |
|------|---------|
| `crm_list_leads` | Search/list leads; filter by status, stage, pastClient, deleted. |
| `crm_get_lead` | Lead detail: record, DNC status, notes, activity timeline. |
| `crm_pipeline` | Pipeline board: stages + leads. |
| `crm_update_lead` | Set status, move pipeline_stage, owner, past_client. |
| `crm_add_note` | Add a note to a lead's timeline. |
| `crm_set_dnc` | Add/remove a lead on the Do-Not-Contact list. |
| `crm_list_todos` · `crm_add_todo` · `crm_complete_todo` | To-Do tab. |
| `crm_search_contacts` · `crm_get_thread` · `crm_list_conversations` | Contacts + Messages. |
| `crm_send_message` | Send a text via Render (by leadId / contactId / phone). |
| `crm_list_automations` · `crm_automation_activity` · `crm_toggle_automation` · `crm_enroll_lead` | Flows. |
| `crm_click_to_call` | Manual click-to-call (rings you first, then the lead; DNC-checked). |
| `crm_call_queue` | View the automated-call queue (read-only). |

Set on the Worker (dashboard runtime vars or `wrangler secret put`):
- `RENDER_API_BASE` = `https://smartr8-texting-1wx7.onrender.com`
- `RENDER_APP_PASSCODE` = your Render `APP_PASSCODE`

## Property state → timezone (area-code fallback + backfill)

`send_message` resolves the recipient timezone from `leads.property_state`. The
website funnels collect phone but not state, so as a fallback the timezone resolver
derives the state from the **phone's area code** when `property_state` is blank
(`util/areaCodeState.ts`). `get_contact` surfaces this as `state_derived_from_area_code`
so you can see when a tz came from the area code rather than a recorded state.

For existing leads with blank state, a one-time backfill writes `property_state` from
the area code (so it's persisted, not just inferred at send time):

```bash
cd cloudflare-texting-mcp
node scripts/backfill-property-state.mjs          # DRY RUN: summary + writes backfill-property-state.sql
node scripts/backfill-property-state.mjs --apply  # execute the UPDATEs (via your wrangler login)
```

Each UPDATE is guarded (`AND (property_state IS NULL OR property_state='')`), so it's
idempotent and never overwrites a real state. (The smartr8 Pages app fills state at
ingestion going forward, so this is just for the pre-existing rows.)

## Deploy

```bash
cd cloudflare-texting-mcp
npm install

# 1. KV namespace for the OAuth provider — paste the id into wrangler.toml (OAUTH_KV).
npx wrangler kv namespace create OAUTH_KV

# 2. Apply the additive D1 migration (already applied to prod once; safe to re-run).
npx wrangler d1 migrations apply smartr8-leads --remote

# 3. Secrets (never commit these).
npx wrangler secret put TELNYX_API_KEY
npx wrangler secret put TELNYX_MESSAGING_PROFILE_ID
npx wrangler secret put BLUEBUBBLES_URL        # the tunnel URL (can change)
npx wrangler secret put BLUEBUBBLES_PASSWORD
npx wrangler secret put MCP_AUTH_SECRET        # the secret you'll type into Claude
npx wrangler secret put WEBHOOK_SECRET         # optional: gates the inbound webhooks

# 4. Ship it.
npx wrangler deploy
```

`TELNYX_FROM_NUMBER` is a non-secret `[vars]` entry in `wrangler.toml`.

After deploy the Worker is at `https://smartr8-texting-mcp.<your-subdomain>.workers.dev`.

### Point the providers at it

- **Telnyx** messaging profile → Inbound webhook URL:
  `https://<worker>/webhooks/telnyx?key=<WEBHOOK_SECRET>`
- **BlueBubbles** server → add a webhook for `new-message`:
  `https://<worker>/webhooks/bluebubbles?key=<WEBHOOK_SECRET>`

## Add it as a custom connector in Claude

1. In Claude, open **Settings → Connectors** (Pro/Max) or **Organization settings →
   Connectors** (Team/Enterprise). (In Cowork: **Customize → Connectors**.)
2. Click **+ Add custom connector**.
3. **Remote MCP server URL**: `https://smartr8-texting-mcp.<your-subdomain>.workers.dev/mcp`
4. Click **Add**. Claude registers itself (Dynamic Client Registration) and opens the
   **Authorize** page hosted by this Worker.
5. On the Authorize page, enter your **`MCP_AUTH_SECRET`** and submit. Claude completes
   the OAuth handshake and the connector goes live.
6. The six tools above are now available to Claude.

> Auth model: the Worker uses `@cloudflare/workers-oauth-provider` (OAuth 2.1 + Dynamic
> Client Registration — the spec Claude's custom connectors support). The `/authorize`
> step requires `MCP_AUTH_SECRET`, so only someone who knows the secret can mint a token,
> and `/mcp` rejects any request without a provider-issued token.

## Local checks

```bash
npm run typecheck                 # tsc --noEmit
npx wrangler deploy --dry-run --outdir dist
```
