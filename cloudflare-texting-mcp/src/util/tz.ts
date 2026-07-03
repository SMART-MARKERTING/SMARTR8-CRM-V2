/** US state -> IANA timezone, plus the TCPA-style business-hours gate.
 *
 *  The federal hard ceiling is 8am-9pm in the RECIPIENT's local time. Some states
 *  enforce stricter texting/calling windows; add them to STRICT_WINDOWS and the
 *  effective window becomes the INTERSECTION of the ceiling and the override.
 *
 *  Multi-timezone states are mapped to a single representative zone (documented as
 *  a known limitation); when a lead's state is missing or unmappable we DO NOT send. */

export interface Window {
  /** Inclusive local hour the window opens (0-23). */
  start: number;
  /** Exclusive local hour the window closes (0-24). */
  end: number;
}

/** Federal hard ceiling — never send outside this, in recipient-local time. */
export const HARD_CEILING: Window = { start: 8, end: 21 };

/** Optional stricter per-state windows (state code -> window). Edit as needed;
 *  the effective window is intersect(HARD_CEILING, STRICT_WINDOWS[state]).
 *  Example (uncomment / adjust to your compliance guidance):
 *    FL: { start: 8, end: 20 },
 *    TX: { start: 8, end: 21 }, */
export const STRICT_WINDOWS: Record<string, Window> = {};

const NAME_TO_CODE: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY",
};

/** Representative IANA zone per state. Multi-zone states pick one (see header). */
const STATE_TZ: Record<string, string> = {
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix",
  AR: "America/Chicago", CA: "America/Los_Angeles", CO: "America/Denver",
  CT: "America/New_York", DE: "America/New_York", DC: "America/New_York",
  FL: "America/New_York", GA: "America/New_York", HI: "Pacific/Honolulu",
  ID: "America/Boise", IL: "America/Chicago", IN: "America/Indiana/Indianapolis",
  IA: "America/Chicago", KS: "America/Chicago", KY: "America/New_York",
  LA: "America/Chicago", ME: "America/New_York", MD: "America/New_York",
  MA: "America/New_York", MI: "America/Detroit", MN: "America/Chicago",
  MS: "America/Chicago", MO: "America/Chicago", MT: "America/Denver",
  NE: "America/Chicago", NV: "America/Los_Angeles", NH: "America/New_York",
  NJ: "America/New_York", NM: "America/Denver", NY: "America/New_York",
  NC: "America/New_York", ND: "America/Chicago", OH: "America/New_York",
  OK: "America/Chicago", OR: "America/Los_Angeles", PA: "America/New_York",
  RI: "America/New_York", SC: "America/New_York", SD: "America/Chicago",
  TN: "America/Chicago", TX: "America/Chicago", UT: "America/Denver",
  VT: "America/New_York", VA: "America/New_York", WA: "America/Los_Angeles",
  WV: "America/New_York", WI: "America/Chicago", WY: "America/Denver",
};

/** Normalize "Arizona" / "az" / " AZ " -> "AZ" (or "" if unknown). */
export function normalizeState(raw?: string | null): string {
  if (!raw) return "";
  const t = String(raw).trim();
  if (!t) return "";
  if (t.length === 2) return STATE_TZ[t.toUpperCase()] ? t.toUpperCase() : "";
  return NAME_TO_CODE[t.toLowerCase()] ?? "";
}

/** Resolve a lead's property_state to an IANA timezone, or null if unknown. */
export function tzForState(state?: string | null): string | null {
  const code = normalizeState(state);
  return code ? STATE_TZ[code] ?? null : null;
}

/** Recipient-local hour (0-23) for an IANA zone, or null if missing/invalid. */
export function localHour(tz?: string | null): number | null {
  if (!tz) return null;
  try {
    const s = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      hour12: false,
    }).format(new Date());
    const h = parseInt(s, 10);
    return Number.isFinite(h) ? h % 24 : null;
  } catch {
    return null;
  }
}

export type HoursDecision =
  | { ok: true; tz: string; localHour: number; window: Window }
  | { ok: false; reason: "unknown_timezone" }
  | { ok: false; reason: "outside_hours"; tz: string; localHour: number; window: Window };

/** Effective window for a state = intersection of the ceiling and any stricter override. */
function effectiveWindow(stateCode: string): Window {
  const strict = STRICT_WINDOWS[stateCode];
  if (!strict) return HARD_CEILING;
  return {
    start: Math.max(HARD_CEILING.start, strict.start),
    end: Math.min(HARD_CEILING.end, strict.end),
  };
}

/** Business-hours gate driven by the lead's property_state. */
export function checkBusinessHours(state?: string | null): HoursDecision {
  const code = normalizeState(state);
  const tz = code ? STATE_TZ[code] : null;
  if (!tz) return { ok: false, reason: "unknown_timezone" };
  const h = localHour(tz);
  if (h === null) return { ok: false, reason: "unknown_timezone" };
  const window = effectiveWindow(code);
  if (h >= window.start && h < window.end) return { ok: true, tz, localHour: h, window };
  return { ok: false, reason: "outside_hours", tz, localHour: h, window };
}
