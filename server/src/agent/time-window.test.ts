import { describe, expect, it } from "vitest";
import { createClock, type Clock } from "../shared/clock.js";
import { parseTimeWindow, mergeCorrection, TIME_OUT_OF_RANGE, type TimeWindow } from "./time-window.js";

const FIX_NOW = new Date("2026-11-02T03:45:00Z"); // Mon 09:15 IST, Nov 2 (week: Mon Sep... Mon Nov 2)
const clockOf = (now = FIX_NOW): Clock => createClock({ now });

// Table rows (V-6): one row per phrase from the design + readings
const ROWS: { phrase: string; expected: Partial<Omit<TimeWindow, "raw">>; note?: string }[] = [
  {
    phrase: "this week, mornings only",
    expected: { dateFrom: "2026-11-02", dateTo: "2026-11-08", latest: "12:00" },
  },
  { phrase: "Saturday", expected: { dateFrom: "2026-11-07", dateTo: "2026-11-07" } },
  { phrase: "not before 10 a.m.", expected: { earliest: "10:00" } },
  { phrase: "between 9 and 11am", expected: { earliest: "09:00", latest: "11:00" } },
  { phrase: "tomorrow", expected: { dateFrom: "2026-11-03", dateTo: "2026-11-03" } },
  { phrase: "next Friday", expected: { dateFrom: "2026-11-13", dateTo: "2026-11-13" } },
  { phrase: "this evening", expected: { earliest: "17:00" } },
  { phrase: "anytime", expected: {} },
  { phrase: "after 4pm", expected: { earliest: "16:00" } },
  { phrase: "on 14 November", expected: { dateFrom: "2026-11-14", dateTo: "2026-11-14" } },
  // regression (U39): a bare "evening" / "afternoon" was silently dropped → 08:00 slots offered
  {
    phrase: "Saturday evening",
    expected: { dateFrom: "2026-11-07", dateTo: "2026-11-07", earliest: "17:00", latest: null },
  },
  { phrase: "evenings only", expected: { earliest: "17:00" } },
  {
    phrase: "tomorrow afternoon",
    expected: { dateFrom: "2026-11-03", dateTo: "2026-11-03", earliest: "12:00", latest: "17:00" },
  },
];

describe("parseTimeWindow (V-6)", () => {
  for (const row of ROWS) {
    it(`"${row.phrase}" → ${JSON.stringify(row.expected)}`, () => {
      const result = parseTimeWindow(row.phrase, clockOf());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const w = result.data;
      if (row.expected.dateFrom !== undefined) expect(w.dateFrom).toBe(row.expected.dateFrom);
      if (row.expected.dateTo !== undefined) expect(w.dateTo).toBe(row.expected.dateTo);
      if (row.expected.earliest !== undefined) expect(w.earliest).toBe(row.expected.earliest);
      if (row.expected.latest !== undefined) expect(w.latest).toBe(row.expected.latest);
    });
  }

  it('"this week" alone covers today (IST) through Sunday', () => {
    const result = parseTimeWindow("this week", clockOf());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.dateFrom).toBe("2026-11-02");
    expect(result.data.dateTo).toBe("2026-11-08");
  });

  // regression: "now" used to be written into `earliest` for the whole range, so in the
  // evening "this week, mornings only" became earliest 17:xx / latest 12:00 — every day empty
  it("a multi-day window said in the evening keeps every day's mornings (no 'now' bound)", () => {
    const evening = clockOf(new Date("2026-11-02T12:30:00Z")); // Mon 18:00 IST
    const result = parseTimeWindow("this week, mornings only", evening);
    expect(result).toEqual({
      ok: true,
      data: { dateFrom: "2026-11-02", dateTo: "2026-11-08", earliest: null, latest: "12:00" },
    });
    const after = parseTimeWindow("this week after 11", evening);
    expect(after.ok && after.data.dateFrom).toBe("2026-11-02"); // today's 18:00+ slots still count
  });

  it("past time → TIME_OUT_OF_RANGE", () => {
    const result = parseTimeWindow("last Saturday", clockOf());
    expect(result).toMatchObject({ ok: false, error: TIME_OUT_OF_RANGE });
  });

  it("beyond 14 days → TIME_OUT_OF_RANGE", () => {
    const result = parseTimeWindow("on 20 November", clockOf());
    expect(result).toMatchObject({ ok: false, error: TIME_OUT_OF_RANGE });
  });

  it("an unparseable phrase is an explicit failure, not a guessed window", () => {
    const result = parseTimeWindow("in the before-times", clockOf());
    expect(result.ok).toBe(false);
  });
});

describe("mergeCorrection (R9: partial time correction)", () => {
  it('"after 11" on a known window only moves the earliest bound, keeps dates', () => {
    const known: TimeWindow = {
      dateFrom: "2026-11-07",
      dateTo: "2026-11-07",
      earliest: "08:00",
      latest: null,
    };
    const merged = mergeCorrection(known, "after 11", clockOf());
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.data.dateFrom).toBe("2026-11-07"); // Saturday stays
    expect(merged.data.dateTo).toBe("2026-11-07");
    expect(merged.data.earliest).toBe("11:00");
  });

  it('"Saturday" on a known window keeps bounds, replaces dates', () => {
    const known: TimeWindow = {
      dateFrom: "2026-11-02",
      dateTo: "2026-11-08",
      earliest: "10:00",
      latest: "12:00",
    };
    const merged = mergeCorrection(known, "make it Saturday", clockOf());
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.data.dateFrom).toBe("2026-11-07");
    expect(merged.data.earliest).toBe("10:00");
    expect(merged.data.latest).toBe("12:00");
  });

  it("a correction beyond the 14-day window → TIME_OUT_OF_RANGE", () => {
    const known: TimeWindow = { dateFrom: "2026-11-10", dateTo: "2026-11-10", earliest: null, latest: null };
    expect(mergeCorrection(known, "make it 20 November", clockOf())).toMatchObject({
      ok: false,
      error: TIME_OUT_OF_RANGE,
    });
  });
});
