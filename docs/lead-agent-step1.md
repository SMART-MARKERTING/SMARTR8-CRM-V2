# LoanGenius Lead Agent — Step 1 Foundation

Step 1 adds an auditable lead-intelligence layer to the existing CRM. It reuses the current lead intake, categorization, exact phone/email deduplication, users, tasks, and activity timeline rather than creating a second system of record.

## Safety contract

The default configuration is disabled and recommendation-only. In Step 1 the agent:

- never sends email, SMS, iMessage, or WhatsApp;
- never places a call or enrolls a lead in an automation;
- never quotes a rate, payment, approval probability, or lending term;
- never approves or denies credit;
- never receives SSN, DOB, income, asset, document, phone, email, or full-address data in its AI prompt;
- always marks its output as requiring human review;
- records each run, recommendation, duplicate warning, routing recommendation, error, and applied safe action.

## Configuration

```env
LEAD_AGENT_ENABLED=false
LEAD_AGENT_MODE=recommend
LEAD_AGENT_APPLY_SAFE_ACTIONS=false
LEAD_AGENT_CREATE_TASKS=false
LEAD_AGENT_PROVIDER=openai
LEAD_AGENT_MODEL=gpt-4o-mini
LEAD_AGENT_ROUTING_RULES_JSON=[]
```

`apply_safe` is accepted only when both `LEAD_AGENT_MODE=apply_safe` and `LEAD_AGENT_APPLY_SAFE_ACTIONS=true`. The only Step 1 safe actions are assigning an unassigned lead to the recommended active CRM user and, when separately enabled, creating one idempotent human-review task.

Routing rules are evaluated in order. Each rule may match `state`, `category`, and/or `source`, and `owner` may be a CRM user ID, username, or display name.

```json
[
  { "state": "AZ", "category": "HELOC", "owner": "mykoal" },
  { "source": "facebook", "owner": "facebook-team" }
]
```

## Operator API

- `GET /v2/api/agent/status` — safe configuration/status view; never returns API keys.
- `POST /v2/api/leads/:id/agent/analyze` — run an analysis for a lead the current operator can access.
- `GET /v2/api/leads/:id/agent/runs` — list the auditable recommendation history.

Website submissions trigger a background run only when `LEAD_AGENT_ENABLED=true`. Provider failure falls back to the deterministic rules engine so intake is never blocked.

## Enabling sequence

1. Deploy with the defaults above and verify the application and database migration.
2. Add routing rules and an OpenAI API key in the host secret manager.
3. Set `LEAD_AGENT_ENABLED=true` while keeping `LEAD_AGENT_MODE=recommend`.
4. Review at least 25 representative leads and confirm duplicate, priority, routing, and consent warnings.
5. Only after approval, consider `apply_safe`; keep consumer contact and lending decisions outside the agent.
