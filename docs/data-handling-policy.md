# Data Handling Policy

This policy is for a small CRM/LOS-lite beta. It is meant to reduce avoidable risk while the product is still early.

## Data To Collect

- Lead contact details needed for follow-up: name, phone, email, state, preferred channel, and source.
- Mortgage workflow details needed for routing and qualification-lite: loan purpose, property state, timeline, basic notes, call/message history, and campaign status.
- Consent, opt-out, DNC, and communication preference records.
- User account details needed to operate the system: username, display name, role, disabled status, and session metadata.
- Operational logs needed for troubleshooting and abuse review.

## Data Not To Collect Yet

- Social Security numbers.
- Full credit reports or credit credentials.
- Bank login credentials.
- Full tax returns, paystubs, W-2s, bank statements, IDs, or borrower document packages unless a reviewed upload/storage process is in place.
- Payment card data.
- Medical, household, or demographic information that is not required for the workflow.

## SSN And Credit Report Caution

Do not add SSN, credit-pull, or full borrower identity workflows until access controls, encryption expectations, vendor contracts, retention rules, audit logging, and deletion workflows have been reviewed. If those workflows become necessary, isolate them from the general CRM data model.

## Borrower Document Caution

Borrower documents can contain highly sensitive personal and financial data. Before accepting documents, require authentication, file type restrictions, malware scanning or vendor scanning, storage access controls, retention rules, and audit logging for upload/download/export.

## Retention And Deletion

- Keep lead and communication records only as long as needed for business, compliance, and dispute-handling purposes.
- Honor deletion or suppression requests according to legal and business requirements.
- Keep SMS opt-out and DNC suppression records long enough to prevent accidental future outreach.
- Remove stale exports and local downloads from laptops and shared drives.
- Document backup retention and restore expectations.

## Access Control

- Admin access is limited to trusted operators.
- Standard users should see only the leads and functions needed for their job.
- Shared break-glass credentials must be rotated after staffing or vendor changes.
- Vendor access should be time-limited and removed after support work is complete.
- MFA is required on systems that can access production data or deploy code.

## Export Logging

Exports should record who exported data, when, the type of data, and the reason when practical. Large exports should be reviewed by an admin before sharing outside the company.
