import { describe, expect, it } from "vitest";
import { createClock } from "../shared/clock.js";
import { createTestDb, type TestDb } from "../shared/test-db.js";
import type { Db } from "../shared/db.js";
import { startTrace, readTrace } from "./tracing.js";

function traced(o?: { testDb?: TestDb; db?: Db }) {
  const testDb = o?.testDb ?? createTestDb();
  const db = o?.db ?? (testDb.db as Db);
  const clock = createClock({ now: new Date("2026-11-02T03:45:00Z") });
  return { testDb, db, clock };
}

describe("recording", () => {
  it("keeps events in order with seq 1, 2, 3 …", () => {
    const { testDb, db, clock } = traced();
    const trace = startTrace(db, clock, "run-1");
    trace.record("run_started", { trigger: "message" });
    clock.advanceMs(1200);
    trace.record("model_call", { job: "read", output: "ok", durationMs: 4, tokens: null, cost: null });
    trace.record("run_ended", { outcome: "completed", modelCalls: 1, toolCalls: 0, durationMs: 9 });
    const events = readTrace(db, "run-1");
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events.map((e) => e.type)).toEqual(["run_started", "model_call", "run_ended"]);
    testDb.close();
  });

  it("clock_at follows the calendar clock, duration_ms comes from the caller", () => {
    const { testDb, db, clock } = traced();
    const trace = startTrace(db, clock, "run-2");
    trace.record("run_started", { trigger: "message" });
    clock.advanceMs(10_000); // simulated timeout pause on the calendar clock
    trace.record("tool_call", { tool: "book", args: { holdId: "h1" } }, 0);
    const events = readTrace(db, "run-2");
    expect(events[0]!.clockAt).toBe(Date.parse("2026-11-02T03:45:00Z"));
    expect(events[1]!.clockAt).toBe(Date.parse("2026-11-02T03:45:10Z"));
    expect(events[1]!.durationMs).toBe(0); // real elapsed ~0 even though clock jumped 10 s (R8 story)
    testDb.close();
  });

  it("drops fields outside the type's allow-list (no secrets by construction)", () => {
    const { testDb, db, clock } = traced();
    const trace = startTrace(db, clock, "run-3");
    trace.record("model_call", {
      job: "read",
      input: "hello",
      password: "hunter2hunter2",
      authSessionToken: "leak-me",
      sessionCookie: "xyz",
    });
    const events = readTrace(db, "run-3");
    const raw = JSON.stringify(events[0]?.data);
    expect(raw).not.toContain("hunter2hunter2");
    expect(raw).not.toContain("leak-me");
    expect(raw).not.toContain("sessionCookie");
    expect(raw).toContain('"input":"hello"');
    testDb.close();
  });

  it("model calls record tokens and cost as null with not_available: scripted model", () => {
    const { testDb, db, clock } = traced();
    const trace = startTrace(db, clock, "run-4");
    trace.record("model_call", { job: "write" });
    const events = readTrace(db, "run-4");
    const data = events[0]?.data as { tokens?: unknown; cost?: unknown; notAvailable?: string };
    expect(data.tokens).toBeNull();
    expect(data.cost).toBeNull();
    expect(data.notAvailable).toBe("scripted model");
    testDb.close();
  });
});

describe("reading", () => {
  it("returns nothing for an unknown run", () => {
    const { testDb, db } = traced();
    expect(readTrace(db, "run-none")).toEqual([]);
    testDb.close();
  });
});