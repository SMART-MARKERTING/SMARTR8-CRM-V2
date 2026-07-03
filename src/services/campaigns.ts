/**
 * The drip campaigns (one per tagging Category). Authored as plain data so the same
 * source feeds the automation seeder (seedCampaigns) and any printed content tables.
 *
 * COMBINED set: the smartr8.com funnel copy for the product campaigns (Purchase,
 * Cash Out Refi, HELOC, Rate and Term Refi), a dedicated DSCR investor track, and the
 * General nurture catch-all. Each campaign is keyed to a Category, so a funnel lead
 * tagged (e.g.) DSCR enrolls only in the DSCR drip.
 *
 * Compliance is baked into the copy:
 *  - SMS message 1 identifies the sender (Mykoal DeShazo, Adaxa Home), states the reason
 *    (you asked about X at smartr8.com), carries NMLS 1912347, and includes
 *    "Reply STOP to opt out, HELP for help."
 *  - "Reply STOP to opt out" also appears mid-sequence (message 5) and on the final message.
 *  - No rate, APR, or monthly-payment figures (Reg Z / MAP trigger terms); no approval
 *    guarantees. We say "let us run your numbers" / "see your options".
 *  - Customer-facing copy contains NO dashes (hyphen, en, or em). Phone is (480) 206 9290.
 *  - The email signature + CAN-SPAM footer (physical address + a working unsubscribe link
 *    and List-Unsubscribe headers) are appended by the send_email executor (automations.ts
 *    + brand.ts), so they are not repeated in each email body here.
 *
 * Merge token: {{first_name}} is interpolated at send time. SMS without express consent
 * skips at send time, which yields an email-only nurture.
 */

import type { Category } from "./tagging";
import type { Step } from "./automations";

export interface SmsMsg {
  day: number;
  /** Optional minute offset inside the day for speed-to-lead touches. */
  minute?: number;
  text: string;
}
export interface EmailMsg {
  day: number;
  subject: string;
  preheader: string;
  body: string; // paragraphs separated by blank lines; signature + footer appended at send
  cta: { label: string; url?: string };
}
export interface Campaign {
  key: Category;
  name: string;
  sms: SmsMsg[];
  emails: EmailMsg[];
}

// Each campaign links back to the funnel page where the lead originated.
const F = {
  PURCHASE: "https://smartr8.com/purchase",
  CASHOUT: "https://smartr8.com/cash-out-refi",
  HELOC: "https://smartr8.com/heloc-v2",
  RT: "https://smartr8.com/rate-and-term-refi",
  DSCR: "https://smartr8.com/dscr",
  HOME: "https://smartr8.com",
};

export const CAMPAIGNS: Campaign[] = [
  {
    key: "PURCHASE",
    name: "Purchase Path",
    sms: [
      { day: 0, text: "Hi {{first_name}}, this is Mykoal DeShazo with Adaxa Home (NMLS 1912347). You asked about buying a home at smartr8.com. I can get you pre approved. Reply STOP to opt out, HELP for help." },
      { day: 1, text: "{{first_name}}, a strong pre approval helps you shop in your range and make offers sellers take seriously. Want me to get you started?" },
      { day: 3, text: "Tell me where you are looking and your rough budget, {{first_name}}, and let us run your numbers for a pre approval." },
      { day: 6, text: "{{first_name}}, first time buyer or moving up, I walk you through every step in plain language. Happy to answer any questions." },
      { day: 12, text: "Still getting ready, {{first_name}}? When you are set I can size up your pre approval fast. Reply STOP to opt out." },
      { day: 21, text: "{{first_name}}, I will keep your purchase request on file. Reach me anytime at (480) 206 9290. Reply STOP to opt out. Mykoal." },
    ],
    emails: [
      { day: 0, subject: "Let us get you pre approved, {{first_name}}", preheader: "A strong pre approval helps you shop with confidence and make offers that stand out.", cta: { label: "Get pre approved", url: F.PURCHASE },
        body: "Thanks for asking about buying a home at smartr8.com. The first step is a solid pre approval so you know your range and sellers take your offers seriously.\n\nTell me where you are looking and your rough budget and let us run your numbers." },
      { day: 4, subject: "Buying your first home or your next one", preheader: "We guide first time buyers and move up buyers through every step.", cta: { label: "Start my pre approval", url: F.PURCHASE },
        body: "However you are buying, I am here to make it simple. First time buyers get clear guidance and programs that fit. Move up buyers get help lining up the timing so it works. And every offer is backed by a clean, well prepared file.\n\nReply and tell me your goal and let us run your numbers." },
      { day: 14, subject: "Ready when you are, {{first_name}}", preheader: "Your pre approval is a quick conversation away.", cta: { label: "Get pre approved", url: F.PURCHASE },
        body: "House hunting takes time. Whenever you want to get pre approved or refresh your numbers, I can turn it around quickly.\n\nCall or text me anytime at (480) 206 9290." },
    ],
  },

  {
    key: "CASHOUT_REFI",
    name: "Cash Out Refi",
    sms: [
      { day: 0, text: "Hi {{first_name}}, Mykoal DeShazo with Adaxa Home (NMLS 1912347). You asked about a cash out refinance at smartr8.com. I can show your options with no credit pull. Reply STOP to opt out, HELP for help." },
      { day: 1, text: "{{first_name}}, a cash out refinance replaces your mortgage and hands you the difference as cash. Want me to see what you could pull?" },
      { day: 3, text: "Many people use cash out to consolidate higher interest debt into one payment, {{first_name}}. Tell me your goal and let us run your numbers." },
      { day: 6, text: "{{first_name}}, cash out can also fund a project or build reserves you can lean on. Happy to walk through what makes sense." },
      { day: 12, text: "Still thinking it through, {{first_name}}? When you are ready I can pull your cash out options fast. Reply STOP to opt out." },
      { day: 21, text: "{{first_name}}, I will keep your cash out request on file. Reach me anytime at (480) 206 9290. Reply STOP to opt out. Mykoal." },
    ],
    emails: [
      { day: 0, subject: "Turn your equity into cash, {{first_name}}", preheader: "A cash out refinance replaces your mortgage and gives you the difference.", cta: { label: "See my cash out options", url: F.CASHOUT },
        body: "Thanks for asking about a cash out refinance at smartr8.com. It replaces your current mortgage with a new one and gives you the difference in cash, with one payment instead of a separate second loan.\n\nTell me what you have in mind, debt consolidation, a project, or reserves, and let us run your numbers." },
      { day: 4, subject: "Ways people put cash out to work", preheader: "Consolidate debt, fund a project, or build a cushion.", cta: { label: "Talk through my options", url: F.CASHOUT },
        body: "Cash out gives you flexibility. Some consolidate higher interest balances into one payment. Some fund a renovation, tuition, or a business move. Others build reserves for peace of mind.\n\nReply and tell me your goal and let us run your numbers." },
      { day: 14, subject: "Still here when you are ready, {{first_name}}", preheader: "Your cash out options are a quick conversation away.", cta: { label: "See my options", url: F.CASHOUT },
        body: "No rush. When you want to see how much equity you could put to work, I can pull your cash out options quickly with no credit pull to start.\n\nCall or text me anytime at (480) 206 9290." },
    ],
  },

  {
    key: "HELOC",
    name: "HELOC",
    sms: [
      { day: 0, text: "Hi {{first_name}}, Mykoal DeShazo with Adaxa Home (NMLS 1912347). You asked about a HELOC at smartr8.com. I can pull your options together with no credit pull. Reply STOP to opt out, HELP for help." },
      { day: 0, minute: 4, text: "{{first_name}}, I just wanted to confirm the information I received is correct. The current mortgage balance we have is {{mortgage_balance}}, and the estimated home value we have is {{home_value}}. Is that correct? I also just sent an email with the quote based on that information, but I want to make sure we have the right details so you receive the correct quote." },
      { day: 1, text: "{{first_name}}, a HELOC lets you tap your equity without touching your first mortgage rate. Want me to see what you qualify for? Just reply here." },
      { day: 3, text: "Lots of folks use a HELOC for renovations or to pay off higher interest debt, {{first_name}}. Tell me your goal and let us run your numbers." },
      { day: 6, text: "{{first_name}}, a HELOC can also sit as a standby safety net you only tap if you need it. Happy to walk you through how it works." },
      { day: 12, text: "Still thinking it over, {{first_name}}? No pressure. When you are ready I can show your HELOC options in minutes. Reply STOP to opt out." },
      { day: 21, text: "{{first_name}}, I will keep your HELOC request on file. Reach me anytime at (480) 206 9290. Reply STOP to opt out. Mykoal." },
    ],
    emails: [
      { day: 0, subject: "Your HELOC options, {{first_name}}", preheader: "A quick look at tapping your equity without refinancing your first mortgage.", cta: { label: "See my HELOC options", url: F.HELOC },
        body: "Thanks for asking about a HELOC at smartr8.com. A home equity line of credit lets you borrow against your equity as a flexible line you draw from when you need it, without touching your first mortgage.\n\nTell me what you have in mind, renovations, paying off higher interest debt, or a standby safety net, and let us run your numbers together." },
      { day: 4, subject: "Smart ways people use a HELOC", preheader: "Renovations, debt payoff, and a flexible safety net.", cta: { label: "Talk through my options", url: F.HELOC },
        body: "A HELOC is flexible, so people put it to work in different ways. Some fund a renovation or addition. Others pay off higher interest balances to simplify. Many keep a standby line ready for emergencies.\n\nNot sure which fits? That is what I am here for. Reply and tell me your goal." },
      { day: 14, subject: "Still here when you are ready, {{first_name}}", preheader: "Your HELOC options are a quick conversation away.", cta: { label: "See my options", url: F.HELOC },
        body: "No rush at all. When you want to see what your equity could do, I can put your HELOC options together quickly with no credit pull to start.\n\nCall or text me anytime at (480) 206 9290." },
    ],
  },

  {
    key: "RATE_TERM_REFI",
    name: "Rate and Term Refi",
    sms: [
      { day: 0, text: "Hi {{first_name}}, Mykoal DeShazo with Adaxa Home (NMLS 1912347). You asked about a rate and term refinance at smartr8.com. Let us see your options. Reply STOP to opt out, HELP for help." },
      { day: 1, text: "{{first_name}}, a rate and term refinance reworks your loan with no cash out, just a better rate, term, or payment. Want me to take a look?" },
      { day: 3, text: "If the market or your credit has moved, refinancing may help your payment, {{first_name}}. Send your goal and let us run your numbers." },
      { day: 6, text: "{{first_name}}, a refinance can also shorten your term or drop mortgage insurance once you have the equity. Happy to explain the tradeoffs." },
      { day: 12, text: "Still weighing it, {{first_name}}? When you are ready I can show your refinance options fast. Reply STOP to opt out." },
      { day: 21, text: "{{first_name}}, I will keep your refinance request on file. Reach me anytime at (480) 206 9290. Reply STOP to opt out. Mykoal." },
    ],
    emails: [
      { day: 0, subject: "Reset your mortgage to fit today, {{first_name}}", preheader: "Lower your payment, shorten your term, or drop mortgage insurance. No cash out.", cta: { label: "See my refinance options", url: F.RT },
        body: "Thanks for asking about a rate and term refinance at smartr8.com. This reworks your existing loan with no cash out, so it is built purely around a better rate, term, or payment.\n\nTell me your goal and let us run your numbers to see if it makes sense for you." },
      { day: 4, subject: "Three reasons people refinance", preheader: "Payment, term, and mortgage insurance.", cta: { label: "Talk through my options", url: F.RT },
        body: "A rate and term refinance can help in a few ways. It can ease your monthly payment. It can shorten your term so you own your home sooner. And it can drop mortgage insurance once you have the equity.\n\nReply with your goal and let us run your numbers." },
      { day: 14, subject: "Here when the timing is right, {{first_name}}", preheader: "Your refinance options are a quick conversation away.", cta: { label: "See my options", url: F.RT },
        body: "No pressure on timing. When you want to check whether a refinance helps, I can put your options together quickly.\n\nCall or text me anytime at (480) 206 9290." },
    ],
  },

  {
    key: "DSCR",
    name: "DSCR Investor",
    sms: [
      { day: 0, text: "Hi {{first_name}}, Mykoal DeShazo with Adaxa Home (NMLS 1912347). You asked about a DSCR loan at smartr8.com. These qualify on the rental cash flow, not your tax returns. Reply STOP to opt out, HELP for help." },
      { day: 1, text: "{{first_name}}, with DSCR there are no W2s or tax returns to dig up. We look at what the property earns. Want me to run your scenario?" },
      { day: 3, text: "Tell me the property and the rough rent, {{first_name}}, and let us run your numbers to see how it pencils out." },
      { day: 6, text: "{{first_name}}, DSCR is built to help investors keep buying without hitting income walls. Happy to map out your next purchase." },
      { day: 12, text: "Still weighing it, {{first_name}}? When you are ready I can show your DSCR options fast. Reply STOP to opt out." },
      { day: 21, text: "{{first_name}}, I will keep your DSCR request on file. Reach me anytime at (480) 206 9290. Reply STOP to opt out. Mykoal." },
    ],
    emails: [
      { day: 0, subject: "Financing that qualifies on the rent, {{first_name}}", preheader: "DSCR loans look at the property cash flow, not your personal income docs.", cta: { label: "See my DSCR options", url: F.DSCR },
        body: "Thanks for asking about a DSCR loan at smartr8.com. DSCR financing qualifies on the property rental cash flow against its payment, so there are no pay stubs, W2s, or tax returns to hand over.\n\nSend me the property and the rough rent and let us run your numbers to see how it fits." },
      { day: 4, subject: "Built for investors who want to keep buying", preheader: "Scale your portfolio without income walls.", cta: { label: "Talk through a scenario", url: F.DSCR },
        body: "DSCR loans are designed for real estate investors. They qualify on the rental cash flow, not your returns. They work for single family homes, condos, two to four units, and many short term rentals. And they leave you room to keep growing your portfolio.\n\nTell me what you are looking at next and let us run your numbers." },
      { day: 14, subject: "Ready when your next deal is, {{first_name}}", preheader: "Your DSCR options are a quick conversation away.", cta: { label: "See my options", url: F.DSCR },
        body: "Whenever you spot your next rental, I can move quickly on DSCR financing so you do not lose the deal to paperwork.\n\nCall or text me anytime at (480) 206 9290." },
    ],
  },

  {
    key: "GENERAL",
    name: "General Nurture",
    sms: [
      { day: 0, text: "Hi {{first_name}}, this is Mykoal DeShazo with Adaxa Home (NMLS 1912347). Thanks for reaching out at smartr8.com. Reply STOP to opt out, HELP for help." },
      { day: 3, text: "{{first_name}}, whatever your goal, buying, refinancing, or an investment property, I can help you find the right path. Want a quick call?" },
      { day: 7, text: "Happy to answer any mortgage questions you have, no obligation. Reply here or call (480) 206 9290 any time. Mykoal." },
      { day: 12, text: "Even if you are just exploring, a short conversation can clarify your options. What time works this week? Mykoal." },
      { day: 16, text: "{{first_name}}, I am glad to be a resource whenever you need one. Call (480) 206 9290 with any questions. Reply STOP to opt out. Mykoal." },
      { day: 21, text: "{{first_name}}, reach out any time and I will point you in the right direction. Call (480) 206 9290. Reply STOP to opt out. Mykoal." },
    ],
    emails: [
      { day: 0, subject: "Thanks for reaching out", preheader: "However I can help, I am glad to be your resource.", cta: { label: "See my options", url: F.HOME },
        body: "Thanks for getting in touch. Whether you are buying, refinancing, exploring an investment property, or simply have questions, my job is to make it clear and easy.\n\nWhen is a good time for a short call? There is no obligation, just helpful answers." },
      { day: 6, subject: "A quick question for you, {{first_name}}", preheader: "Knowing your goal helps me point you the right way.", cta: { label: "Tell me your goal", url: F.HOME },
        body: "Everyone comes to us with a different goal. Knowing yours helps me share the most useful next steps, whether that is a purchase, a refinance, or financing an investment property.\n\nReply and tell me what you are thinking about, and I will guide you from there." },
      { day: 14, subject: "Here to help whenever you need it", preheader: "A short conversation can clarify your options.", cta: { label: "Call (480) 206 9290", url: F.HOME },
        body: "Even if you are early in the process, a quick conversation often brings clarity and saves time later.\n\nReply to this email or call (480) 206 9290 whenever you are ready, and I will help you find the right path." },
    ],
  },
];

/** Past-client remarketing: email-heavy, ONE light text. Fires on the `past_client`
 *  trigger (not category-keyed). Seeded disabled — enable + edit copy in Flows. */
export const REMARKETING: { name: string; emails: EmailMsg[]; sms: SmsMsg[] } = {
  name: "Remarketing — Past Clients",
  emails: [
    { day: 0, subject: "Checking in, {{first_name}}", preheader: "A quick mortgage check-up, whenever you're ready.", cta: { label: "See current options", url: F.HOME },
      body: "Hi {{first_name}}, it's Mykoal at Adaxa Home. Just checking in — rates and home values move, and I'm always glad to run a quick, no-pressure review of where you stand.\n\nIf now's a good time, reply here or tap below and I'll take a look." },
    { day: 10, subject: "Rates move — worth a quick look?", preheader: "A small rate change can mean real monthly savings.", cta: { label: "Check my rate", url: F.RT },
      body: "{{first_name}}, even a small drop in rate can free up real money each month, or shorten your term. I'll compare your current loan to today's options and tell you honestly whether it's worth doing.\n\nNo cost, no obligation — just a clear answer." },
    { day: 30, subject: "Know someone who could use a hand?", preheader: "Referrals are the best compliment.", cta: { label: "Refer a friend", url: F.HOME },
      body: "{{first_name}}, if a friend or family member is thinking about buying, refinancing, or tapping equity, I'd be glad to help them the same way I helped you. A quick intro is all it takes — and thank you for trusting me with your business." },
    { day: 60, subject: "Your annual mortgage review", preheader: "A yearly check-up keeps your loan working for you.", cta: { label: "Book my review", url: F.HOME },
      body: "{{first_name}}, it's a good habit to review your mortgage once a year — rate, term, equity, and goals. I'll do the heavy lifting and send a simple summary. Want me to put one together?" },
  ],
  sms: [
    { day: 20, text: "Hi {{first_name}}, Mykoal here — happy to do a quick mortgage check-up anytime, no rush. Reply whenever works." },
  ],
};

/**
 * Convert a campaign into ordered automation Steps with cumulative delays (in minutes).
 * Email and SMS are merged on a single day timeline so both schedule correctly; SMS
 * steps that lack consent skip at send time, which yields the email-only nurture.
 */
export function campaignToSteps(c: { emails: EmailMsg[]; sms: SmsMsg[] }, includeDay0 = false): Step[] {
  type Timed = { day: number; step: Step };
  const timed: Timed[] = [];
  for (const e of c.emails) {
    // Day 0 is the funnel's branded transactional welcome (leadEmail.ts on smartr8),
    // so the drip's own emails start later — leads never get two welcome emails. Remarketing
    // has no funnel welcome, so it passes includeDay0=true to keep its day-0 email.
    if (e.day === 0 && !includeDay0) continue;
    timed.push({
      day: e.day,
      step: { type: "send_email", subject: e.subject, preheader: e.preheader, html: e.body, text: e.body, ctaLabel: e.cta.label, ctaUrl: e.cta.url },
    });
  }
  for (const m of c.sms) {
    timed.push({ day: m.day + (m.minute ?? 0) / (24 * 60), step: { type: "send_text", message: m.text } });
  }
  timed.sort((a, b) => a.day - b.day);
  let prevMinute = 0;
  return timed.map((t, i) => {
    const currentMinute = Math.round(t.day * 24 * 60);
    const delayMinutes = i === 0 ? currentMinute : Math.max(0, currentMinute - prevMinute);
    prevMinute = currentMinute;
    return { ...t.step, delayMinutes };
  });
}
