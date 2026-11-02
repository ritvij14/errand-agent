import type { Clock } from "../shared/clock.js";
import { slotWindow, type ProviderSummary } from "../tools/index.js";
import type { TimeWindow } from "./time-window.js";

// Search results → option blocks (FR-9, § 2.5.2 `searching`). Pure: the workflow
// stores the blocks as candidates and the reply part is drawn from them.

// No numbers or letters (ADR-007): a pick names the provider and the slot's time.
// `pickText` is the message the page sends on Confirm — built here, next to the
// reader that parses it, so the two can't drift apart.
export type OptionBlock = {
  provider: { id: string; name: string; rating: number; price: number };
  slots: { start: string; pickText: string }[];
};

const DAY_LABEL = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  weekday: "short",
  day: "numeric",
  month: "short",
});

/** "Tue 3 Nov at 10:00" — a slot's IST day and time, as the user reads it. */
export const slotLabel = (slot: string): string => {
  const parts = Object.fromEntries(DAY_LABEL.formatToParts(new Date(slot)).map((p) => [p.type, p.value]));
  return `${parts.weekday} ${parts.day} ${parts.month} at ${localTime(slot)}`;
};

/** "Book Deva Pipe Care on Tue 3 Nov at 10:00". */
export const pickText = (providerName: string, slot: string): string => `Book ${providerName} on ${slotLabel(slot)}`;

export type OptionsResult =
  | { ok: true; blocks: OptionBlock[] }
  | { ok: false; error: "NO_MATCHES"; filter: "time" }
  | { ok: false; error: "NO_MATCHES"; filter: "budget"; cheapest: number };

// Slots carry their IST offset ("2026-11-03T09:00:00+05:30"), so HH:MM is local time.
const localTime = (slot: string): string => slot.slice(11, 16);

const inTime = (slot: string, w: TimeWindow): boolean => {
  const t = localTime(slot);
  return (w.earliest === null || t >= w.earliest) && (w.latest === null || t < w.latest);
};

export const searchRange = (w: TimeWindow, clock: Clock): { from: string; to: string } => {
  const days = slotWindow(clock);
  return { from: w.dateFrom ?? days[0]!, to: w.dateTo ?? days[days.length - 1]! };
};

/** Time filter first, then budget — so NO_MATCHES names the filter that emptied the list. */
export const buildOptions = (
  providers: ProviderSummary[],
  filters: { timeWindow: TimeWindow; budget: unknown },
): OptionsResult => {
  const fitting = providers
    .map((p) => ({ p, slots: p.slots.filter((s) => inTime(s, filters.timeWindow)).sort() }))
    .filter((x) => x.slots.length > 0);
  if (fitting.length === 0) return { ok: false, error: "NO_MATCHES", filter: "time" };

  const budget = typeof filters.budget === "number" ? filters.budget : null;
  const affordable = budget === null ? fitting : fitting.filter((x) => x.p.price <= budget);
  if (affordable.length === 0)
    return {
      ok: false,
      error: "NO_MATCHES",
      filter: "budget",
      cheapest: Math.min(...fitting.map((x) => x.p.price)),
    };

  const ordered = [...affordable].sort(
    (a, b) =>
      a.slots[0]!.localeCompare(b.slots[0]!) || b.p.rating - a.p.rating || a.p.id.localeCompare(b.p.id),
  );
  return {
    ok: true,
    blocks: ordered.map((x) => ({
      provider: { id: x.p.id, name: x.p.name, rating: x.p.rating, price: x.p.price },
      slots: x.slots.map((start) => ({ start, pickText: pickText(x.p.name, start) })),
    })),
  };
};
