import { NMLS_FOOTER, brand } from "../brand";

/** Transliterations applied before forcing GSM-7. */
const TRANSLIT: [RegExp, string][] = [
  [/[‒–—―−]/g, "-"], /* figure/en/em dash, minus -> hyphen */
  [/[‘’‚‛′]/g, "'"], /* smart single quotes/prime -> ' */
  [/[“”„‟″]/g, '"'], /* smart double quotes -> " */
  [/…/g, "..."],                          /* ellipsis */
  [/ /g, " "],                            /* non-breaking space */
  [/[•‣●]/g, "*"],              /* bullets */
];

export interface Hygiene {
  /** Cleaned, GSM-7-safe core message (footer NOT yet applied). */
  core: string;
  /** True if the cleaned core exceeds a single 160-char SMS segment. */
  tooLong: boolean;
  /** Length of the cleaned core. */
  length: number;
  /** True if sanitization removed everything (nothing left to send). */
  empty: boolean;
}

/** Strip smart punctuation / em-en dashes / emoji and force a GSM-7 (ASCII) body. */
export function sanitize(input: string): Hygiene {
  let s = input ?? "";
  for (const [re, rep] of TRANSLIT) s = s.replace(re, rep);
  /* Drop anything outside printable ASCII (keeps \t \n \r) — removes emoji + symbols. */
  s = s.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "");
  s = s.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return { core: s, length: s.length, tooLong: s.length > 160, empty: s.length === 0 };
}

/** Apply the compliance footer. Adds the NMLS line if absent; adds STOP language
 *  only on the first message to a contact. */
export function applyFooter(core: string, opts: { firstMessage: boolean }): string {
  const tail: string[] = [];
  if (opts.firstMessage && !/reply stop/i.test(core)) tail.push(brand.optOutLine);
  const hasNmls = core.includes(NMLS_FOOTER) || core.replace(/\s+/g, "").includes(`NMLS#${brand.nmls}`);
  if (!hasNmls) tail.push(NMLS_FOOTER);
  return tail.length ? `${core} ${tail.join(" ")}`.trim() : core.trim();
}

/** Normalize an outbound body for 12h near-duplicate detection (footer-agnostic). */
export function normalizeForDedupe(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/reply stop to opt out\.?/g, "")
    .replace(new RegExp(`nmls\\s*#?\\s*${brand.nmls}`, "g"), "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
