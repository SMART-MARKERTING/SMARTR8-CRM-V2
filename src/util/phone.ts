import { config } from "../config";

/** Normalize a phone string to E.164. Adds the default country code if no +. */
export function toE164(raw: string): string {
  if (!raw) return raw;
  const trimmed = raw.trim();
  if (trimmed.startsWith("+")) return trimmed.replace(/[^\d+]/g, "");
  const digits = trimmed.replace(/\D/g, "");
  const cc = config.routing.defaultCountryCode.replace(/\D/g, ""); // e.g. "1"
  // An 11-digit number that already starts with the country code (e.g. 1XXXXXXXXXX)
  // just needs a "+" — prefixing the code again would double it (+11XXXXXXXXXX).
  if (cc && digits.length === cc.length + 10 && digits.startsWith(cc)) return `+${digits}`;
  return `${config.routing.defaultCountryCode}${digits}`;
}
