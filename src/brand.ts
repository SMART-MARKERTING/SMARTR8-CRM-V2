/**
 * Business facts for Adaxa Home LLC (loan officer Mykoal DeShazo). Used in SMS/email
 * copy and compliance footers. Keep these contact details aligned with Resend sender
 * choices, automation copy, and the Control Panel diagnostics.
 */
export const brand = {
  sender: "Mykoal DeShazo",
  legal: "Adaxa Home LLC",
  smsName: "Adaxa Home", // shorter brand used in SMS copy (no "LLC")
  loOfficerTitle: "Vice President and Senior Loan Officer",
  nmlsLO: "1912347",
  companyName: "Adaxa Home LLC",
  nmlsCompany: "2380533",
  website: "https://smartr8.com",
  privacy: "https://smartr8.com/privacy",
  cellNumber: "623-280-8351",
  officeNumber: "4802069290",
  smsNumber: "623-280-8351",
  voiceNumber: "4802069290",
  address: "16767 N Perimeter Dr, Ste 150, Scottsdale, AZ 85260",
  states: ["AZ", "CO", "CT", "FL", "MI", "MN", "OR", "PA", "TX", "VA", "WA"],
  fromEmailDefault: "MDESHAZO@mykoal.com",
  sendingEmails: ["MDESHAZO@mykoal.com", "info@mykoal.com", "hello@mykoal.com"],
};

export const statesLine = brand.states.join(", ");

function phoneHref(num: string): string {
  const digits = num.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits ? `+${digits}` : "";
}

/** CAN-SPAM email signature block (HTML). */
export function emailSignatureHtml(): string {
  return (
    `<p style="margin-top:18px">${brand.sender}<br>` +
    `${brand.loOfficerTitle}, NMLS ${brand.nmlsLO}<br>` +
    `${brand.companyName} NMLS ${brand.nmlsCompany}<br>` +
    `Equal Housing Opportunity<br>` +
    `Licensed in ${statesLine}<br>` +
    `Cell ${brand.cellNumber}<br>` +
    `Office ${brand.officeNumber}</p>`
  );
}

/** Plain-text signature variant. */
export function emailSignatureText(): string {
  return (
    `${brand.sender}\n` +
    `${brand.loOfficerTitle}, NMLS ${brand.nmlsLO}\n` +
    `${brand.companyName} NMLS ${brand.nmlsCompany}\n` +
    `Equal Housing Opportunity\n` +
    `Licensed in ${statesLine}\n` +
    `Cell ${brand.cellNumber}\n` +
    `Office ${brand.officeNumber}`
  );
}

/** CAN-SPAM footer (physical address + unsubscribe). `unsubUrl` is the working link. */
export function emailFooterHtml(unsubUrl: string): string {
  return (
    `<hr style="border:none;border-top:1px solid #e2e8f2;margin:20px 0">` +
    `<p style="font-size:12px;color:#64748b;line-height:1.5">` +
    `${brand.sender}, ${brand.legal}<br>${brand.address}<br>` +
    `You are receiving this because you requested mortgage information at ` +
    `<a href="${brand.website}">smartr8.com</a>. ` +
    `<a href="${unsubUrl}">Unsubscribe</a> at any time.</p>`
  );
}

export function emailFooterText(unsubUrl: string): string {
  return (
    `\n\n${brand.sender}, ${brand.legal}\n${brand.address}\n` +
    `You requested mortgage information at smartr8.com. Unsubscribe: ${unsubUrl}`
  );
}

// Production-hosted email assets (emails cannot use bundle-relative paths). Shared with
// the smartr8.com transactional welcome so the CRM's emails match the site's branding.
const EMAIL_LOGO_URL = "https://smartr8.com/adaxa-logo-optimized.jpg";
const EMAIL_EHO_URL = "https://smartr8.com/eho-logo-optimized.png";

/**
 * Wrap an email body in the branded Adaxa card (logo header, contact box, signature,
 * EHO badge + CAN-SPAM footer with a working unsubscribe link). `bodyHtml` is the
 * already-paragraphed message; `ctaHtml` is the optional button block; `preheaderHtml`
 * is the hidden inbox-preview span. This is the single visual shell for every CRM email,
 * so the product-specific drip copy and the day-0 welcome all render identically branded.
 */
export function renderBrandedEmailHtml(opts: {
  preheaderHtml?: string;
  bodyHtml: string;
  ctaHtml?: string;
  unsubUrl: string;
}): string {
  const { preheaderHtml = "", bodyHtml, ctaHtml = "", unsubUrl } = opts;
  const officeHref = phoneHref(brand.officeNumber);
  const cellHref = phoneHref(brand.cellNumber);
  return (
    `<!DOCTYPE html><html lang="en"><head>` +
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">` +
    `<meta name="color-scheme" content="light only"></head>` +
    `<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;">` +
    preheaderHtml +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;">` +
    `<tr><td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e5e5;">` +
    `<tr><td align="center" style="padding:28px 24px 8px;">` +
    `<img src="${EMAIL_LOGO_URL}" alt="${brand.legal}" width="156" style="display:block;width:156px;max-width:60%;height:auto;border:0;"></td></tr>` +
    `<tr><td style="padding:12px 32px 4px;color:#16243a;font-size:16px;line-height:1.6;">` +
    bodyHtml +
    ctaHtml +
    `</td></tr>` +
    `<tr><td style="padding:8px 32px 4px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#fdf2f2;border-left:4px solid #E31B23;border-radius:4px;">` +
    `<tr><td style="padding:14px 18px;font-size:15px;line-height:1.8;color:#333333;">` +
    `<strong style="color:#E31B23;">Reach me directly:</strong><br>` +
    `Cell: <a href="tel:${cellHref}" style="color:#E31B23;text-decoration:none;">${brand.cellNumber}</a><br>` +
    `Office: <a href="tel:${officeHref}" style="color:#E31B23;text-decoration:none;">${brand.officeNumber}</a>` +
    `</td></tr></table></td></tr>` +
    `<tr><td style="padding:18px 32px 6px;color:#16243a;font-size:15px;line-height:1.6;">` +
    `<p style="margin:0;color:#13485A;font-weight:bold;font-size:16px;">${brand.sender}</p>` +
    `<p style="margin:2px 0 0;color:#666666;font-size:14px;line-height:1.5;">` +
    `${brand.loOfficerTitle}, NMLS ${brand.nmlsLO}<br>` +
    `${brand.companyName} NMLS ${brand.nmlsCompany}<br>` +
    `${brand.address}</p></td></tr>` +
    `<tr><td style="padding:16px 32px 24px;border-top:1px solid #eeeeee;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0"><tr>` +
    `<td valign="middle" style="padding-right:10px;"><img src="${EMAIL_EHO_URL}" alt="Equal Housing Opportunity" width="26" style="display:block;width:26px;height:auto;border:0;"></td>` +
    `<td valign="middle" style="font-size:11px;color:#666666;line-height:1.5;">Equal Housing Opportunity.<br>Licensed in ${statesLine}.</td>` +
    `</tr></table>` +
    `<p style="margin:12px 0 0;font-size:11px;color:#666666;line-height:1.5;">This is not a commitment to lend. All loans subject to credit approval, income verification, and property appraisal.</p>` +
    `<p style="margin:10px 0 0;font-size:11px;color:#666666;line-height:1.5;">${brand.sender}, ${brand.legal}, ${brand.address}. You are receiving this because you requested mortgage information at <a href="${brand.website}" style="color:#666666;">smartr8.com</a>. <a href="${unsubUrl}" style="color:#666666;">Unsubscribe</a> at any time.</p>` +
    `</td></tr></table></td></tr></table></body></html>`
  );
}
