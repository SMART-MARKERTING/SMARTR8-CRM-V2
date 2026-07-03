/**
 * Infer a recipient timezone from a US phone area code so SMS sends can respect TCPA
 * quiet hours (8:00 AM to 9:00 PM local). Coverage focuses on the licensed states
 * (AZ, CO, CT, FL, MI, MN, OR, PA, TX, VA, WA) plus common codes; anything unknown
 * falls back to the most conservative window (see smsWindow()).
 */

const TZ_CODES: Record<string, string[]> = {
  // Arizona does not observe DST.
  "America/Phoenix": ["480", "520", "602", "623", "928", "820"],
  "America/Denver": ["303", "719", "720", "970", "983", "915", "505", "575"],
  "America/Chicago": [
    "612", "651", "763", "952", "320", "507", "218", // MN
    "214", "469", "972", "945", "817", "682", "713", "281", "832", "346", "409", "936",
    "979", "512", "737", "210", "726", "361", "956", "830", "254", "325", "432", "940",
    "903", "430", // TX
  ],
  "America/New_York": [
    "203", "475", "860", "959", // CT
    "305", "786", "321", "407", "689", "727", "754", "954", "772", "561", "239", "941",
    "813", "863", "352", "386", "904", "850", "448", // FL
    "313", "248", "947", "734", "810", "586", "616", "269", "517", "989", "231", "906", "679", // MI
    "215", "267", "445", "484", "610", "272", "570", "717", "724", "814", "878", "582", "835", // PA
    "703", "571", "540", "434", "804", "757", "276", "826", "948", // VA
  ],
  "America/Los_Angeles": [
    "503", "971", "541", "458", // OR
    "206", "253", "360", "425", "509", "564", // WA
  ],
};

const CODE_TO_TZ: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const [tz, codes] of Object.entries(TZ_CODES)) for (const c of codes) m[c] = tz;
  return m;
})();

/** Extract the 3-digit area code from an E.164 (+1AAANXXXXXX) US number. */
export function areaCode(e164: string): string | null {
  const m = /^\+1(\d{3})\d{7}$/.exec(e164);
  return m ? m[1] : null;
}

/** Infer IANA timezone from a phone number, or null if the area code is unknown. */
export function tzForPhone(e164: string): string | null {
  const ac = areaCode(e164);
  return ac ? CODE_TO_TZ[ac] ?? null : null;
}

// State → IANA tz (licensed states first, plus common others). Split-tz states map to
// their majority zone; cityTz() refines the well-known exceptions.
const STATE_TZ: Record<string, string> = {
  AZ: "America/Phoenix", CO: "America/Denver", CT: "America/New_York", FL: "America/New_York",
  MI: "America/Detroit", MN: "America/Chicago", OR: "America/Los_Angeles", PA: "America/New_York",
  TX: "America/Chicago", VA: "America/New_York", WA: "America/Los_Angeles",
  CA: "America/Los_Angeles", NV: "America/Los_Angeles", NY: "America/New_York", IL: "America/Chicago",
  GA: "America/New_York", NC: "America/New_York", OH: "America/New_York", NM: "America/Denver",
  UT: "America/Denver", ID: "America/Boise", NJ: "America/New_York", MA: "America/New_York",
};
const FULL_STATE: Record<string, string> = {
  arizona: "AZ", colorado: "CO", connecticut: "CT", florida: "FL", michigan: "MI", minnesota: "MN",
  oregon: "OR", pennsylvania: "PA", texas: "TX", virginia: "VA", washington: "WA",
};
// City overrides for split-timezone states (city beats state when present).
const CITY_TZ: Record<string, string> = {
  "el paso": "America/Denver", // West TX is Mountain
  pensacola: "America/Chicago", // FL panhandle is Central
  ontario: "America/Boise", // far-east OR is Mountain
};

/** IANA tz from a US state (2-letter or full name), or null if unknown. */
export function stateTz(state?: string): string | null {
  if (!state) return null;
  const s = state.trim();
  const abbr = s.length === 2 ? s.toUpperCase() : FULL_STATE[s.toLowerCase()];
  return abbr ? STATE_TZ[abbr] ?? null : null;
}

/** IANA tz override for a known split-state city, or null. */
export function cityTz(city?: string): string | null {
  if (!city) return null;
  return CITY_TZ[city.trim().toLowerCase()] ?? null;
}

/** Current local hour (0-23) for an IANA tz, or null on bad/empty tz. */
function localHour(tz: string, now = new Date()): number | null {
  try {
    const s = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(now);
    const h = parseInt(s, 10);
    return Number.isFinite(h) ? h % 24 : null;
  } catch {
    return null;
  }
}

export interface SmsWindow {
  allowed: boolean;
  tz: string | null;
  /** Epoch ms of the next send window start (set only when allowed === false). */
  nextStartMs?: number;
}

/**
 * SMS quiet-hours gate for an already-resolved tz. When tz is known, allow
 * 8:00 AM..9:00 PM there. When tz is null, use the most conservative window:
 * 11:00 AM..9:00 PM Eastern, which is inside 8 AM..9 PM in every contiguous US zone
 * (11a ET = 8a PT; 9p ET = 6p PT).
 */
export function smsWindowForTz(tz: string | null, now = new Date()): SmsWindow {
  const checkTz = tz ?? "America/New_York";
  const startHour = tz ? 8 : 11;
  const endHour = 21;
  const h = localHour(checkTz, now);
  if (h === null) {
    // Can't evaluate — back off an hour rather than risk an off-hours send.
    return { allowed: false, tz, nextStartMs: now.getTime() + 60 * 60 * 1000 };
  }
  if (h >= startHour && h < endHour) return { allowed: true, tz };
  // Whole hours until the next start boundary (coarse to the top of the hour; never early).
  let hoursUntil = (startHour - h + 24) % 24;
  if (hoursUntil === 0) hoursUntil = 24;
  return { allowed: false, tz, nextStartMs: now.getTime() + hoursUntil * 60 * 60 * 1000 };
}
