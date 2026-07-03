# Security Checklist

This is a lean baseline for a small-business beta. It helps create a defensible routine, but it is not a compliance certification or a replacement for a formal security program.

## Pre-Launch Checks

- [ ] MFA is enabled for GitHub, Render, Cloudflare, GoHighLevel, Telnyx, BlueBubbles, email, and any admin accounts.
- [ ] No API keys, OAuth client secrets, database credentials, webhook secrets, JWT secrets, or service tokens are shipped to frontend JavaScript.
- [ ] HTTPS is enforced for all public URLs.
- [ ] Production databases, D1 bindings, local SQLite volumes, and token storage are not publicly reachable.
- [ ] Admin-only routes are protected with role checks.
- [ ] Standard users can access only leads and actions they are allowed to see.
- [ ] Tenant or sub-account separation is tested before adding real client accounts.
- [ ] Auth, admin changes, lead changes, SMS consent changes, DNC changes, and exports create an audit trail.
- [ ] SMS opt-out and DNC suppression are tested before any outbound campaign.
- [ ] Backups exist for business-critical data and token storage.
- [ ] Password reset or admin credential recovery has an owner-approved process.
- [ ] File uploads are authenticated, size-limited, type-checked, and stored outside executable paths.
- [ ] Dependabot is enabled and producing dependency PRs.
- [ ] CodeQL is enabled and passing on pull requests.
- [ ] OWASP ZAP baseline has been run against staging or preview.
- [ ] Security headers are present on the public app and reviewed after every major frontend change.

## Monthly Checks

- [ ] Review Dependabot alerts and merge safe patch/minor updates.
- [ ] Review CodeQL alerts and close only with a clear reason.
- [ ] Review access logs for unusual admin, webhook, export, and login activity.
- [ ] Review the current admin user list and remove stale accounts.
- [ ] Test restoring from backups or confirm the latest restore test date.
- [ ] Run OWASP ZAP baseline against the public staging or preview URL.
- [ ] Review SMS opt-outs, DNC entries, and suppression behavior.
- [ ] Review failed login patterns and rate-limit events.
- [ ] Rotate any shared break-glass passcodes after staffing or vendor changes.
- [ ] Confirm GitHub branch protection and required checks still match the deployment branch.

## Repository Notes

- Main service: Node.js, Express, TypeScript, npm, deployed from `render.yaml`.
- Worker package: Cloudflare Workers, D1, KV, Durable Objects, npm, configured in `cloudflare-texting-mcp/wrangler.toml`.
- Environment variables are loaded from platform configuration and `.env` files for local development. Keep real values out of Git.
- Public lead intake and webhook routes rely on shared secrets. Treat those URLs as sensitive when they include a `key` query parameter.
