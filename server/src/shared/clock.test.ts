import { describe, expect, it } from "vitest";
import { createClock, isoInIst } from "./clock.js";

describe("clock", () => {
  it("returns the fixed now it was created with", () => {
    const start = new Date("2026-11-02T06:30:00Z"); // 12:00 IST
    const clock = createClock({ now: start });
    expect(clock.now().getTime()).toBe(start.getTime());
  });

  it("defaults to real time when no now is given", () => {
    const clock = createClock();
    const before = Date.now();
    const seen = clock.now().getTime();
    const after = Date.now();
    expect(seen).toBeGreaterThanOrEqual(before);
    expect(seen).toBeLessThanOrEqual(after);
  });

  it("the default clock keeps following real time after it is created", async () => {
    const clock = createClock();
    const first = clock.now().getTime();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(clock.now().getTime() - first).toBeGreaterThanOrEqual(50);
  });

  it("the default clock stays on real time: a simulated pause (advanceMs) doesn't push it ahead", () => {
    const clock = createClock();
    clock.advanceMs(10_000);
    expect(Math.abs(clock.now().getTime() - Date.now())).toBeLessThan(1_000);
  });

  it("advanceMs moves now and returns the new time", () => {
    const clock = createClock({ now: new Date("2026-11-02T06:30:00Z") });
    const moved = clock.advanceMs(10 * 60 * 1000);
    expect(moved.toISOString()).toBe("2026-11-02T06:40:00.000Z");
    expect(clock.now().toISOString()).toBe("2026-11-02T06:40:00.000Z");
  });

  it("setNow jumps to the given time", () => {
    const clock = createClock({ now: new Date("2026-11-02T06:30:00Z") });
    clock.setNow(new Date("2026-11-08T00:00:00Z"));
    expect(clock.now().toISOString()).toBe("2026-11-08T00:00:00.000Z");
  });
});

describe("IST", () => {
  it("formats a time in Asia/Kolkata", () => {
    const seen = isoInIst(new Date("2026-11-07T09:00:00Z"));
    expect(seen).toMatch(/14:30/);
  });

  it("keeps the same IST day across the 23:30 IST boundary", () => {
    // 2026-11-07T17:30Z = 23:00 IST on Nov 7; 20 minutes later it is Nov 8 in IST
    const beforeMidnight = isoInIst(new Date("2026-11-07T17:30:00Z"));
    const afterMidnight = isoInIst(new Date("2026-11-07T18:30:00Z"));
    expect(beforeMidnight).toMatch(/2026-11-07/);
    expect(afterMidnight).toMatch(/2026-11-08/);
  });
});