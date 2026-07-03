/** Business facts for compliance footers. Customer-facing copy contains NO emoji
 *  and no em/en dashes (see util/hygiene). NMLS is the loan officer's. */
export const brand = {
  sender: "Mykoal DeShazo",
  company: "Adaxa Home",
  nmls: "1912347",
  optOutLine: "Reply STOP to opt out.",
};

/** Footer that must appear on outbound messages. */
export const NMLS_FOOTER = `NMLS #${brand.nmls}`;
