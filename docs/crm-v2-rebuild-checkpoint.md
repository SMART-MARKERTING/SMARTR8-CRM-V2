# CRM V2 rebuild checkpoint

Status: local preview branch only. No production deployment or remote push has been performed.

Branch: `codex/crm-v2-rebuild-preview`

## Visual direction

The responsive LoanGenius shell uses the supplied mobile CRM screenshots as an interaction reference while retaining original LoanGenius branding and mortgage workflows.

- Mobile bottom navigation: Home, Conversations, Search, Calendar, Apps
- Floating quick-add action for contacts, calls, messages, and appointments
- Card-based Home metrics, pinned apps, and quick actions
- Grouped Apps directory
- Desktop two-pane and mobile drill-in conversation views
- Searchable Opportunities kanban with visually distinct columns
- Task metrics plus overdue, today, upcoming, and unscheduled filters
- Mobile-optimized monthly calendar
- Single non-duplicated desktop navigation model

## Security and workflow repairs

- Session authentication moved to an HttpOnly, SameSite cookie.
- Session and passcode credentials are no longer accepted in query strings or request bodies.
- Render deploy diagnostics and redeploy actions require an administrator; redeploy is POST-only.
- DNC, click-to-call, automated calls, call queue, and voice diagnostics require authentication.
- Telnyx voice webhooks fail closed when the signing public key is missing.
- Bulk SMS, email, and delete actions enforce sub-account lead ownership.
- SMS marketing eligibility defaults to no consent.
- Historical consent flags without timestamps are removed by a versioned migration.
- Manual SMS consent requires method, source, disclosure version, notes, and authenticated author.
- Duplicate website submissions update the existing lead without restarting active campaigns.
- Password minimum increased to 12 characters for new and changed passwords.

## Integration changes required before release

- The website lead worker must send `LEAD_WEBHOOK_SECRET` through the `x-lead-secret` header. Query-string and body secrets are rejected.
- Legacy CRM sync must use `x-crm-sync-secret` or `x-legacy-sync-secret`.
- `TELNYX_PUBLIC_KEY` must be configured before Telnyx voice webhooks will be accepted.

## Deployment controls

- Render automatic deployment is disabled in the blueprint.
- Builds use `npm ci` for lockfile-reproducible installs.
- The health endpoint checks SQLite and reports HTTP 503 when the database is unavailable.
- Production promotion remains blocked until authenticated preview QA and owner approval.

## Verification

- Inline JavaScript parsing: passed for `public/v2.html` and `public/console.html`.
- TypeScript type-check: passed.
- TypeScript build: passed.
- Test runner: 29 passed, including the new consent tests. Fourteen database-dependent tests could not execute because this workspace runs Node 24 while the project and native `better-sqlite3` binding require Node 22. Re-run the complete suite in the Node 22 preview environment.
