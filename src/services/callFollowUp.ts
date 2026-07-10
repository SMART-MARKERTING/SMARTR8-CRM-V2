import type { MortgageCallSummary, CallSummaryRow } from "./callSummary";
import type { Lead } from "./leads";

export type CallOutcome =
  | "connected"
  | "callback_requested"
  | "documents_requested"
  | "not_interested"
  | "wrong_number"
  | "do_not_contact"
  | "no_answer_or_voicemail"
  | "needs_review";

export type FollowUpPriority = "low" | "normal" | "high" | "urgent_review";

export interface CallFollowUpRecommendation {
  outcome: CallOutcome;
  priority: FollowUpPriority;
  nextAction: string;
  taskTitle: string | null;
  dueAt: number | null;
  reasons: string[];
  permittedChannels: Array<"email" | "sms" | "manual_phone_review">;
  blockedAutomations: string[];
  humanReviewRequired: true;
  consumerContactedAutomatically: false;
}

function combinedText(summary: MortgageCallSummary): string {
  return [
    summary.short_summary,
    summary.detailed_summary,
    summary.crm_note,
    ...summary.next_steps,
    ...summary.objections_or_concerns,
    ...summary.compliance_flags,
  ].join(" ").toLowerCase();
}

function explicitOutcome(summary: MortgageCallSummary, durationSeconds: number | null): CallOutcome {
  const text = combinedText(summary);
  if (/do not (?:call|contact|text)|stop (?:calling|contacting|texting)|opt[ -]?out|revoked consent/.test(text)) return "do_not_contact";
  if (/wrong number|not the (?:right )?person|does not know/.test(text)) return "wrong_number";
  if (/not interested|no longer interested|declined to proceed/.test(text)) return "not_interested";
  if (/no answer|left (?:a )?voicemail|went to voicemail|voicemail only/.test(text) || durationSeconds === 0) return "no_answer_or_voicemail";
  if (summary.compliance_flags.length) return "needs_review";
  if (summary.documents_requested.length) return "documents_requested";
  if (summary.follow_up_needed || /call back|callback|follow up|follow-up/.test(text)) return "callback_requested";
  return "connected";
}

function dueAtFor(summary: MortgageCallSummary, outcome: CallOutcome, now: number): number | null {
  if (outcome === "do_not_contact" || outcome === "wrong_number" || outcome === "not_interested") return null;
  if (summary.follow_up_date) {
    const parsed = Date.parse(summary.follow_up_date);
    if (Number.isFinite(parsed)) return parsed;
    if (/tomorrow/i.test(summary.follow_up_date)) {
      const date = new Date(now);
      date.setDate(date.getDate() + 1);
      date.setHours(9, 0, 0, 0);
      return date.getTime();
    }
  }
  if (outcome === "needs_review") return now;
  if (summary.follow_up_needed || outcome === "documents_requested" || outcome === "callback_requested") return now + 24 * 60 * 60 * 1000;
  return null;
}

function channelsFor(lead: Lead, outcome: CallOutcome): CallFollowUpRecommendation["permittedChannels"] {
  if (outcome === "do_not_contact" || outcome === "wrong_number") return [];
  const channels: CallFollowUpRecommendation["permittedChannels"] = ["manual_phone_review"];
  if (lead.consent === 1 && lead.email && lead.email_unsubscribed !== 1) channels.push("email");
  if (lead.sms_consent === 1 && lead.phone) channels.push("sms");
  return channels;
}

export function buildCallFollowUpRecommendation(
  summary: MortgageCallSummary,
  lead: Lead,
  row: Pick<CallSummaryRow, "duration_seconds">,
  now = Date.now(),
): CallFollowUpRecommendation {
  const outcome = explicitOutcome(summary, row.duration_seconds);
  const dueAt = dueAtFor(summary, outcome, now);
  const reasons: string[] = [];
  const blockedAutomations = ["autonomous_call", "autonomous_email", "autonomous_sms", "rate_or_payment_quote", "credit_decision"];
  let priority: FollowUpPriority = "normal";
  let nextAction = "Review the call summary and choose the next compliant CRM step.";
  let taskTitle: string | null = "Review post-call recommendation";

  if (outcome === "do_not_contact") {
    priority = "urgent_review";
    nextAction = "Review the explicit opt-out immediately, suppress outreach, and update the appropriate consent/DNC records.";
    taskTitle = "Review call opt-out and suppress outreach";
    reasons.push("The call summary contains explicit do-not-contact or opt-out language.");
  } else if (outcome === "wrong_number") {
    priority = "high";
    nextAction = "Verify the phone number, stop outreach to this number, and correct or merge the CRM record.";
    taskTitle = "Review wrong-number call outcome";
    reasons.push("The call summary identifies a wrong or unrelated number.");
  } else if (outcome === "needs_review") {
    priority = "urgent_review";
    nextAction = "Have a licensed operator review the compliance flags before any follow-up is attempted.";
    taskTitle = "Review call compliance flags";
    reasons.push(`${summary.compliance_flags.length} compliance or risk flag(s) require human review.`);
  } else if (outcome === "documents_requested") {
    priority = summary.lead_temperature === "Hot" ? "high" : "normal";
    nextAction = `Review and send the approved secure document request for: ${summary.documents_requested.join(", ")}.`;
    taskTitle = "Review requested borrower documents";
    reasons.push("The conversation identified documents needed for the next step.");
  } else if (outcome === "callback_requested") {
    priority = summary.lead_temperature === "Hot" ? "high" : "normal";
    nextAction = "Review the requested timing and schedule a licensed human callback.";
    taskTitle = "Schedule requested call follow-up";
    reasons.push("The borrower or loan officer identified a follow-up step.");
  } else if (outcome === "not_interested") {
    priority = "low";
    nextAction = "Review the disposition and move the lead to an appropriate closed or nurture state without automated outreach.";
    taskTitle = "Review not-interested disposition";
    reasons.push("The call summary says the borrower is not interested or declined to proceed.");
  } else if (outcome === "no_answer_or_voicemail") {
    priority = "normal";
    nextAction = "Review prior attempts, consent, local calling hours, and the contact strategy before scheduling another attempt.";
    taskTitle = "Review unanswered call attempt";
    reasons.push("The call did not result in a live borrower conversation.");
  } else {
    reasons.push("The call appears connected and has no explicit compliance or disposition warning.");
  }

  if (summary.missing_information.length) reasons.push(`${summary.missing_information.length} missing item(s) were identified.`);
  if (lead.sms_consent !== 1) reasons.push("SMS is not permitted because express SMS consent is not recorded.");
  if (lead.email_unsubscribed === 1) reasons.push("Email is not permitted because the lead is unsubscribed.");
  if (!summary.follow_up_needed && outcome === "connected") {
    taskTitle = null;
    nextAction = "No immediate follow-up was identified; a human should confirm the disposition before closing the review.";
  }

  return {
    outcome,
    priority,
    nextAction,
    taskTitle,
    dueAt,
    reasons: reasons.slice(0, 6),
    permittedChannels: channelsFor(lead, outcome),
    blockedAutomations,
    humanReviewRequired: true,
    consumerContactedAutomatically: false,
  };
}
