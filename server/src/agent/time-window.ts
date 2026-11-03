import * as chrono from "chrono-node";
import { slotWindow } from "../tools/slots.js";
import type { Clock } from "../shared/clock.js";

// Time-window parsing (V-6, NFR-7): chrono-node turns day/time phrases into moments
// on the controllable clock's "now" (IST); our own rules own the rest — week ranges
// and the qualifiers chrono drops ("mornings only", "not before", "between"), plus
// partial-merge corrections (R9).

export const TIME_OUT_OF_RANGE = "TIME_OUT_OF_RANGE";
export const TIME_UNPARSEABLE = "TIME_UNPARSEABLE";

export type TimeWindow = {
  dateFrom: string | null;
  dateTo: string | null;
  earliest: string | null;
  latest: string | null;
};

export type TimeResult = { ok: true; data: TimeWindow } | { ok: false; error: string };

const istDay = (d: Date): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(d)
    .split("-");
  return `${parts[0]}-${parts[1]}-${parts[2]}`;
};

const istHM = (d: Date): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);

const hOf = (hour: string, meridiem?: string | null): string => {
  let h = Number(hour);
  const m = (meridiem ?? "").toLowerCase().replace(/\./g, "");
  if (m === "pm" && h < 12) h += 12;
  if (m === "am" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:00`;
};

// Scan our own qualifiers; return bounds and the remaining text for chrono.
const scanQualifiers = (
  text: string,
): { earliest: string | null; latest: string | null; weekSpan: boolean; remaining: string } => {
  let earliest: string | null = null;
  let latest: string | null = null;
  let weekSpan = false;
  let remaining = text;
  const cut = (m: RegExpMatchArray | null) => {
    if (m) remaining = remaining.replace(m[0], " ");
  };

  const between = remaining.match(
    /between\s+(\d{1,2})\s*(?::\d{2})?\s*(a\.?m\.?|p\.?m\.?)?\s*and\s+(\d{1,2})\s*(?::\d{2})?\s*(a\.?m\.?|p\.?m\.?)?/i,
  );
  if (between) {
    earliest = hOf(between[1]!, between[2]);
    latest = hOf(between[3]!, between[5]);
    cut(between);
  }
  const notBefore = remaining.match(/(?:not|never)\s+before\s+(\d{1,2})\s*(:\d{2})?\s*(a\.?m\.?|p\.?m\.?)?/i);
  if (notBefore) {
    earliest = hOf(notBefore[1]!, notBefore[3]);
    cut(notBefore);
  }
  const afterTime = remaining.match(/\bafter\s+(\d{1,2})\s*(:\d{2})?\s*(a\.?m\.?|p\.?m\.?)?/i);
  if (afterTime) {
    earliest = hOf(afterTime[1]!, afterTime[3]);
    cut(afterTime);
  }
  const EVENING = /,?\s*\b(tonight|(?:this )?evenings?(?:\s*only)?)\b/i;
  if (EVENING.test(remaining)) {
    earliest = earliest ?? "17:00";
    cut(remaining.match(EVENING));
  }
  const AFTERNOON = /,?\s*\b(?:this )?afternoons?(?:\s*only)?\b/i;
  if (AFTERNOON.test(remaining)) {
    earliest = earliest ?? "12:00";
    latest = latest ?? "17:00";
    cut(remaining.match(AFTERNOON));
  }
  if (/\bmornings?(\s*only)?\b/i.test(remaining)) {
    latest = "12:00";
    cut(remaining.match(/,?\s*\bmornings?(\s*only)?\b/i));
  }
  if (/\banytime\b|\bwhenever\b/i.test(remaining)) {
    remaining = " ";
  }
  if (/\bthis week\b/i.test(remaining)) {
    weekSpan = true;
    cut(remaining.match(/,?\s*\bthis week\b/i));
  }
  return { earliest, latest, weekSpan, remaining: remaining.replace(/\s+/g, " ").trim() };
};

const DAY_RE = /\b(saturday|sunday|monday|tuesday|wednesday|thursday|friday)\b/i;

export const parseTimeWindow = (text: string, clock: Clock): TimeResult => {
  const q = scanQualifiers(text);
  const window: TimeWindow = { dateFrom: null, dateTo: null, earliest: q.earliest, latest: q.latest };
  const days = slotWindow(clock);
  const today = days[0]!;

  const found = chrono.parse(q.remaining, clock.now())[0];
  if (found) {
    let day = istDay(found.start.date());
    const pastMarker = /\b(last|yesterday)\b/i.test(q.remaining);
    if (DAY_RE.test(q.remaining)) {
      // a named day means the NEXT occurrence (a bare "Saturday" on Monday is this week's)
      if (day < today && !pastMarker)
        day = istDay(new Date(Date.parse(`${day}T00:00:00+05:30`) + 7 * 86_400_000));
      window.dateFrom = day;
      window.dateTo = day;
      if (found.start.isCertain("hour")) window.earliest = window.earliest ?? istHM(found.start.date());
    } else if (found.start.isCertain("hour")) {
      // a time mention ("at 3pm", "tomorrow at 9") — a one-hour-wide preference
      window.earliest = window.earliest ?? istHM(found.start.date());
      window.latest = window.latest ?? istHM(new Date(found.start.date().getTime() + 60 * 60 * 1000));
      if (found.start.isCertain("day")) {
        window.dateFrom = day;
        window.dateTo = day;
      }
    } else {
      window.dateFrom = day;
      window.dateTo = day;
    }
  } else if (/^tomorrow$/i.test(q.remaining) || /^day after tomorrow$/i.test(q.remaining)) {
    const offset = /^tomorrow$/i.test(q.remaining) ? 1 : 2;
    const day = istDay(new Date(clock.now().getTime() + offset * 24 * 60 * 60 * 1000));
    window.dateFrom = day;
    window.dateTo = day;
  }

  if (q.weekSpan) {
    // "this week": today (IST) through this Sunday (§2.3: 7 days of morning slots)
    const weekday =
      { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[
        new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata", weekday: "short" }).format(clock.now())
      ] ?? 0;
    const daysToSunday = (7 - weekday) % 7;
    window.dateFrom = today;
    window.dateTo = istDay(new Date(clock.now().getTime() + daysToSunday * 86_400_000));
  }

  if (window.dateFrom === null && window.earliest === null && window.latest === null) {
    // no date, no bounds — "anytime" is valid; anything else we couldn't read
    if (q.remaining.length > 0) return { ok: false, error: TIME_UNPARSEABLE };
  }

  const pastMarker = /\b(last|yesterday|ago|previous)\b/i.test(q.remaining);
  if (window.dateFrom && (window.dateFrom < today || (window.dateTo && window.dateTo > days[13]!))) {
    if (pastMarker || !/\bi\b/i.test(q.remaining)) {
      // a past phrase ("last Saturday") is simply out of range
    }
    return { ok: false, error: TIME_OUT_OF_RANGE };
  }
  if (
    window.dateFrom === today &&
    window.dateTo === today &&
    window.earliest &&
    !pastMarker &&
    window.earliest < istHM(clock.now())
  ) {
    // a time earlier today ("at 3pm") means the next 3pm, i.e. tomorrow — single-day
    // windows only: a range that starts today still has today's later slots
    const tomorrow = istDay(new Date(clock.now().getTime() + 86_400_000));
    if (tomorrow <= days[13]!) {
      window.dateFrom = tomorrow;
      window.dateTo = window.dateTo === today ? tomorrow : window.dateTo;
    }
  }
  // No "now" bound here: `earliest` applies to every day of the window, and past
  // slots are already left out by the provider's free-slot calculation.
  return { ok: true, data: window };
};

// A partial correction merges into the known window (R9): a bounds-only statement
// ("after 11") keeps the dates; a date statement ("Saturday") keeps the bounds.
export const mergeCorrection = (known: TimeWindow, correction: string, clock: Clock): TimeResult => {
  const parsed = parseTimeWindow(correction, clock);
  if (!parsed.ok) return parsed;
  const fix = parsed.data;
  const boundsFromFix = fix.earliest !== null || fix.latest !== null;
  let earliest = fix.earliest;
  let latest = fix.latest;
  if (fix.dateFrom) {
    earliest = known.earliest;
    latest = known.latest;
  } else if (!boundsFromFix) {
    // a pure relative-day statement ("tomorrow"): dates move, bounds stay
  } else {
    // bounds-only on existing dates
  }
  const merged: TimeWindow = {
    dateFrom: fix.dateFrom ?? known.dateFrom,
    dateTo: fix.dateTo ?? known.dateTo,
    earliest,
    latest,
  };
  const days = slotWindow(clock);
  if (merged.dateFrom && (merged.dateFrom < days[0]! || (merged.dateTo && merged.dateTo > days[13]!))) {
    return { ok: false, error: TIME_OUT_OF_RANGE };
  }
  return { ok: true, data: merged };
};
