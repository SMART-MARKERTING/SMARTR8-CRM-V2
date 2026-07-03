/** Normalize a phone string to E.164, adding +1 when the country code is missing.
 *  Returns "" for empty/unusable input. Matches how the leads table stores numbers. */
export function toE164(raw?: string | null): string {
  if (!raw) return "";
  const trimmed = String(raw).trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("+")) {
    const cleaned = trimmed.replace(/[^\d+]/g, "");
    return cleaned.length > 1 ? cleaned : "";
  }
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  // Already includes some country code, or an unexpected length: keep digits as-is.
  return `+${digits}`;
}

/** True when a handle looks like a phone number (vs. an iMessage email address). */
export function looksLikePhone(handle?: string | null): boolean {
  if (!handle) return false;
  return /^\+?[\d().\-\s]{7,}$/.test(String(handle).trim());
}
