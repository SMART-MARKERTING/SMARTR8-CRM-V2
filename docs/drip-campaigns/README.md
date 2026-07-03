# Drip Campaigns (importable)

For the full multi-workflow HELOC playbook (fresh leads, warm re-engage, old-lead reactivation, past-client drip, use-case branches, master tags/statuses/routing), see [`../heloc-follow-up-system.md`](../heloc-follow-up-system.md).

Source of truth: `src/services/campaigns.ts`. These campaigns are seeded into the CRM as DISABLED `lead_created` automations (one per category) by `seedCampaigns()`; enable and edit them in the Flows tab. Each `<CATEGORY>.json` here is the portable block and also embeds the exact `POST /api/automations` payload (`crmAutomation`).

Categories (a funnel `loanType` or a message keyword maps to one): PURCHASE, CASHOUT_REFI, HELOC, RATE_TERM_REFI, DSCR, GENERAL.

The day-0 EMAIL is intentionally not part of the drip: the funnel sends a branded transactional welcome (smartr8 `functions/_lib/leadEmail.ts`), so the drip's own emails start later. The day-0 SMS still sends (to consented leads).

SMS counts assume GSM-7 and render {{first_name}} as "Jordan" (6 chars).

## Purchase Path (category: `PURCHASE`)

### SMS

| Day | Chars | Segs | Opt-out | Message |
|----:|------:|-----:|:-------:|---------|
| 0 | 177 | 2 | yes | Hi {{first_name}}, this is Mykoal DeShazo with Adaxa Home (NMLS 1912347). You asked about buying a home at smartr8.com. I can get you pre approved. Reply STOP to opt out, HELP for help. |
| 1 | 126 | 1 |  | {{first_name}}, a strong pre approval helps you shop in your range and make offers sellers take seriously. Want me to get you started? |
| 3 | 108 | 1 |  | Tell me where you are looking and your rough budget, {{first_name}}, and let us run your numbers for a pre approval. |
| 6 | 118 | 1 |  | {{first_name}}, first time buyer or moving up, I walk you through every step in plain language. Happy to answer any questions. |
| 12 | 106 | 1 | yes | Still getting ready, {{first_name}}? When you are set I can size up your pre approval fast. Reply STOP to opt out. |
| 21 | 117 | 1 | yes | {{first_name}}, I will keep your purchase request on file. Reach me anytime at (480) 206 9290. Reply STOP to opt out. Mykoal. |

### Email (drip; day-0 welcome is sent by the funnel)

**Day 4: Buying your first home or your next one**

- Preheader: We guide first time buyers and move up buyers through every step.
- CTA: Start my pre approval (https://smartr8.com/purchase)

```
However you are buying, I am here to make it simple. First time buyers get clear guidance and programs that fit. Move up buyers get help lining up the timing so it works. And every offer is backed by a clean, well prepared file.

Reply and tell me your goal and let us run your numbers.
```

**Day 14: Ready when you are, {{first_name}}**

- Preheader: Your pre approval is a quick conversation away.
- CTA: Get pre approved (https://smartr8.com/purchase)

```
House hunting takes time. Whenever you want to get pre approved or refresh your numbers, I can turn it around quickly.

Call or text me anytime at (480) 206 9290.
```


## Cash Out Refi (category: `CASHOUT_REFI`)

### SMS

| Day | Chars | Segs | Opt-out | Message |
|----:|------:|-----:|:-------:|---------|
| 0 | 193 | 2 | yes | Hi {{first_name}}, Mykoal DeShazo with Adaxa Home (NMLS 1912347). You asked about a cash out refinance at smartr8.com. I can show your options with no credit pull. Reply STOP to opt out, HELP for help. |
| 1 | 125 | 1 |  | {{first_name}}, a cash out refinance replaces your mortgage and hands you the difference as cash. Want me to see what you could pull? |
| 3 | 133 | 1 |  | Many people use cash out to consolidate higher interest debt into one payment, {{first_name}}. Tell me your goal and let us run your numbers. |
| 6 | 115 | 1 |  | {{first_name}}, cash out can also fund a project or build reserves you can lean on. Happy to walk through what makes sense. |
| 12 | 115 | 1 | yes | Still thinking it through, {{first_name}}? When you are ready I can pull your cash out options fast. Reply STOP to opt out. |
| 21 | 117 | 1 | yes | {{first_name}}, I will keep your cash out request on file. Reach me anytime at (480) 206 9290. Reply STOP to opt out. Mykoal. |

### Email (drip; day-0 welcome is sent by the funnel)

**Day 4: Ways people put cash out to work**

- Preheader: Consolidate debt, fund a project, or build a cushion.
- CTA: Talk through my options (https://smartr8.com/cash-out-refi)

```
Cash out gives you flexibility. Some consolidate higher interest balances into one payment. Some fund a renovation, tuition, or a business move. Others build reserves for peace of mind.

Reply and tell me your goal and let us run your numbers.
```

**Day 14: Still here when you are ready, {{first_name}}**

- Preheader: Your cash out options are a quick conversation away.
- CTA: See my options (https://smartr8.com/cash-out-refi)

```
No rush. When you want to see how much equity you could put to work, I can pull your cash out options quickly with no credit pull to start.

Call or text me anytime at (480) 206 9290.
```


## HELOC (category: `HELOC`)

### SMS

| Day | Chars | Segs | Opt-out | Message |
|----:|------:|-----:|:-------:|---------|
| 0 | 189 | 2 | yes | Hi {{first_name}}, Mykoal DeShazo with Adaxa Home (NMLS 1912347). You asked about a HELOC at smartr8.com. I can pull your options together with no credit pull. Reply STOP to opt out, HELP for help. |
| 1 | 137 | 1 |  | {{first_name}}, a HELOC lets you tap your equity without touching your first mortgage rate. Want me to see what you qualify for? Just reply here. |
| 3 | 132 | 1 |  | Lots of folks use a HELOC for renovations or to pay off higher interest debt, {{first_name}}. Tell me your goal and let us run your numbers. |
| 6 | 121 | 1 |  | {{first_name}}, a HELOC can also sit as a standby safety net you only tap if you need it. Happy to walk you through how it works. |
| 12 | 128 | 1 | yes | Still thinking it over, {{first_name}}? No pressure. When you are ready I can show your HELOC options in minutes. Reply STOP to opt out. |
| 21 | 114 | 1 | yes | {{first_name}}, I will keep your HELOC request on file. Reach me anytime at (480) 206 9290. Reply STOP to opt out. Mykoal. |

### Email (drip; day-0 welcome is sent by the funnel)

**Day 4: Smart ways people use a HELOC**

- Preheader: Renovations, debt payoff, and a flexible safety net.
- CTA: Talk through my options (https://smartr8.com/heloc-v2)

```
A HELOC is flexible, so people put it to work in different ways. Some fund a renovation or addition. Others pay off higher interest balances to simplify. Many keep a standby line ready for emergencies.

Not sure which fits? That is what I am here for. Reply and tell me your goal.
```

**Day 14: Still here when you are ready, {{first_name}}**

- Preheader: Your HELOC options are a quick conversation away.
- CTA: See my options (https://smartr8.com/heloc-v2)

```
No rush at all. When you want to see what your equity could do, I can put your HELOC options together quickly with no credit pull to start.

Call or text me anytime at (480) 206 9290.
```


## Rate and Term Refi (category: `RATE_TERM_REFI`)

### SMS

| Day | Chars | Segs | Opt-out | Message |
|----:|------:|-----:|:-------:|---------|
| 0 | 178 | 2 | yes | Hi {{first_name}}, Mykoal DeShazo with Adaxa Home (NMLS 1912347). You asked about a rate and term refinance at smartr8.com. Let us see your options. Reply STOP to opt out, HELP for help. |
| 1 | 131 | 1 |  | {{first_name}}, a rate and term refinance reworks your loan with no cash out, just a better rate, term, or payment. Want me to take a look? |
| 3 | 126 | 1 |  | If the market or your credit has moved, refinancing may help your payment, {{first_name}}. Send your goal and let us run your numbers. |
| 6 | 131 | 1 |  | {{first_name}}, a refinance can also shorten your term or drop mortgage insurance once you have the equity. Happy to explain the tradeoffs. |
| 12 | 108 | 1 | yes | Still weighing it, {{first_name}}? When you are ready I can show your refinance options fast. Reply STOP to opt out. |
| 21 | 118 | 1 | yes | {{first_name}}, I will keep your refinance request on file. Reach me anytime at (480) 206 9290. Reply STOP to opt out. Mykoal. |

### Email (drip; day-0 welcome is sent by the funnel)

**Day 4: Three reasons people refinance**

- Preheader: Payment, term, and mortgage insurance.
- CTA: Talk through my options (https://smartr8.com/rate-and-term-refi)

```
A rate and term refinance can help in a few ways. It can ease your monthly payment. It can shorten your term so you own your home sooner. And it can drop mortgage insurance once you have the equity.

Reply with your goal and let us run your numbers.
```

**Day 14: Here when the timing is right, {{first_name}}**

- Preheader: Your refinance options are a quick conversation away.
- CTA: See my options (https://smartr8.com/rate-and-term-refi)

```
No pressure on timing. When you want to check whether a refinance helps, I can put your options together quickly.

Call or text me anytime at (480) 206 9290.
```


## DSCR Investor (category: `DSCR`)

### SMS

| Day | Chars | Segs | Opt-out | Message |
|----:|------:|-----:|:-------:|---------|
| 0 | 200 | 2 | yes | Hi {{first_name}}, Mykoal DeShazo with Adaxa Home (NMLS 1912347). You asked about a DSCR loan at smartr8.com. These qualify on the rental cash flow, not your tax returns. Reply STOP to opt out, HELP for help. |
| 1 | 126 | 1 |  | {{first_name}}, with DSCR there are no W2s or tax returns to dig up. We look at what the property earns. Want me to run your scenario? |
| 3 | 103 | 1 |  | Tell me the property and the rough rent, {{first_name}}, and let us run your numbers to see how it pencils out. |
| 6 | 118 | 1 |  | {{first_name}}, DSCR is built to help investors keep buying without hitting income walls. Happy to map out your next purchase. |
| 12 | 103 | 1 | yes | Still weighing it, {{first_name}}? When you are ready I can show your DSCR options fast. Reply STOP to opt out. |
| 21 | 113 | 1 | yes | {{first_name}}, I will keep your DSCR request on file. Reach me anytime at (480) 206 9290. Reply STOP to opt out. Mykoal. |

### Email (drip; day-0 welcome is sent by the funnel)

**Day 4: Built for investors who want to keep buying**

- Preheader: Scale your portfolio without income walls.
- CTA: Talk through a scenario (https://smartr8.com/dscr)

```
DSCR loans are designed for real estate investors. They qualify on the rental cash flow, not your returns. They work for single family homes, condos, two to four units, and many short term rentals. And they leave you room to keep growing your portfolio.

Tell me what you are looking at next and let us run your numbers.
```

**Day 14: Ready when your next deal is, {{first_name}}**

- Preheader: Your DSCR options are a quick conversation away.
- CTA: See my options (https://smartr8.com/dscr)

```
Whenever you spot your next rental, I can move quickly on DSCR financing so you do not lose the deal to paperwork.

Call or text me anytime at (480) 206 9290.
```


## General Nurture (category: `GENERAL`)

### SMS

| Day | Chars | Segs | Opt-out | Message |
|----:|------:|-----:|:-------:|---------|
| 0 | 143 | 1 | yes | Hi {{first_name}}, this is Mykoal DeShazo with Adaxa Home (NMLS 1912347). Thanks for reaching out at smartr8.com. Reply STOP to opt out, HELP for help. |
| 3 | 130 | 1 |  | {{first_name}}, whatever your goal, buying, refinancing, or an investment property, I can help you find the right path. Want a quick call? |
| 7 | 115 | 1 |  | Happy to answer any mortgage questions you have, no obligation. Reply here or call (480) 206 9290 any time. Mykoal. |
| 12 | 113 | 1 |  | Even if you are just exploring, a short conversation can clarify your options. What time works this week? Mykoal. |
| 16 | 128 | 1 | yes | {{first_name}}, I am glad to be a resource whenever you need one. Call (480) 206 9290 with any questions. Reply STOP to opt out. Mykoal. |
| 21 | 123 | 1 | yes | {{first_name}}, reach out any time and I will point you in the right direction. Call (480) 206 9290. Reply STOP to opt out. Mykoal. |

### Email (drip; day-0 welcome is sent by the funnel)

**Day 6: A quick question for you, {{first_name}}**

- Preheader: Knowing your goal helps me point you the right way.
- CTA: Tell me your goal (https://smartr8.com)

```
Everyone comes to us with a different goal. Knowing yours helps me share the most useful next steps, whether that is a purchase, a refinance, or financing an investment property.

Reply and tell me what you are thinking about, and I will guide you from there.
```

**Day 14: Here to help whenever you need it**

- Preheader: A short conversation can clarify your options.
- CTA: Call (480) 206 9290 (https://smartr8.com)

```
Even if you are early in the process, a quick conversation often brings clarity and saves time later.

Reply to this email or call (480) 206 9290 whenever you are ready, and I will help you find the right path.
```


