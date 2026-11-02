import type { Clock } from "../shared/clock.js";
import { slotWindow, type ProviderSummary } from "../tools/index.js";
import type { TimeWindow } from "./time-window.js";

// Search results → option blocks (FR-9, § 2.5.2 `searching`). Pure: the workflow
// stores the blocks as candidates and the reply part is drawn from them.

export type OptionBlock = {
  number: number;
  provider: { id: string; name: string; rating: number; price: number };
  slots: { letter: string; start: string }[];
};

export type OptionsResult =
  | { ok: true; blocks: OptionBlock[] }
  | { ok: false; error: "NO_MATCHES"; filter: "time" }
  | { ok: false; error: "NO_MATCHES"; filter: "budget"; cheapest: number };

/** @remarks Letters run a…z, so a block shows at most this many (earliest first). */
export const MAX_SLOTS_PER_PROVIDER = 8;

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
    blocks: ordered.map((x, i) => ({
      number: i + 1,
      provider: { id: x.p.id, name: x.p.name, rating: x.p.rating, price: x.p.price },
      slots: x.slots
        .slice(0, MAX_SLOTS_PER_PROVIDER)
        .map((start, j) => ({ letter: String.fromCharCode(97 + j), start })),
    })),
  };
};
