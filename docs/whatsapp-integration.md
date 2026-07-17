# WhatsApp Integration

LoanGenius supports WhatsApp as a separate communication channel from SMS, email, and calls. Consent is stored separately from SMS consent.

## Environment Variables

Twilio WhatsApp:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_WHATSAPP_FROM`

Meta WhatsApp Cloud API:

- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_VERIFY_TOKEN`
- `WHATSAPP_APP_SECRET`

Optional:

- `WHATSAPP_GRAPH_VERSION`, default `v21.0`
- `WHATSAPP_AI_AUTOSEND_ENABLED`, default `false`

Provider selection:

- If all Twilio variables are present, the CRM sends through Twilio WhatsApp first.
- If Twilio is incomplete and Meta access token plus phone number ID are present, the CRM uses Meta Cloud API.
- Tokens are used only by backend routes and are never exposed to frontend code.

## Webhook URLs

Use the Render v2 service URL unless Cloudflare is proxying the same route:

- Root provider webhook: `https://loangenius-v2.onrender.com/api/webhooks/whatsapp`
- v2-mounted provider webhook: `https://loangenius-v2.onrender.com/v2/api/webhooks/whatsapp`
- If proxied through the CRM domain: `https://crm.smartr8.com/v2/api/webhooks/whatsapp`

Meta webhook verification:

- Callback URL: one of the webhook URLs above.
- Verify token: the exact value of `WHATSAPP_VERIFY_TOKEN`.
- Subscribe to message and status events.

Twilio:

- Configure inbound WhatsApp message and status callback URL to one of the webhook URLs above.
- The app accepts Twilio form callbacks and logs inbound/status updates.

## CRM Fields

The `leads` table includes:

- `whatsapp_phone`
- `whatsapp_opt_in_status`
- `whatsapp_opt_in_source`
- `whatsapp_opt_in_timestamp`
- `whatsapp_last_inbound_at`
- `whatsapp_last_outbound_at`
- `preferred_channel`

The `whatsapp_messages` table logs every inbound, outbound, blocked, and failed WhatsApp attempt.

## Guardrails

- Outbound WhatsApp is blocked unless `whatsapp_opt_in_status` is recorded.
- Free-form WhatsApp text is allowed only inside the 24-hour customer service window after a WhatsApp inbound.
- Outside the 24-hour window, use an approved template.
- AI auto-send is blocked unless `WHATSAPP_AI_AUTOSEND_ENABLED=true`.
- Message copy avoids guaranteed approval language and uses conditional wording such as "check options," "may qualify," and "subject to approval."

## UI

- Open any lead/contact/lead-pool/past-client profile.
- Add WhatsApp phone and opt-in source.
- Use Advanced actions for WhatsApp text, template send, and quote/app link send.
- Conversations includes a WhatsApp compose tab and WhatsApp thread bubbles.
- Admin debug page: `/debug/whatsapp`.

## Phase 1 diagnostics

`/debug/whatsapp` is administrator-only and read-only. It reports redacted
configuration/status metadata without phone numbers, contact IDs, provider
message IDs, or message bodies. The former mutating inbound simulator and live
test-send controls are permanently unavailable.

Use parser/signature fixtures and mocked provider adapters in automated tests.
Do not send a real WhatsApp message until the separately reviewed Phase 2
provider-selection, signature, consent, template, idempotency, and allowlist
work has been merged, deployed, and approved for operator-owned-number QA.

## Common Issues

- `blocked:no-whatsapp-opt-in`: record WhatsApp consent on the lead first.
- `blocked:template-required`: use an approved template or wait for the borrower to message in.
- `failed:not-configured`: finish either the Twilio or Meta environment variable set.
- Meta `403` verification: the provider verify token does not match `WHATSAPP_VERIFY_TOKEN`.
- Resend email inbox is separate; inbound email must use `/api/webhooks/resend`.
