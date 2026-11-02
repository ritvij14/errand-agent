import { describe, expect, it } from "vitest";
import { createClock } from "../shared/clock.js";
import { createTestDb } from "../shared/test-db.js";
import { scriptedModel } from "./index.js";
import { seedDemoUsers } from "../auth/index.js";
import { createWorkflowStore } from "./workflow.js";
import { startTrace, readTrace } from "../tracing/index.js";

// The state machine's collecting phase (MH-1, FR-7, FR-8): ask once for everything
// missing; a correction changes one thing and clears only what was built from it.
// Fixed now: Mon 2026-11-02 09:15 IST.

function fresh() {
  const testDb = createTestDb();
  const clock = createClock({ now: new Date("2026-11-02T03:45:00Z") });
  seedDemoUsers(testDb.db, clock.now().getTime());
  testDb.db.prepare(`INSERT INTO conversation (id, user_id, title, created_at, updated_at) VALUES ('1', 'u-demo-alice', 'test', 1, 1)`).run();
  const store = createWorkflowStore(testDb.db, clock, scriptedModel);
  return { testDb, clock, store };
}

const ALICE = "u-demo-alice";

describe("collecting", () => {
  it("asks once for every required detail that is missing", async () => {
    const { testDb, store } = fresh();
    const outcome = await store.applyUserText(ALICE, "1", "I need a plumber");
    expect(outcome.phase).toBe("collecting");
    expect(outcome.reply.toLowerCase()).toMatch(/area|where/i);
    expect(outcome.reply.toLowerCase()).toMatch(/when|time|day/i);
    expect(outcome.reply.toLowerCase()).not.toMatch(/budget/); // optional, not asked (V-1)
    testDb.close();
  });

  it("never re-asks a known fact; answering the missing details ends collecting", async () => {
    const { testDb, store } = fresh();
    const first = await store.applyUserText(ALICE, "1", "I need a plumber");
    expect(first.facts.service).toMatchObject({ value: "plumber", source: "user" });
    expect(first.facts.area).toBeUndefined();
    const outcome = await store.applyUserText(ALICE, "1", "in HSR Layout, this week mornings only");
    expect(outcome.facts.area).toMatchObject({ value: "hsr_layout" });
    expect(outcome.facts.time_window?.value).toMatchObject({ dateFrom: "2026-11-02", latest: "12:00" });
    expect(outcome.phase).toBe("searching");
    testDb.close();
  });

  it("optional details ('any budget') are stored and never asked again (V-1)", async () => {
    const { testDb, store } = fresh();
    const outcome = await store.applyUserText(ALICE, "1", "book deep cleaning in Jayanagar this week, any budget");
    expect(outcome.facts.budget).toMatchObject({ value: "any" });
    const follow = await store.applyUserText(ALICE, "1", "mornings are fine");
    expect(follow.reply.toLowerCase()).not.toMatch(/budget/); // never re-asked
    expect(follow.phase).toBe("searching");
    testDb.close();
  });

  it("unknown area: the reply names what is available and saves only the valid detail", async () => {
    const { testDb, store } = fresh();
    const outcome = await store.applyUserText(ALICE, "1", "plumber in Goa this week");
    expect(outcome.facts.area).toBeUndefined();
    expect(outcome.facts.time_window).toBeUndefined();
    expect(outcome.reply).toMatch(/indiranagar|hsr/i);
    expect(outcome.phase).toBe("collecting");
    testDb.close();
  });

  it("a time outside the window → TIME_OUT_OF_RANGE style reply, time not saved", async () => {
    const { testDb, store } = fresh();
    const outcome = await store.applyUserText(ALICE, "1", "plumber in Indiranagar last Saturday");
    expect(outcome.facts.area).toMatchObject({ value: "indiranagar" });
    expect(outcome.facts.time_window).toBeUndefined();
    expect(outcome.reply.toLowerCase()).toMatch(/past|next 14 days|within/i);
    testDb.close();
  });
});

describe("corrections cascade (rule 2)", () => {
  it("correcting the budget after a search keeps service, area and time, clears candidates", async () => {
    const { testDb, store } = fresh();
    await store.applyUserText(ALICE, "1", "plumber in HSR Layout this week");
    await store.setCandidates("1", [{ id: "p1" }, { id: "p2" }]);
    const outcome = await store.applyUserText(ALICE, "1", "make the budget ₹900");
    expect(outcome.facts.budget).toMatchObject({ value: 900 });
    expect(outcome.facts.service).toMatchObject({ value: "plumber" });
    expect(outcome.phase).toBe("searching");
    expect(store.getActiveWorkflow("1")!.candidates).toBeFalsy(); // cleared by the cascade
    testDb.close();
  });

  it("a partial time correction merges into the known window and keeps the rest (R9)", async () => {
    const { testDb, store } = fresh();
    await store.applyUserText(ALICE, "1", "book plumber in HSR this Saturday");
    const outcome = await store.applyUserText(ALICE, "1", "make it after 11am");
    expect(outcome.facts.time_window?.value).toMatchObject({ dateFrom: "2026-11-07", dateTo: "2026-11-07", earliest: "11:00" });
    expect(outcome.facts.area).toMatchObject({ value: "hsr_layout" });
    testDb.close();
  });

  it("a stale version save is rejected (optimistic concurrency)", async () => {
    const { testDb, store } = fresh();
    await store.applyUserText(ALICE, "1", "I need a plumber");
    const before = store.currentVersion("1");
    await store.applyUserText(ALICE, "1", "in HSR Layout this week");
    expect(store.currentVersion("1")).toBe(before + 1);
    const stale = store.saveWorkflow("1", before, (w) => ({ ...w, phase: "abandoned" }));
    expect(stale.ok).toBe(false);
    testDb.close();
  });
});

describe("tracing (MH-7)", () => {
  it("the run trace shows facts filling in and the move to searching", async () => {
    const { testDb, clock, store } = fresh();
    store.useTrace(startTrace(testDb.db, clock, "run-t1"));
    await store.applyUserText(ALICE, "1", "I need a plumber");
    await store.applyUserText(ALICE, "1", "in HSR Layout this week");
    const events = readTrace(testDb.db, "run-t1");
    const facts = events.filter((e) => e.type === "fact_changed").map((e) => (e.data as { key: string }).key);
    expect(facts).toEqual(expect.arrayContaining(["service", "area", "time_window"]));
    expect(events.some((e) => e.type === "state_transition" && (e.data as { toPhase: string }).toPhase === "searching")).toBe(true);
    testDb.close();
  });
});
