# Adaxa Home — Master HELOC Follow-Up System

**Brand:** Adaxa Home · **Loan Officer:** Mykoal DeShazo, Senior Loan Officer
**Company NMLS:** Adaxa Home LLC NMLS #2380533 · **Individual NMLS:** Mykoal DeShazo NMLS #1912347
**Primary CTA:** See Your HELOC Options · **Website:** smartr8.com · **Direct line:** (480) 206 9290
**Lead sources:** Facebook, Instagram, Google, and other internet leads

This document is the production playbook for HELOC lead follow-up. Every workflow is written to be
copied directly into GoHighLevel, HubSpot, Salesforce, Shape, Jungo, or a similar CRM. Each workflow
includes: name, purpose, trigger, exit conditions, cadence table, SMS scripts, email scripts,
voicemail scripts, automation notes, and branch logic. Master tags, statuses, and routing rules are
at the end.

---

## How the system fits together

```
Internet lead arrives
        │
        ▼
[1] FRESH LEAD — SPEED TO LEAD (Days 0–14)
        │
        ├─ Replies / engages but no application ──▶ [2] WARM ENGAGED (Days 1–21)
        ├─ Identifies a use case ────────────────▶ [5] USE-CASE BRANCH (7 days), then returns
        ├─ No response after Day 14 ─────────────▶ [3] OLD LEAD REACTIVATION (later re-entry)
        ├─ Books appointment ────────────────────▶ Appointment workflow (out of scope here)
        └─ Applies ──────────────────────────────▶ Application workflow (out of scope here)
                                                          │
                                              Funds ──────▶ [4] PAST FUNDED CLIENT (24 months)
```

---

## How leads arrive and get tagged today (live behavior — do not change)

Website leads POST to this service at `POST /webhooks/lead?key=LEAD_WEBHOOK_SECRET`. Intake runs
`categorize()` (`src/services/tagging.ts`), which assigns **exactly one category** from the form's
`loanType` (an explicit `loanType` always wins; the smartr8.com funnels send the uppercase codes,
the mykoal.com form sends the human-readable values). The category is stored on the lead and the
`lead_created` trigger enrolls it in the seeded drip whose filter matches that category. **Any new
workflow built from this playbook must enroll by these same category values** — do not rename them.

| Website sends `loanType` | Category assigned | Seeded drip it enrolls in |
|---|---|---|
| `PURCHASE` · "Purchase" · "VA Loan" | `PURCHASE` | Purchase Path |
| `CASHOUT_REFI` · "Refinance" + cash-out intent in message | `CASHOUT_REFI` | Cash Out Refi |
| `HELOC` · "HELOC" | `HELOC` | HELOC |
| `RT_REFI` · "Refinance" without cash-out intent | `RATE_TERM_REFI` | Rate and Term Refi |
| `DSCR` · "Investor/DSCR" | `DSCR` | DSCR Investor |
| "General Inquiry" · no match | `GENERAL` | General Nurture |

No `loanType` → keyword fallback on the message, in precedence order: purchase → cash-out → HELOC
→ DSCR → rate/term → GENERAL. Note the precedence nuance: words like "debt consolidation,"
"remodel," and "home improvement" are **cash-out keywords**, so a no-loanType lead using them lands
in `CASHOUT_REFI`, not HELOC. That's intended — only leads who explicitly chose or mentioned a
HELOC get the HELOC track. The form's `smsOptIn` answer is kept on the lead as a consent record;
texting is on by default and the DNC list (STOP reply, IVR opt-out, or the console's DNC button)
is the one hard suppression. Re-submissions dedupe by phone/email and cleanly restart the drip.

**Where this playbook hooks in:** the workflows below expand the follow-up for the `HELOC`
category. Built in this service, Workflow 1 replaces/extends the seeded "HELOC" drip (same
`lead_created` trigger, same `{ category: "HELOC" }` filter); Workflows 2–5 are additional
automations keyed off tags/statuses set along the way. The other five categories keep their
existing seeded drips untouched.

---

## Global compliance rules (apply to every message in this document)

1. **Never promise approval.** Use "may," "options," "available equity," "review," and "see what
   may be available." Never "guaranteed," "free money," "no cost," "everyone qualifies,"
   "pre-approved" (as a blanket claim), or "lowest rate."
2. **Never quote rates, APR, payments, or fees** in SMS, voicemail, or standard drip emails. Reg Z
   trigger terms (rate, payment amount, term, amount of finance charge) require full disclosures —
   keep them out of automated copy entirely. Numbers belong in a live conversation or a disclosed
   quote document.
3. **SMS identification:** the first SMS of every workflow identifies the sender — *"Mykoal DeShazo
   with Adaxa Home (NMLS 1912347)"* — and includes *"Reply STOP to opt out, HELP for help."*
4. **SMS opt-out cadence:** include "Reply STOP to opt out" on the first message of a sequence, on
   the final message, and at least every third message in between. (Scripts below already do this.)
5. **STOP handling is absolute:** STOP/UNSUBSCRIBE/QUIT/CANCEL suppresses all SMS immediately,
   tags `dnc_sms`, and exits every workflow. No exceptions, no "one last text."
6. **Email footer (required on every email):**

   > Mykoal DeShazo · Senior Loan Officer · Adaxa Home
   > Adaxa Home LLC NMLS #2380533 · Mykoal DeShazo NMLS #1912347
   > Equal Housing Lender. This is not a commitment to lend. All loans subject to credit approval,
   > property review, and program guidelines. Terms subject to change without notice.
   > [Unsubscribe]

7. **Call windows:** calls and voicemail drops only between 8:00 AM and 9:00 PM in the **contact's**
   time zone (federal floor; some states are tighter — 8 AM–8 PM is the safe default). Unknown
   time zone → skip the call, do not guess.
8. **Quiet hours for SMS:** send between 9:00 AM and 7:00 PM contact-local. Immediate speed-to-lead
   replies to a fresh inquiry are the one exception — replying to a form fill within minutes is
   expected behavior.
9. **Consent scope:** these sequences assume the lead submitted a form with TCPA consent language.
   Leads older than the consent's reasonable shelf life (or imported lists without documented
   consent) get the re-permission path in Workflow 3 — email-first, no automated SMS.
10. **Tone:** professional, consultative, helpful. One question or one CTA per message. Never
    stack pressure ("last chance," "act now," "rates are exploding").

**Standard email signature (referenced below as `[SIGNATURE]`):**

```
Best,
Mykoal DeShazo
Senior Loan Officer | Adaxa Home
(480) 206 9290 · smartr8.com
Adaxa Home LLC NMLS #2380533 | Mykoal DeShazo NMLS #1912347
Equal Housing Lender. This is not a commitment to lend. All loans subject to credit approval,
property review, and program guidelines.
```

**Merge fields used:** `{{first_name}}`, `{{lead_source}}`, `{{use_case}}`. Map to your CRM's
syntax (GHL: `{{contact.first_name}}`; HubSpot: `{{contact.firstname}}`; Salesforce:
`{{Contact.FirstName}}`).

---

# WORKFLOW 1 — Fresh Internet Lead: Speed to Lead

## 1. Workflow name
`HELOC — Fresh Internet Lead (14-Day Speed to Lead)`

## 2. Purpose
Convert a brand-new internet lead while intent is highest. The first five minutes matter more than
the next five days: an immediate text and email land before the lead leaves the page, and the first
call happens inside three minutes. Days 0–2 are a contact blitz (this replaces a separate
"no-answer attack plan" — the blitz *is* the no-answer plan, and any reply branches out of it).
Days 3–14 shift to consultative value touches. The goal of every touch is one of three replies:
a use case, a booked call, or a clear "no."

## 3. Trigger
- New lead created with tag `heloc_new_lead` from any internet source (Facebook, Instagram, Google,
  website form), **or**
- Contact fills the HELOC form / clicks "See Your HELOC Options" on smartr8.com.
- On entry: set status **New Internet Lead**, apply `lead_source_*` tag, start SLA timer.

## 4. Exit conditions
Exit immediately (stop all pending steps) when any of the following occurs:
- Books an appointment → status **Appointment Set**, move to Appointment workflow.
- Starts or submits an application → status **Application Started/Complete**, move to Application workflow.
- Identifies a use case → tag `use_case_*`, branch to Workflow 5 (this workflow pauses; see branch logic).
- Replies "not interested" → status **Nurture**, tag `heloc_not_interested`, move to long-term nurture.
- Replies STOP → tag `dnc_sms`, suppress SMS, exit all workflows.
- Invalid phone/email (hard bounce + failed SMS) → tag `heloc_bad_contact`, status **Dead Lead**.
- Completes Day 14 with no response → tag `heloc_no_response_14d`, status **Nurture**, schedule
  Workflow 3 entry at Day 45.

## 5. Timing / cadence table

| Step | Timing | Channel | Asset |
|------|--------|---------|-------|
| 1 | 0–1 min | SMS | SMS 1.1 — instant response |
| 2 | 0–1 min | Email | Email 1.1 — instant response |
| 3 | 1–3 min | Call #1 | Live answer → discovery; no VM yet |
| 4 | 5 min (if no answer) | Voicemail | VM 1.1 |
| 5 | 15 min | SMS | SMS 1.2 — low-friction question |
| 6 | 60 min | Call #2 | No VM |
| 7 | 3 hours | Email | Email 1.2 — what a review covers |
| 8 | End of day | SMS | SMS 1.3 — scheduling question |
| 9 | Day 1 AM | Call #3 + VM 1.2 | |
| 10 | Day 1 PM | SMS | SMS 1.4 — text-first offer |
| 11 | Day 2 AM | Call #4 | No VM |
| 12 | Day 2 PM | Email | Email 1.3 — HELOC vs. refinance |
| 13 | Day 3 | SMS | SMS 1.5 — use-case sorter |
| 14 | Day 5 | Call #5 + VM 1.3 | |
| 15 | Day 7 | Email | Email 1.4 — HELOC vs. personal loan |
| 16 | Day 8 | SMS | SMS 1.6 — close-or-continue |
| 17 | Day 10 | Call #6 | No VM |
| 18 | Day 12 | Email | Email 1.5 — pre-breakup |
| 19 | Day 14 | SMS | SMS 1.7 — breakup |

Six calls, seven texts, five emails, three voicemails over 14 days. Front-loaded by design:
ten touches in the first 48 hours, then roughly every other day.

## 6. SMS scripts

**SMS 1.1 — Instant response (0–1 min)**
> Hi {{first_name}}, this is Mykoal DeShazo with Adaxa Home (NMLS 1912347). I just got your HELOC request from smartr8.com. Quick question so I point you the right way: is this mainly for paying down debt, a home project, or having funds in reserve? Reply STOP to opt out, HELP for help.

**SMS 1.2 — Low-friction question (15 min)**
> {{first_name}}, one thing worth knowing up front: a HELOC works alongside your current first mortgage instead of replacing it. Is keeping your current mortgage in place important to you?

**SMS 1.3 — Scheduling question (end of Day 0)**
> {{first_name}}, I tried calling about your HELOC request. A quick review of your home value, mortgage balance, and goals is usually all it takes to see what options may be available. Better to connect mornings or afternoons? Reply STOP to opt out.

**SMS 1.4 — Text-first offer (Day 1 PM)**
> Looks like we keep missing each other, {{first_name}}. If it's easier, I can handle the whole review by text — no call needed. Want me to send over what I'd need to get started?

**SMS 1.5 — Use-case sorter (Day 3)**
> {{first_name}}, most homeowners I work with use a HELOC for one of three things: consolidating higher-interest debt, funding a home project, or keeping a line in reserve. Which is closest to your situation? Reply 1, 2, or 3. Reply STOP to opt out.

**SMS 1.6 — Close-or-continue (Day 8)**
> {{first_name}}, should I keep your HELOC request open or close it out for now? If you're still interested, reply YES and I'll take a look at what may be available. Either answer is fine.

**SMS 1.7 — Breakup (Day 14)**
> {{first_name}}, I don't want to clutter your phone, so this is my last text for now. I'll keep your request on file — if you'd like to review your HELOC options down the road, reply HELOC or call/text me at (480) 206 9290 anytime. Reply STOP to opt out. — Mykoal, Adaxa Home

## 7. Email subject lines and bodies

**Email 1.1 — Instant response (0–1 min)**
Subject: **Your HELOC options request — next step**
Preheader: One quick question and I can start your review.

> Hi {{first_name}},
>
> Thanks for requesting HELOC options through smartr8.com — I have your request and I'm on it.
>
> Quick orientation: a HELOC is a line of credit secured by your home's equity. It works alongside
> your current first mortgage rather than replacing it, and you draw on it as needed rather than
> taking everything at once. Whether it's the right fit depends on your home value, current
> mortgage balance, credit profile, and what you want the funds to do.
>
> That last part is where I'd start. What's the main goal?
>
> 1. **Pay down or consolidate debt**
> 2. **Home improvements or repairs**
> 3. **Cash reserves / flexibility**
> 4. **Something else**
>
> Reply with a number (or just tell me in your own words) and I'll tailor the review to it. If
> you'd rather talk it through, grab a time here: **[See Your HELOC Options → booking link]**
>
> [SIGNATURE]

**Email 1.2 — What a review covers (3 hours)**
Subject: **What I look at before showing HELOC options**
Preheader: Four inputs, one short conversation, no obligation.

> Hi {{first_name}},
>
> So you know exactly what you're signing up for: a HELOC review with me is one short conversation
> built around four inputs —
>
> - **Estimated home value** (your best estimate is fine to start)
> - **Current mortgage balance** — together these frame your available equity
> - **Approximate credit range** — a range, not a credit pull, to start
> - **Your goal for the funds** — this drives which structures are worth comparing
>
> From there I can tell you honestly whether a HELOC looks worth pursuing or whether a different
> route may serve you better. No obligation either way.
>
> **[See Your HELOC Options → booking link]** — or just reply to this email with the four items
> above and I'll start from there.
>
> [SIGNATURE]

**Email 1.3 — HELOC vs. refinance (Day 2)**
Subject: **Keep your first mortgage, or replace it?**
Preheader: The one question that sorts HELOC vs. cash-out refinance.

> Hi {{first_name}},
>
> The most common fork in the road for homeowners looking at their equity:
>
> **A cash-out refinance** replaces your current first mortgage with a new one and hands you the
> difference in cash. It can make sense — but it means your entire balance moves to today's terms.
>
> **A HELOC** leaves your first mortgage untouched and adds a separate line of credit against your
> equity. Many homeowners look at it specifically because they want to keep their existing mortgage
> exactly as it is.
>
> Which one pencils out better depends on your current mortgage, your equity position, and what the
> funds are for — it's a numbers question, not a slogan question, and it's exactly what a quick
> review answers.
>
> Want me to run the comparison for your situation? **[See Your HELOC Options → booking link]**
>
> [SIGNATURE]

**Email 1.4 — HELOC vs. personal loan (Day 7)**
Subject: **HELOC or personal loan — how homeowners compare them**
Preheader: Secured vs. unsecured changes the whole picture.

> Hi {{first_name}},
>
> If you've been weighing a personal loan, here's the homeowner's version of that comparison:
>
> - A **personal loan** is unsecured, funds fast, and is fixed — but it's a one-time lump sum.
> - A **HELOC** is secured by your home equity, which is why it can offer larger lines and flexible,
>   draw-as-needed access. The trade-off is real: it's secured by your home, so it deserves a
>   careful review, not a quick yes.
>
> Neither is "better" in the abstract. The right answer comes from your equity, your credit profile,
> and your goal. If you'd like the homeowner's comparison run on your actual numbers, reply with:
>
> **1** — debt payoff · **2** — home improvements · **3** — cash reserves · **4** — other
>
> [SIGNATURE]

**Email 1.5 — Pre-breakup (Day 12)**
Subject: **Closing out your HELOC request?**
Preheader: One reply keeps it open.

> Hi {{first_name}},
>
> I've reached out a few times about the HELOC request you submitted, and I don't want to keep
> emailing if the timing isn't right.
>
> Before I close it out: if you're still curious what your equity could do — even loosely — it's a
> 10-minute conversation to find out what options may be available. If now isn't the time, that's
> completely fine too; equity isn't going anywhere.
>
> **Reply "open"** to keep it active, or **[See Your HELOC Options → booking link]** to pick a time.
> Otherwise I'll set it aside and you can reach me whenever it's useful: (480) 206 9290.
>
> [SIGNATURE]

## 8. Voicemail scripts

**VM 1.1 — First attempt (5 min)** *(~20 seconds)*
> Hi {{first_name}}, this is Mykoal DeShazo with Adaxa Home. You just requested HELOC options through smartr8.com, so I wanted to reach you while it's fresh. I have two quick questions and then I can tell you what may be available. Call or text me back at (480) 206 9290 — again, Mykoal with Adaxa Home, (480) 206 9290. Thanks.

**VM 1.2 — Day 1** *(~20 seconds)*
> Hi {{first_name}}, Mykoal with Adaxa Home following up on your HELOC request. Most reviews take one short call — home value, mortgage balance, and what you want the funds to do. I'll text you as well in case that's easier. (480) 206 9290. Talk soon.

**VM 1.3 — Day 5** *(~20 seconds)*
> Hi {{first_name}}, Mykoal DeShazo at Adaxa Home. Still happy to review your HELOC options whenever you're ready — no pressure on timing. If it's easier, reply to my text and we can handle most of it that way. (480) 206 9290. Have a great day.

## 9. Notes for CRM automation
- **SLA alarm:** if no human call is logged within 5 minutes of lead creation during business hours,
  fire an internal notification (GHL: internal SMS/Slack webhook; Salesforce: escalation rule).
- **Steps 1–2 are automation; calls are tasks.** Build calls as workflow-created tasks with due
  times, not as "hopes." Each call task auto-completes the next SMS only if marked attempted.
- **Any inbound reply pauses all pending automated sends** in this workflow and notifies Mykoal.
  Resume only by explicit action (GHL: "wait for reply" + manual re-enroll; HubSpot: contact
  re-enrollment off).
- **Reply parsing:** map keyword replies — `1/debt/cards/consolidat*` → Debt branch; `2/project/
  remodel/roof/kitchen/pool/repair` → Home Improvement branch; `3/reserve/backup/emergency` → Cash
  Reserve branch; `YES/HELOC/open` → hot-lead task + status **Contacted**; `STOP` → DNC (carrier +
  CRM).
- **Send windows:** restrict steps 8+ to 9 AM–7 PM contact-local; steps 1–7 may run same-day on the
  inquiry's own timing.
- **Source stamping:** write `lead_source_facebook` / `_instagram` / `_google` / `_other` on entry;
  you will want per-source conversion reporting within 30 days of launch.
- In **this repo's CRM**, this maps to a `lead_created` automation: `send_text` / `send_email`
  steps with `delayMinutes`, `voicemail_drop` for VM steps (calling-hours gated automatically),
  plus `add_tag` / `set_status` steps at entry and exit.

## 10. Recommended tags / statuses
Entry: `heloc_new_lead`, `lead_source_*`, status **New Internet Lead** → **Attempting Contact**
after first call attempt. On reply: `heloc_contacted`, status **Contacted**. On exit: per exit
conditions above.

## 11. Recommended branch logic
- Reply with use case → tag `use_case_*`, **pause** this workflow, run Workflow 5 branch, then
  resume here at the next un-sent step if still unbooked.
- Missed-call-but-texted-back → treat as Contacted; skip remaining Day 0–2 blitz, continue from Day 3.
- Phone invalid but email valid → strip call/SMS steps, run email-only spine, tag `heloc_bad_contact_phone`.
- Day 14 no response → status **Nurture**, auto-enroll in Workflow 3 (15–45 day band) at Day 45.

---

# WORKFLOW 2 — Warm Engaged, Did Not Apply

## 1. Workflow name
`HELOC — Warm Engaged / No Application (21-Day Re-Engage)`

## 2. Purpose
Recover leads who showed real intent — replied, answered once, clicked, started a form, or booked
and no-showed — but stalled before applying. These are the highest-value non-applicants in the
database. The angle is never "do you want a loan?"; it's "let's finish what you started," plus
removing whatever blocked them (time, uncertainty, fear of a credit pull, fear of pressure).

## 3. Trigger
Any of: replied to a message but went quiet ≥3 days · booked and no-showed · started but abandoned
the application/form · answered one call then unreachable · clicked 2+ emails with no reply.
Tag on entry: `heloc_warm_engaged`. Status: **Needs Follow-Up**.

## 4. Exit conditions
Same as Workflow 1 (book / apply / not interested / STOP / bad contact), plus:
- Re-engages with a reply → pause automation, human takes over; re-enroll only if it stalls again.
- Day 21 with no response → status **Nurture**, queue for Workflow 3 (46–120 band) after 30 days.

## 5. Timing / cadence table

| Step | Timing | Channel | Asset |
|------|--------|---------|-------|
| 1 | Day 1 | SMS | SMS 2.1 — pick it back up |
| 2 | Day 2 | Call + VM 2.1 | |
| 3 | Day 4 | Email | Email 2.1 — pick it back up |
| 4 | Day 7 | SMS | SMS 2.2 — name the blocker |
| 5 | Day 10 | Call (no VM) | |
| 6 | Day 14 | Email | Email 2.2 — what changes while you wait |
| 7 | Day 18 | SMS | SMS 2.3 — pause or proceed |
| 8 | Day 21 | Email | Email 2.3 — breakup |

## 6. SMS scripts

**SMS 2.1 — Day 1**
> Hi {{first_name}}, Mykoal DeShazo with Adaxa Home (NMLS 1912347). We started looking at your HELOC options but didn't get to the finish line. Want to pick it back up where we left off, or is it on pause for now? Either is fine — just let me know. Reply STOP to opt out, HELP for help.

**SMS 2.2 — Day 7**
> {{first_name}}, when this stalls it's usually one of three things: timing got busy, a question didn't get answered, or worry about a credit pull. Which one is it for you? The first review doesn't require a credit pull, if that helps.

**SMS 2.3 — Day 18**
> {{first_name}}, should I keep your HELOC review active or set it aside for now? Reply KEEP or PAUSE — takes two seconds either way. Reply STOP to opt out.

## 7. Email subject lines and bodies

**Email 2.1 — Day 4**
Subject: **Want to pick your HELOC review back up?**
Preheader: We can resume exactly where we left off.

> Hi {{first_name}},
>
> We started reviewing your HELOC options a little while back and didn't quite finish. That's
> normal — life moves — and there's zero penalty for picking it back up.
>
> Everything you've already shared is still on file, so resuming takes minutes, not a restart.
> The remaining step is simply confirming your goals and numbers so I can show you what options
> may be available.
>
> **[See Your HELOC Options → booking link]** — or reply "resume" and I'll take it from there.
>
> [SIGNATURE]

**Email 2.2 — Day 14**
Subject: **What actually changes while you wait**
Preheader: Equity, credit, and goals all move — a review is just a snapshot.

> Hi {{first_name}},
>
> One honest thing about waiting: nothing about a HELOC review locks you in. It's a snapshot of
> what may be available **right now**, based on your home value, mortgage balance, and credit
> profile. All three of those drift over time — sometimes in your favor, sometimes not.
>
> So "I'll deal with it later" is a fine answer; it just means a later snapshot. If you'd rather
> know where you stand today and *then* decide on timing, that's the order I'd recommend —
> information first, decision second.
>
> Happy to finish your review whenever you are: **[See Your HELOC Options → booking link]**
>
> [SIGNATURE]

**Email 2.3 — Day 21 (breakup)**
Subject: **Setting your HELOC review aside (for now)**
Preheader: One reply reopens it anytime.

> Hi {{first_name}},
>
> I'm going to set your HELOC review aside so you stop hearing from me on a schedule.
>
> Nothing is lost — your information stays on file, and reopening it is one reply or one call away
> whenever the timing is right: (480) 206 9290.
>
> Thanks for considering Adaxa Home. I'm here when it's useful.
>
> [SIGNATURE]

## 8. Voicemail scripts

**VM 2.1 — Day 2** *(~20 seconds)*
> Hi {{first_name}}, Mykoal with Adaxa Home. We'd started looking at your HELOC options and I didn't want it to fall through the cracks on my end. Happy to pick up right where we left off — it won't take long. (480) 206 9290. Thanks, {{first_name}}.

## 9. Notes for CRM automation
- Personalize step 1 by **stall point** if your CRM supports it: no-show → prepend "Sorry we missed
  each other for our scheduled time."; abandoned form → "Your form is saved about halfway through."
- A no-show should also fire an immediate same-day "want to rebook?" SMS *before* this workflow's
  Day 1 (build as a separate 1-step automation on the appointment_no_show event).
- KEEP/RESUME replies → status **Needs Follow-Up** + task for same-day call. PAUSE replies → status
  **Nurture**, suppress 60 days, then Workflow 3 eligibility.
- Cap: max one automated SMS per 3 days in this workflow; warm leads churn on volume.

## 10. Recommended tags / statuses
`heloc_warm_engaged`, plus stall-point tags if known: `stall_no_show`, `stall_form_abandoned`,
`stall_went_quiet`. Status: **Needs Follow-Up** → exits per above.

## 11. Recommended branch logic
- Reply mentions credit pull worry → send the "no credit pull to start" framing (SMS 2.2's second
  sentence as a standalone) and a booking link; tag `objection_credit_pull`.
- Reply mentions timing → offer a specific future check-in ("Want me to circle back in 30/60/90
  days?") and schedule it as a task, not a drip; tag `objection_timing`.
- Use-case keywords → Workflow 5 branch, same as Workflow 1.

---

# WORKFLOW 3 — Old Lead Reactivation

## 1. Workflow name
`HELOC — Old Lead Reactivation (30-Day, Age-Banded)`

## 2. Purpose
Revive leads who raised their hand once and never converted. The posture is confident and
service-oriented — "is this still on your radar, and has anything changed?" — never apologetic or
desperate. Older leads get progressively lighter-touch treatment, and the oldest band gets a
re-permission approach because consent and accuracy decay with age.

## 3. Trigger
Manual or scheduled enrollment of leads with no activity, segmented by age since last engagement:

| Band | Age | Angle | Channels |
|------|-----|-------|----------|
| A | 15–45 days | "Still on your radar?" | Full SMS + email + call |
| B | 46–120 days | "Has the timing changed?" | Full SMS + email + call |
| C | 121–365 days | "Worth a fresh look — things change" | SMS + email, fewer calls |
| D | 365+ days | Re-permission | **Email only** until they re-engage; no automated SMS |

Tag on entry: `old_lead_reactivation` + band tag (`reactivation_band_a` … `_d`).

## 4. Exit conditions
Same master exits (book / apply / not interested / STOP / bad contact), plus:
- Any reply → pause automation, route to human, status **Contacted**.
- Day 30 no response → status **Dead Lead** for bands A–C (eligible for one re-run after 90+ days,
  max two lifetime reactivation attempts); band D non-openers → suppress from active marketing.
- Email hard bounce in band D → archive; do not fall back to SMS.

## 5. Timing / cadence table (bands A–C; band D = email steps only)

| Step | Timing | Channel | Asset |
|------|--------|---------|-------|
| 1 | Day 1 | SMS | SMS 3.1 — radar check |
| 2 | Day 1 | Email | Email 3.1 — still considering |
| 3 | Day 3 | Call + VM 3.1 | Bands A–B only |
| 4 | Day 6 | SMS | SMS 3.2 — what changed |
| 5 | Day 10 | Email | Email 3.2 — fresh look |
| 6 | Day 14 | Call (no VM) | Bands A–B only |
| 7 | Day 18 | SMS | SMS 3.3 — three reasons |
| 8 | Day 24 | Email | Email 3.3 — direct question |
| 9 | Day 30 | SMS + Email | SMS 3.4 / Email 3.4 — breakup |

## 6. SMS scripts

**SMS 3.1 — Day 1**
> Hi {{first_name}}, Mykoal DeShazo with Adaxa Home (NMLS 1912347). A while back you looked into HELOC options through smartr8.com. Is accessing your home equity still on your radar, or should I close your file? Reply STOP to opt out, HELP for help.

**SMS 3.2 — Day 6**
> {{first_name}}, since you first looked, your home value, mortgage balance, and credit picture have all had time to move — which means the options may look different now too. Worth a fresh 10-minute look?

**SMS 3.3 — Day 18**
> {{first_name}}, homeowners usually come back to this for one of three reasons: card balances crept up, a home project moved to the front burner, or they want a reserve in place before they need it. Sound like any of those? Reply STOP to opt out.

**SMS 3.4 — Day 30 (breakup)**
> {{first_name}}, I'll close out your HELOC file for now so I'm not texting into the void. If you ever want a fresh look at your options, reply HELOC or call/text (480) 206 9290 and I'll reopen it. Reply STOP to opt out. — Mykoal, Adaxa Home

## 7. Email subject lines and bodies

**Email 3.1 — Day 1**
Subject: **Is a HELOC still on your radar, {{first_name}}?**
Preheader: You looked into it once — checking whether the timing changed.

> Hi {{first_name}},
>
> Some time back you requested information about HELOC options, and I wanted to check in rather
> than assume the answer.
>
> Plenty of homeowners shelve this and come back to it when the timing is right — a project gets
> real, balances need consolidating, or they decide they want a reserve in place. If any of that
> sounds familiar, I can take a fresh look at what may be available based on where your home value,
> mortgage balance, and goals stand **today**.
>
> Still on your radar? **[See Your HELOC Options → booking link]** — or reply and tell me where
> things stand. If it's a "no," tell me that too and I'll close your file.
>
> [SIGNATURE]

**Email 3.2 — Day 10**
Subject: **Why an old equity answer may be out of date**
Preheader: Value, balance, and credit all move. So do your options.

> Hi {{first_name}},
>
> Whatever you learned about your equity options back when you first looked, treat it as expired.
> Three inputs drive everything, and all three move:
>
> - **Home value** — markets shift, and your available equity shifts with them
> - **Mortgage balance** — every payment since then changed the math
> - **Credit profile** — better or worse, it affects what programs may be available
>
> A fresh review is a short conversation, there's no obligation, and the first look doesn't require
> a credit pull. Worst case, you walk away with a current answer instead of an old one.
>
> **[See Your HELOC Options → booking link]**
>
> [SIGNATURE]

**Email 3.3 — Day 24**
Subject: **One direct question**
Preheader: Keep your file open, or close it?

> Hi {{first_name}},
>
> I'll keep this short. Your HELOC inquiry is still open on my end, and I'd rather ask than assume:
>
> **Keep it open** — reply "open" or grab a time: **[See Your HELOC Options → booking link]**
> **Close it** — reply "close" and I'll stop the scheduled follow-ups.
>
> Either way, you'll always be able to reach me directly at (480) 206 9290.
>
> [SIGNATURE]

**Email 3.4 — Day 30 (breakup)**
Subject: **Closing your HELOC file**
Preheader: Reopening it later takes one reply.

> Hi {{first_name}},
>
> I'm closing out your HELOC inquiry for now — no response needed.
>
> If your plans change, reopening is simple: reply to this email, or call/text me at (480) 206 9290
> and we'll start from wherever you are then. Thanks for having considered Adaxa Home.
>
> [SIGNATURE]

**Band D re-permission variant (replaces Email 3.1; email-only band):**
Subject: **Should I keep you on the list, {{first_name}}?**
Preheader: It's been a while since you asked about home equity options.

> Hi {{first_name}},
>
> Over a year ago you asked about home equity options, and I don't believe in emailing forever on
> an old request. So, one simple question:
>
> **Still interested in hearing about HELOC options occasionally?** Reply "yes" or click below and
> I'll keep you posted — and take a fresh look at your situation if you'd like one.
>
> **[Yes — keep me posted / See Your HELOC Options → link]**
>
> If not, no action needed; this is the only check-in, and the unsubscribe link below always works.
>
> [SIGNATURE]

## 8. Voicemail scripts

**VM 3.1 — Day 3 (bands A–B)** *(~20 seconds)*
> Hi {{first_name}}, Mykoal DeShazo with Adaxa Home. You'd looked into HELOC options a while back, and I'm doing a round of check-ins before I close out older files. If it's still on your radar — even loosely — call or text me at (480) 206 9290 and I'll take a fresh look with you. Thanks.

## 9. Notes for CRM automation
- **Batch and throttle:** enroll old leads in batches (e.g., 50/day) so replies are answerable and
  your SMS sender reputation isn't spiked. Spread band C/D over weeks.
- **Hygiene first:** before enrollment, scrub against DNC tags, existing clients, and anyone with
  an open application. Validate phone/email where possible (band C/D especially).
- **Two-strike rule:** a lead gets at most two lifetime reactivation runs. Enforce with a counter
  field (`reactivation_runs`) checked at enrollment.
- **Band D is email-only by policy** until the contact re-engages (reply/click + form), which
  refreshes consent — then normal SMS rules apply.
- Reply "close" → status **Dead Lead**, suppress from future reactivation. Reply "open"/"HELOC" →
  status **Needs Follow-Up** + same-day call task.

## 10. Recommended tags / statuses
`old_lead_reactivation`, `reactivation_band_a/b/c/d`, `reactivation_runs` (counter). Status:
**Nurture** → **Contacted** on reply → master exits.

## 11. Recommended branch logic
- Any reply with a use-case keyword → Workflow 5 branch.
- "Open"/"yes" replies in bands C–D → treat as fresh: enroll in Workflow 1 from Day 3 (skip the
  0–48h blitz; they're warm, not hot).
- No engagement after two lifetime runs → suppress from reactivation permanently; quarterly
  newsletter only (if consented).

---

# WORKFLOW 4 — Past Funded Client Relationship

## 1. Workflow name
`Past Client — 24-Month Relationship & Referral Drip`

## 2. Purpose
Protect the relationship after funding and turn one closed loan into reviews, referrals, and repeat
business. The rule: **give value four times for every ask.** No hard selling — these clients
already trusted Adaxa Home; the job is to stay genuinely useful and easy to refer. The annual
equity review is the centerpiece touch.

## 3. Trigger
Loan funds → tag `heloc_funded` + `past_client`, status **Funded**, remove from all sales
workflows, enroll here Day 1 post-funding.

## 4. Exit conditions
- Replies STOP → suppress SMS; continue email-only if subscribed.
- Unsubscribes from email → SMS/call touches only where consented, or archive.
- Becomes an active lead again (new inquiry/application) → pause this drip, run the sales process,
  re-enroll after closing or at the next scheduled touch.
- Loan pays off / property sells → move to alumni track (annual check-in only).
- Requests no contact → full suppression, status **Do Not Contact**.

## 5. Timing / cadence table

| Step | Timing | Channel | Asset |
|------|--------|---------|-------|
| 1 | Day 1 | Email | Email 4.1 — thank you |
| 2 | Day 7 | SMS | SMS 4.1 — post-funding check-in |
| 3 | Day 30 | Email | Email 4.2 — review request |
| 4 | Day 60 | SMS | SMS 4.2 — referral ask |
| 5 | Day 90 | Email | Email 4.3 — using your line well |
| 6 | Month 6 | SMS | SMS 4.3 — six-month check-in |
| 7 | Month 9 | Email | Email 4.4 — value note + soft referral |
| 8 | Month 12 | Email + call task | Email 4.5 — annual equity review |
| 9 | Month 15 | SMS | SMS 4.4 — seasonal/project check-in |
| 10 | Month 18 | Email | Email 4.6 — 18-month note |
| 11 | Month 21 | SMS | SMS 4.5 — light check-in |
| 12 | Month 24 | Email + call task | Email 4.7 — annual review + referral |
| Ongoing | Quarterly after Month 24 | Email | Rotate value topics; annual review every 12 months |

## 6. SMS scripts

**SMS 4.1 — Day 7**
> Hi {{first_name}}, Mykoal with Adaxa Home (NMLS 1912347). Now that everything's funded, just checking in — is everything set up the way you expected? Any questions about your line, I'm one text away. Reply STOP to opt out, HELP for help.

**SMS 4.2 — Day 60**
> {{first_name}}, a small favor: if a friend, neighbor, or family member ever mentions wanting to tap their home equity or compare mortgage options, I'd be honored to take care of them the way I took care of you. My direct line is (480) 206 9290 — feel free to pass it along. No pressure at all.

**SMS 4.3 — Month 6**
> Hi {{first_name}}, Mykoal at Adaxa Home — hope the year's treating you well. Any home projects, equity questions, or mortgage questions come up since we wrapped up? Happy to help, no agenda. Reply STOP to opt out.

**SMS 4.4 — Month 15**
> {{first_name}}, project season check-in: anything on the house list this year — repairs, upgrades, big plans? If reviewing your equity position would help with the planning, say the word. — Mykoal, Adaxa Home

**SMS 4.5 — Month 21**
> Hi {{first_name}}, Mykoal with Adaxa Home. No agenda — just keeping in touch. If anything mortgage- or equity-related comes up for you or someone you know, I'm at (480) 206 9290. Reply STOP to opt out.

## 7. Email subject lines and bodies

**Email 4.1 — Day 1: Thank you**
Subject: **Thank you, {{first_name}} — and congratulations**
Preheader: You're funded. Here's what I'm here for going forward.

> Hi {{first_name}},
>
> Congratulations — everything is funded and complete. Thank you for trusting me and Adaxa Home
> with something this important; it genuinely means a lot.
>
> Going forward, think of me as your home-financing resource, not just the person from this
> transaction. Questions about your line, your mortgage, your equity, or "does this make sense?" —
> for you or anyone you care about — my direct line is (480) 206 9290 and I actually answer it.
>
> Congratulations again. Enjoy it.
>
> [SIGNATURE]

**Email 4.2 — Day 30: Review request**
Subject: **A quick favor, {{first_name}}?**
Preheader: Two minutes that helps other homeowners find honest guidance.

> Hi {{first_name}},
>
> Now that you've had a few weeks to settle in, I have one small ask.
>
> If working with me was a good experience, would you take two minutes to leave a short review?
> Most homeowners pick a lender knowing almost nothing about who they're trusting — honest reviews
> from real clients are how they find their way to good guidance.
>
> **[Leave a review → review link]**
>
> If anything about your experience was less than great, I'd rather hear that directly — reply and
> tell me. Thank you either way, {{first_name}}.
>
> [SIGNATURE]

**Email 4.3 — Day 90: Using your line well**
Subject: **Keep this one for later**
Preheader: A few habits that make a HELOC work harder for you.

> Hi {{first_name}},
>
> No ask in this one — just a few habits I see disciplined HELOC clients share, worth filing away:
>
> - **Decide what the line is for, and write it down.** Project fund, consolidation tool, or
>   emergency reserve — a line with a job is an asset; a line without one becomes impulse spending.
> - **Treat draws like decisions, not swipes.** It's secured by your home; it deserves the same
>   thought a loan would get.
> - **Revisit it once a year.** Goals change, balances change, home values change. An annual
>   ten-minute review keeps the strategy current — I'll reach out when yours comes up.
>
> Questions in the meantime, you know where I am.
>
> [SIGNATURE]

**Email 4.4 — Month 9: Value + soft referral**
Subject: **The question I get most from past clients**
Preheader: "Can you help my [sister / coworker / neighbor]?" Yes.

> Hi {{first_name}},
>
> The question past clients ask me most isn't about their own loan — it's "can you help someone I
> know?" The answer is always yes, and those introductions are honestly the best part of this job.
>
> So consider this a standing offer: anyone in your circle weighing a home purchase, a refinance,
> or tapping their equity is welcome to my direct line, (480) 206 9290, and they'll get the same
> straight answers you did — including "this isn't the right move" when it isn't.
>
> And you, {{first_name}}: anything changed on your end I should know about? Reply anytime.
>
> [SIGNATURE]

**Email 4.5 — Month 12: Annual equity review**
Subject: **Your annual equity review, {{first_name}}**
Preheader: Ten minutes, once a year. No pressure to change anything.

> Hi {{first_name}},
>
> It's been about a year since we closed, which means it's time for the one recurring thing I do
> for every client: a short annual review. We look at —
>
> - Where your **home value and available equity** stand now
> - Whether your **current setup still matches your goals** for the year ahead
> - Any **questions or plans** on your horizon — projects, consolidation, reserves, education costs
>
> Most reviews end with "you're in good shape, see you next year" — and that's a great outcome.
> The point is that you *know*, instead of guessing.
>
> **[Book your 10-minute review → booking link]** — or reply with a couple of times that work.
>
> [SIGNATURE]

**Email 4.6 — Month 18**
Subject: **Eighteen months on — anything changed?**
Preheader: Plans, projects, or questions — a quick pulse check.

> Hi {{first_name}},
>
> Quick pulse check at the year-and-a-half mark. Around now, plans that were "someday" at closing
> start becoming "this year" — renovations, consolidating what crept back up, building a bigger
> cushion, or helping family.
>
> If any of that's on your list, a short conversation now beats a rushed one later. And if nothing's
> changed, that's a perfectly good answer too.
>
> Reply anytime, or grab a slot: **[Book a quick chat → booking link]**
>
> [SIGNATURE]

**Email 4.7 — Month 24: Annual review + referral**
Subject: **Two years, {{first_name}} — time for your review**
Preheader: Your annual equity review, plus a thank-you.

> Hi {{first_name}},
>
> Two years since we closed — which means annual review time again. Same drill as last year: ten
> minutes on where your home value, equity, and goals stand, and whether anything is worth
> adjusting. **[Book your review → booking link]**
>
> And a sincere thank-you: clients like you who stick around, ask good questions, and send friends
> my way are the reason Adaxa Home gets to do business the way we do. If someone in your circle
> needs straight answers about a mortgage or their equity this year, you know where I am —
> (480) 206 9290.
>
> [SIGNATURE]

## 8. Voicemail scripts

**VM 4.1 — Month 12 annual review call** *(~20 seconds)*
> Hi {{first_name}}, Mykoal DeShazo with Adaxa Home. It's been about a year since we closed, so I'm calling to set up your quick annual review — ten minutes to check that your equity position still fits your plans. Call or text me at (480) 206 9290 and we'll find a time. Talk soon.

**VM 4.2 — Month 24 annual review call** *(~15 seconds)*
> Hi {{first_name}}, Mykoal with Adaxa Home — two-year check-in and annual review time. Grab me at (480) 206 9290 whenever it's convenient and we'll knock it out in ten minutes. Hope all's well.

## 9. Notes for CRM automation
- **Reviews:** wire Email 4.2's button to your Google Business Profile review link. If the client
  leaves a review, tag `review_left` and suppress future review asks.
- **Referrals:** any referral received → tag the referrer `referral_source`, fire an immediate
  personal thank-you task (handwritten note or call — not automation), and log the referred
  contact's `referred_by`.
- **Annual review calls are tasks, not robocalls** — Months 12 and 24 should create call tasks
  with the VM scripts attached for no-answers.
- Add internal **birthday / loan-anniversary** triggers if the data exists; a personal one-line
  text from Mykoal outperforms any template.
- Quarterly emails after Month 24: rotate four evergreen themes (annual review, home-maintenance
  seasons, equity-strategy education, referral thank-you). Two asks per year maximum.

## 10. Recommended tags / statuses
`past_client`, `heloc_funded`, `review_left`, `referral_source`, `referred_by:{name}`. Status:
**Funded** (terminal sales status; this drip runs off the tag, not the pipeline).

## 11. Recommended branch logic
- Reply to any touch with a need ("actually, we're thinking about…") → create opportunity, run the
  sales process manually; never push a past client into the cold-lead drip.
- Review left → suppress review asks; escalate to referral track.
- Referral received → thank-you task within 24 hours + status report touches to the referrer as
  their referral progresses (ask permission first).
- No engagement across 24 months → continue quarterly email only; no SMS.

---

# WORKFLOW 5 — Use-Case Branches (Debt · Home Improvement · Reserves)

## 1. Workflow name
`HELOC Use-Case Branch — A: Debt Consolidation` ·
`HELOC Use-Case Branch — B: Home Improvement` ·
`HELOC Use-Case Branch — C: Cash Reserves`

## 2. Purpose
The moment a lead names a use case, generic nurture stops and relevance takes over. Each branch is
a short 7-day sequence that speaks directly to the named goal, earns the discovery call, and then
returns the lead to its parent workflow if still unbooked. These branches are where conversion
actually happens — protect their relevance.

## 3. Trigger
Use-case identified anywhere (keyword reply, form field, call note → manual tag):
`use_case_debt_consolidation` · `use_case_home_improvement` · `use_case_cash_reserve`.
Parent workflow **pauses** on entry.

## 4. Exit conditions
Master exits (book / apply / not interested / STOP), plus: Day 7 complete with no booking → resume
parent workflow at its next un-sent step, keep the use-case tag for all future personalization.

## 5. Timing / cadence table (same skeleton for all three branches)

| Step | Timing | Channel | Asset |
|------|--------|---------|-------|
| 1 | Hour 0 (on tag) | SMS | Branch SMS #1 — acknowledge + sharpen |
| 2 | Day 1 | Email | Branch email — the deep dive |
| 3 | Day 2 | Call + VM | Branch VM |
| 4 | Day 4 | SMS | Branch SMS #2 — concrete next step |
| 5 | Day 7 | SMS | Branch SMS #3 — decision nudge → return to parent |

## 6–8. Scripts by branch

### Branch A — Debt Consolidation

**SMS A1 (Hour 0)**
> Got it, {{first_name}} — debt payoff it is. The right way to look at this is the full picture: total balances, monthly outflow, and total long-term cost, not just one payment number. Roughly how much are you looking to consolidate? A ballpark is perfect.

**Email A (Day 1)**
Subject: **Using home equity for debt payoff — the honest version**
Preheader: The full-picture comparison, including the risks.

> Hi {{first_name}},
>
> Since debt consolidation is the goal, here's the honest version of how to evaluate it.
>
> A HELOC may let you consolidate higher-interest balances into one place. Done well, that can
> simplify your month and may reduce total interest cost. But the comparison has to be the **full
> picture**, on real numbers:
>
> - Current balances and what they cost you monthly
> - Total long-term cost of each path — not just the payment
> - Your available equity and credit profile
> - The big one: **a HELOC is secured by your home.** Moving unsecured debt onto your house is a
>   serious decision that deserves a careful review — and discipline afterward, so the old
>   balances don't rebuild on top of the new line.
>
> That's exactly what the review covers, with your actual numbers on the table. If consolidating
> still pencils out after that, you'll know — and if it doesn't, I'll tell you that too.
>
> **[See Your HELOC Options → booking link]**
>
> [SIGNATURE]

**VM A (Day 2)** *(~20 seconds)*
> Hi {{first_name}}, Mykoal with Adaxa Home. You mentioned debt consolidation, so I ran through what I'd want to check in your situation — it's a short list and worth ten minutes together before you decide anything. Call or text me at (480) 206 9290. Thanks.

**SMS A2 (Day 4)**
> {{first_name}}, the consolidation math takes about 10 minutes with three numbers: total balances, estimated home value, and current mortgage balance. Want to run it this week? I have time {{day_option_1}} or {{day_option_2}}. Reply STOP to opt out.

**SMS A3 (Day 7)**
> {{first_name}}, last nudge on the consolidation review — after this I'll just check in occasionally. If the balances are bugging you, ten minutes gets you a real answer either way. (480) 206 9290 or reply here. Reply STOP to opt out.

### Branch B — Home Improvement

**SMS B1 (Hour 0)**
> Love it, {{first_name}} — what's the project? Kitchen, roof, addition, pool, something else? And do you have a rough budget in mind yet? Even a range helps me frame what may be available.

**Email B (Day 1)**
Subject: **Funding the project without touching your first mortgage**
Preheader: Why project-funders look at HELOCs — and how to size one.

> Hi {{first_name}},
>
> Home projects are the classic HELOC use case, for two practical reasons:
>
> - **Your first mortgage stays put.** You fund the project from a separate line instead of
>   restructuring the loan on the whole house.
> - **You draw as the project bills, not all at once.** Contractors invoice in stages; a line that
>   funds in stages may fit better than a lump sum.
>
> Sizing it is straightforward: realistic project budget (plus a contingency cushion — projects
> grow) compared against your available equity. That's a ten-minute conversation with your
> estimated home value and current mortgage balance in hand.
>
> What's the project, and when do you want it done? Reply, or grab a time:
> **[See Your HELOC Options → booking link]**
>
> [SIGNATURE]

**VM B (Day 2)** *(~20 seconds)*
> Hi {{first_name}}, Mykoal with Adaxa Home. You mentioned a home project, and the useful next step is quick — sizing your budget against your available equity so you know what's workable before you get deep into contractor quotes. Call or text me at (480) 206 9290. Thanks.

**SMS B2 (Day 4)**
> {{first_name}}, contractor tip from the lending side: line up the financing review before the quotes get serious — it tells you your real budget and avoids re-scoping later. Want to knock out the equity review this week?

**SMS B3 (Day 7)**
> {{first_name}}, last nudge on the project financing — after this I'll just check in now and then. Whenever the project gets real, the review takes ten minutes: (480) 206 9290. Reply STOP to opt out.

### Branch C — Cash Reserves

**SMS C1 (Hour 0)**
> That's a smart angle, {{first_name}} — plenty of homeowners set up a line as a reserve before they need it rather than scrambling after. Are you thinking general safety net, or is there a specific "just in case" behind it?

**Email C (Day 1)**
Subject: **The reserve line: set it up before you need it**
Preheader: Why homeowners open a HELOC they don't plan to spend.

> Hi {{first_name}},
>
> The reserve strategy is the least flashy HELOC use case and arguably the most disciplined: open
> the line **before** you need it, draw little or nothing, and treat it as standby access to your
> own equity.
>
> Why before? Because lines are reviewed and approved based on your situation **at application** —
> your equity, income picture, and credit profile at their normal best. The moment you actually
> need emergency funds is often the hardest moment to qualify for them. Setting it up from a
> position of strength is the whole point.
>
> Whether it fits depends on your equity position, the costs involved in keeping a line open, and
> your alternatives — all of which is exactly what a short review covers, with no obligation to
> open anything.
>
> **[See Your HELOC Options → booking link]**
>
> [SIGNATURE]

**VM C (Day 2)** *(~20 seconds)*
> Hi {{first_name}}, Mykoal with Adaxa Home. You mentioned wanting equity access as a backup, which honestly is one of the smarter reasons people call me. Ten minutes and I can walk you through how the reserve approach works and whether it fits your situation. (480) 206 9290. Thanks.

**SMS C2 (Day 4)**
> {{first_name}}, the reserve review is quick: your available equity, what keeping a line open involves, and whether it beats your alternatives. Want to run through it this week? Reply STOP to opt out.

**SMS C3 (Day 7)**
> {{first_name}}, last nudge on the reserve idea — the best time to set up a safety net is when you don't need it yet. Whenever you're ready: (480) 206 9290, or reply here. Reply STOP to opt out.

## 9. Notes for CRM automation
- Branch entry must **pause the parent workflow** (GHL: remove from parent workflow + add to
  branch, with a "return" automation at branch end; HubSpot: use if/then branches inside one
  workflow instead).
- The use-case tag is permanent personalization: every future workflow (reactivation, past-client)
  should reference it where natural.
- A lead can switch branches if they name a different goal — replace the tag, don't stack
  conflicting active branches. Multiple goals → human conversation, not more automation.
- `{{day_option_1}}/{{day_option_2}}` in SMS A2: populate from calendar availability if your CRM
  supports it; otherwise replace with "tomorrow or Thursday"-style manual copy.

## 10. Recommended tags / statuses
`use_case_debt_consolidation` / `use_case_home_improvement` / `use_case_cash_reserve` (mutually
exclusive, persistent). Status: unchanged by branch entry (still governed by parent + master exits).

## 11. Recommended branch logic
- Booking from any branch step → Appointment workflow; parent stays paused/closed.
- Reply with numbers (balances, budget, home value) → hot: same-day call task, stop branch sends.
- Day 7 no booking → resume parent workflow; tag survives.

---

# MASTER CRM REFERENCE

## Pipeline statuses (one pipeline, in order)

| Status | Meaning |
|--------|---------|
| New Internet Lead | Created, no contact attempt yet (SLA clock running) |
| Attempting Contact | At least one attempt, no two-way contact yet |
| Contacted | Two-way contact achieved |
| Needs Follow-Up | Engaged; next step scheduled or stalled |
| Appointment Set | Discovery call booked |
| Application Started | App in progress |
| Application Complete | Submitted |
| In Processing | Underwriting / conditions |
| Funded | Closed and funded → Past Client drip |
| Nurture | Alive but not active (long-term) |
| Dead Lead | Exhausted or closed-out |
| Do Not Contact | Suppressed everywhere; never auto-reactivate |

## Tag taxonomy

| Group | Tags |
|-------|------|
| Source | `lead_source_facebook`, `lead_source_instagram`, `lead_source_google`, `lead_source_other` |
| Lifecycle | `heloc_new_lead`, `heloc_contacted`, `heloc_warm_engaged`, `heloc_no_response_14d`, `heloc_interested`, `heloc_not_interested`, `heloc_applied`, `heloc_funded`, `heloc_bad_contact`, `heloc_bad_contact_phone` |
| Use case | `use_case_debt_consolidation`, `use_case_home_improvement`, `use_case_cash_reserve` |
| Reactivation | `old_lead_reactivation`, `reactivation_band_a/b/c/d`, `reactivation_runs` (counter field) |
| Relationship | `past_client`, `review_left`, `referral_source`, `referred_by:{name}` |
| Objections | `objection_timing`, `objection_credit_pull` |
| Suppression | `dnc_sms`, `dnc_call`, `dnc_all` |

Conventions: lowercase snake_case; one lifecycle status at a time (pipeline), tags are additive
facts; never delete suppression tags.

## Master branch logic (global, evaluated on every inbound event)

1. **STOP / UNSUBSCRIBE / QUIT** → `dnc_sms`, suppress SMS everywhere, exit all workflows. "Stop
   calling" → `dnc_call`. Both → status **Do Not Contact**.
2. **Books appointment** → exit all sales workflows → Appointment workflow (confirmation, reminder
   at 24h and 1h, no-show recovery → Workflow 2).
3. **Application started/completed** → exit all marketing workflows → Application workflow
   (milestone updates only).
4. **Funded** → everything off → Workflow 4.
5. **Use-case keyword detected** (`debt/cards/consolidat*` · `remodel/roof/kitchen/pool/repair/
   addition/ADU/solar/project` · `reserve/backup/emergency/cushion`) → tag + Workflow 5 branch,
   pause parent.
6. **"Not interested"** → confirm gracefully (one message: *"Understood — I'll close this out.
   If anything changes, I'm at (480) 206 9290. Reply STOP to stop all texts."*), status **Nurture**,
   long-term quarterly email only.
7. **Any other human reply** → pause that workflow's pending sends, notify owner, require human
   touch before automation resumes.
8. **Hard bounce + failed SMS** → `heloc_bad_contact`, status **Dead Lead**, skip-trace queue
   (optional).
9. **No response at workflow end** → Workflow 1 → Nurture → Workflow 3 at Day 45; Workflow 2 →
   Workflow 3 (band B) after 30 days; Workflow 3 → Dead Lead (max 2 lifetime runs).

## CRM implementation notes (cross-platform)

- **GoHighLevel:** each workflow = one Workflow; master branch logic = a separate "Inbound Router"
  workflow triggered on Customer Replied with if/else on message body; tags drive enrollment;
  pipeline = Opportunities. Use "Stop on Reply" on every sales workflow.
- **HubSpot:** workflows with re-enrollment disabled; use-case branches as if/then inside the
  parent; suppression lists for `dnc_*`; reply-pause via "contact replied" goal criteria.
- **Salesforce:** Flows + a campaign per workflow; statuses = Lead Status / Opportunity Stage;
  keyword routing needs Einstein/Apex or a middleware step — or run messaging in a connected tool.
- **Shape / Jungo:** map statuses 1:1 to their mortgage pipelines; both support drip + status
  triggers natively; keyword branching may need manual disposition instead.
- **This repo's service:** each workflow = a CRM automation (`trigger` + ordered steps of
  `send_text` / `send_email` / `voicemail_drop` / `add_tag` / `set_status` / `wait` with
  `delayMinutes`). Texts route iMessage-first with SMS fallback automatically; voicemail drops are
  calling-hours gated; STOP handling and DNC are enforced at the service layer. Seed new flows
  disabled, edit copy in the Flows tab, then enable.
- **Reporting to stand up week one:** speed-to-lead (median minutes to first attempt), contact
  rate by source, reply rate per message (kill the worst performer monthly), booking rate,
  opt-out rate per workflow (investigate anything >2–3% on a single message).
- **Build order:** 1) Fresh Lead, 2) Inbound Router (master branch logic), 3) Use-Case Branches,
  4) Warm Engaged, 5) Past Client, 6) Reactivation (last — it needs list hygiene first).
