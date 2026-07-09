# SmartR8 / LoanGenius Phase 0 Preview Report

Date: 2026-07-09
Branch: `codex/system-overhaul-preview`

## Scope Completed In This Pass

- Created safe preview branches for CRM V2, CRM V1, website, and call center repos.
- Mapped active deploy targets without changing production config:
  - CRM V2: `SMART-MARKERTING/LOANGENIUS`, Render service `loangenius-v2`, mounted at `/v2`.
  - CRM V1: `SMART-MARKERTING/Smartr8-texting`, Render service `smartr8-texting`.
  - Website: `SMART-MARKERTING/SMARTR8-WEBSITE`, Cloudflare Pages/Workers app under `artifacts/smartr8`.
  - Call center: `SMART-MARKERTING/CALLCENTER-SMARTR8`, Render service `oo-power-dialer`.
- Replaced the website's null route-loading fallback with a branded loading shell so lazy routes do not render blank while loading.
- Added an automated SMS eligibility gate in CRM V1 and V2 that requires:
  - a phone number,
  - no active DNC suppression,
  - `sms_consent` enabled,
  - and a timestamped `consent_at` record.
- Wired that gate into automated drip texts, voicemail follow-up texts, and lead text blasts.
- Stamped `consent_at` when direct lead updates turn SMS consent on and no prior timestamp exists.

## High-Risk Findings

1. Historical lead records may have `sms_consent = 1` by default without a real `consent_at` timestamp. The new gate treats those as not eligible for automated marketing SMS until consent is explicitly recorded.
2. Website lead intake still has multiple lead submission paths and older funnel references to DOB-related fields. These need canonical ingestion cleanup before the UI/website overhaul is considered complete.
3. Some active source files reference secret-related environment variables or provider setup paths. I did not print or expose secret values; these need follow-up triage for hard-coded fallback behavior and frontend leakage.
4. Pnpm workspace verification is blocked on Windows by a repo preinstall script that invokes Unix `sh`. Direct TypeScript verification for the edited website app passes.

## Verification

- CRM V2: `npm run typecheck` passed.
- CRM V2: `npm run build` passed.
- CRM V1: `npm run typecheck` passed.
- CRM V1: `npm run build` passed.
- Website app: direct TypeScript check passed with `node_modules/.bin/tsc -p artifacts/smartr8/tsconfig.json --noEmit`.
- Website pnpm command did not run because the workspace preinstall hook uses `sh`, which is unavailable in this Windows shell.

## Not Completed Yet

- Full UI/design-system overhaul.
- Canonical website lead ingestion consolidation.
- Pixel/CAPI dedupe review.
- Delivery-status/retry audit across iMessage, SMS, WhatsApp, email, and calls.
- Full secret fallback remediation.
- End-to-end preview deployment and browser QA.
- Production deploy, merge, DNS, Render, Cloudflare, and provider configuration changes.
