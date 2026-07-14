# Telnyx Fax

LoanGenius uses the Telnyx Programmable Fax API to send and receive PDF faxes.
The Fax app is available in Control Panel and can be added to Favorites.

## Production settings

- Application name: `LoanGenius Fax`
- Fax number: `+1 888-815-0027`
- Webhook URL: `https://loangenius-v2.onrender.com/api/webhooks/telnyx/fax`
- Webhook failover URL: leave blank until a separate failover service exists
- Webhook timeout: `10` seconds
- AnchorSite: `Latency`
- RTCP capture: Off
- Timezone: `America/Phoenix`
- Customer name: `Adaxa Home`

Assign `+1 888-815-0027` to this Fax API application in the Telnyx Numbers step.
Telnyx uses the same webhook for inbound and outbound fax events.

## Environment variables

```env
TELNYX_API_KEY=<Telnyx API v2 key>
TELNYX_PUBLIC_KEY=<Telnyx webhook Ed25519 public key>
TELNYX_FAX_APPLICATION_ID=<Fax API application ID>
TELNYX_FAX_FROM_NUMBER=+18888150027
PUBLIC_BASE_URL=https://loangenius-v2.onrender.com
```

Keep these values in Render or the deployment platform. Never put them in
frontend code or commit their real values to Git.

## CRM behavior

- Outbound fax numbers must use E.164 format, such as `+16025550100`.
- Users can select an existing borrower PDF or upload a PDF from the Fax app.
- Browser uploads are limited to 10 MB. Received files are limited to 25 MB.
- A borrower upload is stored in that lead's `Fax` file folder before sending.
- Telnyx downloads outbound media through a random 256-bit URL that expires
  after 24 hours. That URL is never returned by the fax list API.
- Incoming faxes are matched to a lead by the sender's normalized phone number.
- A matched fax is saved immediately in the lead's `Fax` folder.
- An unmatched fax remains in the Fax inbox until an admin files it to a lead.
- Fax delivery and receipt events are shown in Fax activity, lead activity,
  notifications, and the audit trail.
- Webhook event IDs are stored so Telnyx retries do not create duplicate files.

## Verification

1. Open `GET /api/webhooks/telnyx/fax`. It should return `configured: true`.
2. Open Control Panel, favorite Fax, and open the Fax app.
3. Confirm the header shows `+1 (888) 815-0027` and `Telnyx fax is configured`.
4. Select a test lead, enter a destination with the dial pad, attach a small
   PDF, and send. The item should progress from queued to delivered or failed.
5. Fax the dedicated number from another service. The received PDF should
   appear in Fax activity and in the matched lead's `Fax` folder.

Telnyx's API expects `connection_id`, `from`, `to`, and a PDF `media_url` for
outbound sends. Successful initiation returns HTTP 202; final delivery is
reported asynchronously through `fax.delivered` or `fax.failed`.
