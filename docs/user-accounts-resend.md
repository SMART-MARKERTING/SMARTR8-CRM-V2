# User accounts and Resend mailboxes

## Account identity

- Admins create users with separate first-name and last-name fields.
- The default username and mailbox are generated as the first initial plus the normalized last name. For example, `Jane De Soto` becomes `jdesoto` and `jdesoto@smartr8.com`.
- Admins can change a user's first name, last name, username, and email from Control Panel > Admin / Sub-Accounts.
- General users see those identity fields as read-only. Every signed-in user can change their own password from Control Panel > Settings.
- Existing accounts keep their current login until an admin deliberately saves a structured identity for them.

## Sender behavior

- Manual email, text, appointment, voicemail follow-up, report, and blast actions use the signed-in user's name and mailbox.
- Automation steps use the assigned lead owner's identity. Unassigned leads fall back to the primary admin/company sender.
- Existing saved templates may use `{{user_first_name}}`, `{{user_last_name}}`, `{{user_name}}`, or `{{user_email}}`. The equivalent `sender_*` tokens are also supported.
- The email composer can switch between the signed-in user's `@smartr8.com` mailbox and the shared addresses listed in `EMAIL_FROM_ALIASES`.

## Required environment configuration

```env
RESEND_API_KEY=...
RESEND_WEBHOOK_SECRET=...
EMAIL_USER_DOMAIN=smartr8.com
EMAIL_FROM=info@smartr8.com
EMAIL_FROM_ALIASES=info@smartr8.com,hello@smartr8.com,MDESHAZO@mykoal.com,info@mykoal.com,hello@mykoal.com
```

Do not place API keys or webhook secrets in browser code. Configure them only in Render or the server environment.

## Resend setup

1. Add and verify `smartr8.com` in Resend. Once a domain is verified, Resend permits sending from any address on that domain; individual user senders do not need to be created one by one.
2. Enable receiving for `smartr8.com` using the MX record displayed by the Resend Domains page. If another mailbox provider already owns the root-domain MX records, use a receiving subdomain or forwarding so the existing mail service is not displaced.
3. Configure an `email.received` webhook to `https://loangenius-v2.onrender.com/api/webhooks/resend`.
4. Put that webhook's signing secret in `RESEND_WEBHOOK_SECRET` and restart the Render service.
5. Send a test email to a generated user mailbox. The CRM routes the inbound message and newly created contact to the user whose email matches the recipient address.

The app does not guess or overwrite DNS records. Always use the exact current values shown in the Resend dashboard.

References:

- https://resend.com/docs/knowledge-base/how-do-I-create-an-email-address-or-sender-in-resend
- https://resend.com/docs/dashboard/receiving/custom-domains
- https://resend.com/docs/webhooks/emails/received
