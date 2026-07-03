/**
 * Lead tagging + routing. Maps a website inquiry to exactly ONE primary category,
 * then to its campaign. Pure functions (no I/O) so they are unit-testable.
 *
 * Handles BOTH lead sources: the human-readable loanType values from the mykoal.com
 * form ("Purchase", "Refinance", "Investor/DSCR", "VA Loan", "General Inquiry") AND the
 * uppercase codes the smartr8.com funnels post ("PURCHASE", "CASHOUT_REFI", "RT_REFI",
 * "DSCR", "HELOC"). An explicit loanType always wins; otherwise we fall back to keyword
 * precedence (cash-out must beat a plain "refinance", HELOC must beat generic equity):
 *   PURCHASE → CASHOUT_REFI → HELOC → DSCR → RATE_TERM_REFI → GENERAL
 */

export type Category = "PURCHASE" | "CASHOUT_REFI" | "HELOC" | "RATE_TERM_REFI" | "DSCR" | "GENERAL";

export type LoanType =
  | "General Inquiry"
  | "Purchase"
  | "Refinance"
  | "HELOC"
  | "Investor/DSCR"
  | "VA Loan"
  // smartr8.com funnel codes
  | "PURCHASE"
  | "CASHOUT_REFI"
  | "RT_REFI"
  | "DSCR";

export const CAMPAIGN_BY_CATEGORY: Record<Category, string> = {
  PURCHASE: "Purchase Path",
  CASHOUT_REFI: "Cash Out Refi",
  HELOC: "HELOC",
  RATE_TERM_REFI: "Rate and Term Refi",
  DSCR: "DSCR Investor",
  GENERAL: "General Nurture",
};

const PURCHASE_KW = ["buy", "buying", "pre approval", "preapproval", "pre-approval", "new home", "making an offer"];
const CASHOUT_KW = ["cash out", "cash-out", "cashout", "pull equity", "debt consolidation", "consolidate", "pay off debt", "payoff debt", "renovation", "remodel", "home improvement"];
const HELOC_KW = ["heloc", "line of credit", "equity line", "second mortgage"];
const DSCR_KW = ["dscr", "investor loan", "investment property", "rental property", "rental income", "debt service"];
const RATE_TERM_KW = ["lower rate", "lower payment", "lower my rate", "reduce my rate", "refinance", "refi"];

function hasKeyword(text: string, keywords: string[]): boolean {
  return keywords.some((k) => text.includes(k));
}

/** Normalize a loanType for comparison: lowercased, with spaces / _ / - / slash stripped. */
function normLoanType(raw: string): string {
  return raw.toLowerCase().replace(/[\s_\-/]+/g, "");
}

export interface TaggingInput {
  loanType?: string;
  message?: string;
  /** smartr8.com FunnelId (e.g. "heloc-v2", "cash-out", "rate-reduction", "purchase").
   *  The capture worker posts this as `funnel` and sends NO loanType, so it is the only
   *  product signal for those leads. */
  funnel?: string;
}

/** Map a smartr8.com FunnelId to a category. Returns null for funnels with no product
 *  signal ("worksheet", "other") or an unrecognized value, so the caller can fall through
 *  to the loanType / keyword logic. Mirrors the FunnelId union in the smartr8 worker. */
function categoryFromFunnel(funnel: string): Category | null {
  const f = funnel.trim().toLowerCase();
  if (!f) return null;
  if (f.startsWith("heloc")) return "HELOC"; // heloc, heloc-v2, heloc-quick, heloc-quick-v2
  if (f === "cashout" || f === "cash-out") return "CASHOUT_REFI";
  if (f === "rate-reduction") return "RATE_TERM_REFI";
  if (f === "purchase") return "PURCHASE";
  if (f === "dscr") return "DSCR";
  return null; // "worksheet", "other", unknown → no funnel signal
}

export interface TaggingResult {
  category: Category;
  reason: string;
  campaign: string;
}

/** Classify an inquiry into one primary category with a human-readable reason. */
export function categorize(input: TaggingInput): TaggingResult {
  const raw = (input.loanType ?? "").trim();
  const lt = normLoanType(raw);
  const msg = (input.message ?? "").toLowerCase();
  const result = (category: Category, reason: string): TaggingResult => ({
    category,
    reason,
    campaign: CAMPAIGN_BY_CATEGORY[category],
  });

  // 1) An explicit loanType wins. Handles both the funnel codes and the human values.
  if (lt === "dscr" || lt === "investordscr" || lt === "investor") return result("DSCR", `loanType "${raw}"`);
  if (lt === "purchase" || lt === "valoan" || lt === "va") return result("PURCHASE", `loanType "${raw}"`);
  if (lt === "heloc") return result("HELOC", `loanType "${raw}"`);
  if (lt === "cashoutrefi" || lt === "cashout") return result("CASHOUT_REFI", `loanType "${raw}"`);
  if (lt === "rtrefi" || lt === "ratetermrefi" || lt === "rateandtermrefi") {
    return result("RATE_TERM_REFI", `loanType "${raw}"`);
  }
  // Generic "Refinance": split by whether the message signals cash-out intent.
  if (lt === "refinance" || lt === "refi") {
    return hasKeyword(msg, CASHOUT_KW)
      ? result("CASHOUT_REFI", 'loanType "Refinance" with cash-out intent')
      : result("RATE_TERM_REFI", 'loanType "Refinance" without cash-out intent');
  }

  // 1b) A smartr8.com funnel id (sent as `funnel` by the capture worker, which posts NO
  // loanType) is an explicit product signal — map it straight to its category. Placed
  // after the loanType block so an explicit human-selected loanType still wins.
  if (input.funnel) {
    const fromFunnel = categoryFromFunnel(input.funnel);
    if (fromFunnel) return result(fromFunnel, `funnel "${input.funnel.trim()}"`);
  }

  // 2) Keyword fallback (precedence order).
  if (hasKeyword(msg, PURCHASE_KW)) return result("PURCHASE", "purchase keyword in message");
  if (hasKeyword(msg, CASHOUT_KW)) return result("CASHOUT_REFI", "cash-out keyword in message");
  if (hasKeyword(msg, HELOC_KW)) return result("HELOC", "HELOC keyword in message");
  if (hasKeyword(msg, DSCR_KW)) return result("DSCR", "investor/DSCR keyword in message");
  if (hasKeyword(msg, RATE_TERM_KW)) return result("RATE_TERM_REFI", "rate/term keyword in message");

  // 3) Explicit General, or anything unmatched.
  if (lt === "generalinquiry" || lt === "general") return result("GENERAL", `loanType "${raw}"`);
  return result("GENERAL", "no category match");
}
