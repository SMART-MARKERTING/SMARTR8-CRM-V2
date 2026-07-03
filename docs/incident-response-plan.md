# Incident Response Plan

This plan is intentionally small and practical. Use it when something could affect customer data, lead data, messaging integrity, credentials, payments, or service availability.

## What Counts As An Incident

- A suspected or confirmed exposed secret, API key, OAuth token, webhook secret, or admin credential.
- Unauthorized access to the CRM console, admin routes, Cloudflare, Render, GitHub, GoHighLevel, Telnyx, BlueBubbles, email, or databases.
- Messages sent to the wrong recipient, sent after opt-out, or sent outside approved compliance rules.
- Public exposure of borrower, lead, call, message, or document data.
- Malware, dependency compromise, suspicious deployment, or unknown code change.
- Loss, corruption, or unauthorized export of business-critical data.
- Material outage affecting lead capture, opt-out processing, or customer communications.

## Response Owner

The business owner or appointed technical lead owns incident response. If vendors are involved, assign one person to coordinate GitHub, Render, Cloudflare, GoHighLevel, Telnyx, BlueBubbles, and email support.

## Immediate Containment

1. Preserve evidence before changing systems when possible: screenshots, timestamps, request IDs, commit SHAs, logs, affected accounts, and alert links.
2. Disable or restrict affected user accounts, API keys, webhook endpoints, or integrations.
3. Pause outbound SMS/email campaigns if consent, DNC, routing, or message integrity may be affected.
4. Disable compromised deploy hooks or roll back to a known-good deployment if needed.
5. Block abusive IPs or routes at Cloudflare/Render only after preserving enough evidence to understand scope.

## Credential Rotation

1. Identify every system touched by the exposed or suspicious credential.
2. Create a replacement secret in the owning system.
3. Update GitHub Actions secrets, Render environment variables, Cloudflare Worker secrets, and any vendor dashboards that use it.
4. Redeploy affected services.
5. Revoke the old credential after the replacement is live.
6. Confirm logs no longer show use of the old credential.

## Notification Review

Review whether customer, vendor, regulator, or partner notification is required. Consider the type of data involved, number of affected people, whether data was viewed or exported, and applicable contract or legal obligations. Get legal advice before making formal breach claims.

## Vendor Notification Review

Notify vendors when their systems, credentials, or logs may help contain or investigate the incident. Likely vendors include GitHub, Render, Cloudflare, GoHighLevel, Telnyx, BlueBubbles, email providers, and analytics providers.

## Evidence Preservation

- Keep copies of relevant logs and alerts.
- Save affected commit SHAs, deployment IDs, workflow runs, and audit-log entries.
- Do not overwrite local token stores or database files until a backup copy is made.
- Record who took each containment action and when.

## Post-Incident Review

Within one week, document what happened, root cause, affected data, customer impact, actions taken, and what will change. Add follow-up tasks for monitoring, tests, documentation, dependency updates, access review, or architecture changes.
