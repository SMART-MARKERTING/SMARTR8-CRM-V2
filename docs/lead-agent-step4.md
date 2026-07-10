# Lead agent Step 4: call-center handoff

Step 4 connects Telnyx call summaries to deterministic, auditable follow-up recommendations.

## Behavior

- Classifies explicit outcomes such as callback requested, documents requested, no answer, wrong number, not interested, compliance review, and do-not-contact.
- Produces a priority, next human action, due time, reasons, and consent-aware permitted channels.
- Blocks all autonomous calls, email, SMS, rate/payment quotes, and credit decisions.
- Creates a review task only when call-summary task creation is enabled.
- Logs the recommendation to the lead timeline and stores it separately from the AI-generated source summary.
- Shows the latest post-call recommendation inside the lead's **Lead Intelligence** card.

## Safety rules

- An explicit opt-out or do-not-contact statement suppresses every suggested outreach channel.
- SMS is never listed without recorded express SMS consent.
- Email is never listed for an unsubscribed lead and requires recorded contact consent.
- Phone remains a manual review channel; the system does not place a follow-up call.
- Compliance flags take precedence over routine callback recommendations.

## API

- `GET /api/leads/:id/call-summaries?limit=5` returns accessible call summaries with `follow_up_recommendation`.
- Existing `GET /api/call-summaries` and retry endpoints remain backward compatible.
