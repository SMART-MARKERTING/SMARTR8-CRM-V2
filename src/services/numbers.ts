import { config } from "../config";

export interface OwnedNumber {
  e164: string;
  areaCode?: string;
  state?: string; // US state (USPS) the area code belongs to
  label: string; // e.g. "+16197826916 · CA"
}

// US area code → state (USPS). Canada/other NANP codes simply fall back to default.
const AREA_CODE_STATE: Record<string, string> = {};
function add(state: string, codes: number[]): void {
  for (const c of codes) AREA_CODE_STATE[String(c)] = state;
}
add("AL", [205, 251, 256, 334, 659, 938]);
add("AK", [907]);
add("AZ", [480, 520, 602, 623, 928]);
add("AR", [327, 479, 501, 870]);
add("CA", [209, 213, 279, 310, 323, 341, 350, 408, 415, 424, 442, 510, 530, 559, 562, 619, 626, 628, 650, 657, 661, 669, 707, 714, 747, 760, 805, 818, 820, 831, 840, 858, 909, 916, 925, 949, 951]);
add("CO", [303, 719, 720, 970, 983]);
add("CT", [203, 475, 860, 959]);
add("DE", [302]);
add("DC", [202]);
add("FL", [239, 305, 321, 352, 386, 407, 448, 561, 656, 689, 727, 754, 772, 786, 813, 850, 863, 904, 941, 954]);
add("GA", [229, 404, 470, 478, 678, 706, 762, 770, 912, 943]);
add("HI", [808]);
add("ID", [208, 986]);
add("IL", [217, 224, 309, 312, 331, 447, 464, 618, 630, 708, 730, 773, 779, 815, 847, 872]);
add("IN", [219, 260, 317, 463, 574, 765, 812, 930]);
add("IA", [319, 515, 563, 641, 712]);
add("KS", [316, 620, 785, 913]);
add("KY", [270, 364, 502, 606, 859]);
add("LA", [225, 318, 337, 504, 985]);
add("ME", [207]);
add("MD", [240, 301, 410, 443, 667]);
add("MA", [339, 351, 413, 508, 617, 774, 781, 857, 978]);
add("MI", [231, 248, 269, 313, 517, 586, 616, 679, 734, 810, 906, 947, 989]);
add("MN", [218, 320, 507, 612, 651, 763, 952]);
add("MS", [228, 601, 662, 769]);
add("MO", [314, 417, 557, 573, 636, 660, 816]);
add("MT", [406]);
add("NE", [308, 402, 531]);
add("NV", [702, 725, 775]);
add("NH", [603]);
add("NJ", [201, 551, 609, 640, 732, 848, 856, 862, 908, 973]);
add("NM", [505, 575]);
add("NY", [212, 315, 332, 347, 363, 516, 518, 585, 607, 631, 646, 680, 716, 718, 838, 845, 914, 917, 929, 934]);
add("NC", [252, 336, 704, 743, 828, 910, 919, 980, 984]);
add("ND", [701]);
add("OH", [216, 220, 234, 283, 326, 330, 380, 419, 440, 513, 567, 614, 740, 937]);
add("OK", [405, 539, 572, 580, 918]);
add("OR", [458, 503, 541, 971]);
add("PA", [215, 223, 267, 272, 412, 445, 484, 570, 582, 610, 717, 724, 814, 835, 878]);
add("RI", [401]);
add("SC", [803, 839, 843, 854, 864]);
add("SD", [605]);
add("TN", [423, 615, 629, 731, 865, 901, 931]);
add("TX", [210, 214, 254, 281, 325, 346, 361, 409, 430, 432, 469, 512, 682, 713, 726, 737, 806, 817, 830, 832, 903, 915, 936, 940, 945, 956, 972, 979]);
add("UT", [385, 435, 801]);
add("VT", [802]);
add("VA", [276, 434, 540, 571, 703, 757, 804, 826, 948]);
add("WA", [206, 253, 360, 425, 509, 564]);
add("WV", [304, 681]);
add("WI", [262, 274, 414, 534, 608, 715, 920]);
add("WY", [307]);

/** The 3-digit area code of a US/NANP number, or undefined. */
export function areaCodeOf(phone: string): string | undefined {
  const d = (phone || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return d.slice(1, 4);
  if (d.length === 10) return d.slice(0, 3);
  return undefined;
}

function toOwned(e164: string): OwnedNumber {
  const ac = areaCodeOf(e164);
  const state = ac ? AREA_CODE_STATE[ac] : undefined;
  return { e164, areaCode: ac, state, label: `${e164}${state ? ` · ${state}` : ""}` };
}

/** Your sending numbers: TELNYX_NUMBERS list, always including the primary FROM number. */
export function listNumbers(): OwnedNumber[] {
  const raw = config.telnyx.numbers || "";
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const primary = config.telnyx.fromNumber;
  if (primary && !list.includes(primary)) list.unshift(primary);
  // de-dupe, preserve order
  const seen = new Set<string>();
  return list.filter((n) => (seen.has(n) ? false : (seen.add(n), true))).map(toOwned);
}

export function defaultFrom(): string {
  return config.telnyx.fromNumber || listNumbers()[0]?.e164 || "";
}

export interface FromPick {
  from: string;
  reason: "exact-area-code" | "same-state" | "default";
}

/**
 * Smart caller-ID by destination: prefer a number with the SAME area code as the
 * destination, then any number in the same STATE, else the default. Used for outbound
 * CALLS and for the SMS leg of the messaging router (iMessage has no from-number, so it
 * is unaffected). An explicit caller-supplied `from` overrides this.
 */
export function pickFromNumber(destination: string): FromPick {
  const nums = listNumbers();
  const def = defaultFrom();
  const destAc = areaCodeOf(destination);
  if (!destAc || !nums.length) return { from: def, reason: "default" };

  const exact = nums.find((n) => n.areaCode === destAc);
  if (exact) return { from: exact.e164, reason: "exact-area-code" };

  const destState = AREA_CODE_STATE[destAc];
  if (destState) {
    const sameState = nums.find((n) => n.state === destState);
    if (sameState) return { from: sameState.e164, reason: "same-state" };
  }
  return { from: def, reason: "default" };
}
