# Drip Campaign Compliance Checklist

Covers the four product funnels on smartr8.com (DSCR, Cash Out Refi, Rate and
Term Refi, Purchase; HELOC already live) and the six drip campaigns the CRM
runs from them. Every rule below was applied to the funnel copy and the drip
content. No dashes (hyphen, en dash, or em dash) appear anywhere in the
customer facing copy; phone numbers are formatted (xxx) xxx xxxx.

## SMS (TCPA, CTIA, 10DLC)

- [ ] **Consent recorded, not gating (owner decision, June 2026).** The funnel
      still posts `smsOptIn` and the CRM keeps the record (`sms_consent`,
      `consent_at`, raw answer in `custom.smsOptIn`), but `send_text` no longer
      skips on missing consent — every lead is texted unless their number is on
      the **DNC list** (`src/services/automations.ts` checks `isOnDnc`). A STOP
      reply, IVR opt-out, or the console DNC button adds to that list and is
      honored everywhere (texts, calls, voicemail). Note: texting leads without
      an express opt-in record carries TCPA risk the owner has accepted.
- [x] **First message identity + reason + STOP/HELP.** The day 0 SMS in every
      sequence names the sender (Mykoal DeShazo), states the reason ("you asked
      about X at smartr8.com"), and includes "Reply STOP to opt out, HELP for
      help."
- [x] **STOP cadence.** "Reply STOP to opt out" is in message 1 and message 5
      (day 12), satisfying "first message and at least every 4th after."
- [x] **STOP honored immediately.** Inbound STOP, STOPALL, UNSUBSCRIBE, END,
      CANCEL, or QUIT adds the number to the DNC suppression list and withdraws
      the lead's consent (`src/routes/webhooks.ts`). The 10DLC carrier also
      enforces STOP independently.
- [x] **Quiet hours / frequency.** Messages are scheduled on day offsets
      0, 1, 3, 6, 12, 21 (six over about three weeks): roughly one every two to
      three days, well under eight per month. (Quiet hours per the recipient's
      local time are enforced operationally by the sending window; the voicemail
      step is already calling hours gated, and SMS scheduling should be reviewed
      against the recipient timezone before enabling at scale.)
- [x] **No trigger terms.** No specific rate, APR, or monthly payment figures
      anywhere. Copy uses "let us run your numbers" and "see your options".
- [x] **NMLS once per sequence.** NMLS 1912347 appears in the day 0 SMS of every
      sequence.
- [x] **Length.** Every non first message is one segment (<= 160 chars). The
      first message runs to two segments to fit the disclosures and never
      exceeds 320 chars. Counts are printed in `README.md`.
- [x] **One registration.** All six drips send from (619) 782 6916 under the
      single existing 10DLC Customer Care + Marketing registration. No new
      campaigns required.

## Email (CAN-SPAM + bulk sender rules)

- [x] **Truthful from + subject.** From name is Mykoal DeShazo (sent via
      noreply@mykoal.com / Resend). Subjects describe the email honestly.
- [x] **Physical mailing address.** 16767 N Perimeter Dr, Ste 150, Scottsdale,
      AZ 85260 appears in every email footer (and the signature).
- [x] **Working unsubscribe link.** Every drip email carries a visible
      unsubscribe link pointing at GET/POST `/unsubscribe?lead=<id>&t=<hmac>`
      (route in `src/routes/crm.ts`; HMAC token via `src/util/token.ts`), so
      links cannot be forged or enumerated. NOTE: `List-Unsubscribe` /
      one-click headers are not set yet — add them in `sendEmail` before bulk
      sending if your ESP requires them.
- [x] **Opt outs honored fast.** Unsubscribing tags the lead `email_unsubscribed`;
      the `send_email` step checks that tag and skips, so opt outs take effect on
      the very next step, inside the 10 day window.
- [x] **Full signature on every email.** Mykoal DeShazo, Vice President and
      Senior Loan Officer, NMLS 1912347; Adaxa Home LLC NMLS 2380533; Equal
      Housing Opportunity; licensed in AZ, CO, CT, FL, MI, MN, OR, PA, TX, VA,
      WA; call or text (480) 206 9290; 16767 N Perimeter Dr, Ste 150,
      Scottsdale, AZ 85260.
- [x] **No duplicate welcome.** The day-0 welcome email is the funnel's branded
      transactional email (smartr8 `functions/_lib/leadEmail.ts`); the drip's own
      emails start later (`campaignToSteps` skips day 0), so a new lead gets one
      welcome email, not two. The day-0 SMS still sends to consented leads.

## Funnel pages (mortgage advertising)

- [x] **NMLS identity.** Every funnel shows Mykoal DeShazo NMLS 1912347 and
      Adaxa Home LLC NMLS 2380533, Equal Housing Opportunity, and the licensed
      states, in the trust row and the shared footer.
- [x] **Separate, unchecked, optional SMS consent.** The consent checkbox is
      its own control, unchecked by default, and never a condition of submitting.
      It renders the verbatim disclosure with the product word swapped in, with
      Privacy Policy and Terms links directly below.
- [x] **Phone optional.** The phone field is optional and only required if the
      consent box is ticked (enforced client side and in the `/api/crm-lead`
      proxy).
- [x] **Loan type tag.** Each funnel posts `loanType`
      (HELOC | DSCR | CASHOUT_REFI | RT_REFI | PURCHASE) and `source` = the
      funnel URL; the CRM maps the loanType to a category
      (`src/services/tagging.ts`) and enrolls the lead into that category's
      campaign.
- [x] **No trigger terms on pages.** Funnel copy avoids specific rate, APR, or
      payment figures.

## Style

- [x] **No dashes** anywhere in customer facing copy (funnels, SMS, email).
      Compound terms are open: "cash out", "pre approval", "rate and term".
- [x] **Phone format** (xxx) xxx xxxx everywhere in new copy.
- [x] **Sender** is always Mykoal DeShazo. No emojis. One clear CTA per message.

## Operator notes (set before enabling)

- The six campaigns seed **disabled**. Review the copy, confirm the operating
  / marketing entity name with Adaxa Home compliance, then enable each in the
  Flows tab.
- Set `PUBLIC_BASE_URL` (this service's public origin) so unsubscribe links and
  `List-Unsubscribe` headers are absolute. Falls back to the OAuth redirect
  URI origin if unset.
- Confirm `RESEND_API_KEY` + `EMAIL_FROM` (noreply@mykoal.com) are set so email
  steps send; otherwise they skip.
- On the smartr8 site, `CRM_LEAD_WEBHOOK` (full URL including `?key=`) can
  override the built in default, and `TURNSTILE_SECRET_KEY` must be set for the
  bot check on the new funnels.
