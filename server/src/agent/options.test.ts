import { describe, expect, it } from "vitest";
import { createClock } from "../shared/clock.js";
import { buildOptions, searchRange } from "./options.js";
import type { TimeWindow } from "./time-window.js";

const provider = (id: string, price: number, slots: string[], rating = 4.5) => ({
  id,
  name: `Provider ${id}`,
  price,
  rating,
  attributes: {},
  slots,
});
const at = (day: string, hhmm: string) => `2026-11-${day}T${hhmm}:00+05:30`;
const anyTime: TimeWindow = { dateFrom: null, dateTo: null, earliest: null, latest: null };

describe("option blocks (FR-9)", () => {
  it("groups slots by provider and orders providers by their earliest slot, slots earliest first", () => {
    const result = buildOptions(
      [
        provider("late", 900, [at("05", "10:00")]),
        provider("early", 900, [at("03", "14:00"), at("03", "09:00")]),
      ],
      { timeWindow: anyTime, budget: undefined },
    );
    expect(result).toEqual({
      ok: true,
      blocks: [
        {
          provider: { id: "early", name: "Provider early", rating: 4.5, price: 900 },
          slots: [
            { start: at("03", "09:00"), label: "Tue 3 Nov at 09:00", pickText: "Book Provider early on Tue 3 Nov at 09:00" },
            { start: at("03", "14:00"), label: "Tue 3 Nov at 14:00", pickText: "Book Provider early on Tue 3 Nov at 14:00" },
          ],
        },
        {
          provider: { id: "late", name: "Provider late", rating: 4.5, price: 900 },
          slots: [{ start: at("05", "10:00"), label: "Thu 5 Nov at 10:00", pickText: "Book Provider late on Thu 5 Nov at 10:00" }],
        },
      ],
    });
  });

  it("shows every matching slot, however many (ADR-007: no letters to run out)", () => {
    const many = [...Array(40).keys()].map((i) =>
      at(String(3 + Math.floor(i / 4)).padStart(2, "0"), `${String(8 + (i % 4)).padStart(2, "0")}:00`),
    );
    const result = buildOptions([provider("p", 900, many)], { timeWindow: anyTime, budget: undefined });
    expect(result.ok && result.blocks[0]!.slots).toHaveLength(40);
  });

  it("drops providers over budget; 'any' budget keeps everyone", () => {
    const providers = [
      provider("cheap", 800, [at("03", "09:00")]),
      provider("pricey", 1600, [at("03", "10:00")]),
    ];
    const capped = buildOptions(providers, { timeWindow: anyTime, budget: 1500 });
    expect(capped.ok && capped.blocks.map((b) => b.provider.id)).toEqual(["cheap"]);
    const any = buildOptions(providers, { timeWindow: anyTime, budget: "any" });
    expect(any.ok && any.blocks.length).toBe(2);
  });

  it("keeps only slots inside the earliest / latest bounds (mornings only = before 12:00)", () => {
    const result = buildOptions(
      [provider("p", 900, [at("03", "09:00"), at("03", "11:00"), at("03", "12:00"), at("03", "15:00")])],
      {
        timeWindow: { ...anyTime, earliest: "10:00", latest: "12:00" },
        budget: undefined,
      },
    );
    expect(result.ok && result.blocks[0]!.slots.map((s) => s.start)).toEqual([at("03", "11:00")]);
  });

  it("NO_MATCHES names the time window when no slot fits the time", () => {
    const result = buildOptions([provider("p", 900, [at("03", "15:00")])], {
      timeWindow: { ...anyTime, latest: "12:00" },
      budget: 2000,
    });
    expect(result).toEqual({ ok: false, error: "NO_MATCHES", filter: "time" });
    expect(buildOptions([provider("p", 900, [])], { timeWindow: anyTime, budget: undefined })).toEqual({
      ok: false,
      error: "NO_MATCHES",
      filter: "time",
    });
  });

  it("NO_MATCHES names the budget when slots fit the time but every provider costs more", () => {
    const result = buildOptions([provider("p", 1600, [at("03", "09:00")])], {
      timeWindow: anyTime,
      budget: 900,
    });
    expect(result).toEqual({ ok: false, error: "NO_MATCHES", filter: "budget", cheapest: 1600 });
  });
});

describe("search range", () => {
  const clock = createClock({ now: new Date("2026-11-02T03:45:00Z") });
  it("uses the window's dates, and the full 14-day booking window when a date is open", () => {
    expect(searchRange({ ...anyTime, dateFrom: "2026-11-07", dateTo: "2026-11-07" }, clock)).toEqual({
      from: "2026-11-07",
      to: "2026-11-07",
    });
    expect(searchRange({ ...anyTime, earliest: "11:00" }, clock)).toEqual({
      from: "2026-11-02",
      to: "2026-11-15",
    });
  });
});
