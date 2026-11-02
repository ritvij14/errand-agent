import { describe, expect, it } from "vitest";
import { createClock } from "../shared/clock.js";
import { createTestDb } from "../shared/test-db.js";
import { DEMO_USERS } from "../shared/demo-users.js";
import { seedDemoUsers } from "../auth/index.js";
import { checkInvariants, runScenario } from "./runner.js";
import { SCENARIOS } from "./scenarios.js";

function evalWorld() {
  const testDb = createTestDb();
  const clock = createClock({ now: new Date("2026-11-02T03:45:00Z") });
  seedDemoUsers(testDb.db, clock.now().getTime());
  return { testDb, clock, user: DEMO_USERS[0]!.id };
}

describe("the eval runner", () => {
  it("every scenario that approves a booking queues its book outcome, so it never depends on a random key (NFR-4)", () => {
    // operation ids (and so idempotency keys) are random UUIDs; an unforced `book` draws a different outcome each run
    const unforced = Object.values(SCENARIOS).filter((s) => {
      let queuedBooks = 0;
      let cardFromPick = false; // only the first approve of a picked slot's card reaches `book`
      return s.steps.some((step) => {
        // the write an approve after a pick makes: `book`, or `reschedule` for a moved booking
        if (step.step === "force" && (step.tool === "book" || step.tool === "reschedule")) queuedBooks += 1;
        if (step.step === "pick") cardFromPick = true;
        const approves =
          (step.step === "click" && step.decision === "approve") ||
          (step.step === "say" && step.text === "yes");
        if (!approves || !cardFromPick) return false;
        cardFromPick = false;
        if (queuedBooks === 0) return true;
        queuedBooks -= 1;
        return false;
      });
    });
    expect(unforced.map((s) => s.id)).toEqual([]);
  });

  it("passes scenario E0 (scripted hello → help reply), with invariants checked", async () => {
    const w = evalWorld();
    const result = await runScenario(w.testDb.db, SCENARIOS["E0"]!, w.user);
    expect(result.id).toBe("E0");
    expect(result.pass).toBe(true);
    expect(result.checkedInvariants).toContain("I-4");
    expect(result.checkedInvariants).toContain("I-5");
    expect(result.checkedInvariants).toContain("I-9");
    w.testDb.close();
  });

  it("eval 5's price check is real: without the forced price change the same scenario fails", async () => {
    const w = evalWorld();
    const five = SCENARIOS["5"]!;
    const unforced = { ...five, id: "5-unforced", steps: five.steps.filter((s) => s.step !== "force") };
    const result = await runScenario(w.testDb.db, unforced, w.user);
    expect(result.pass).toBe(false);
    expect(result.firstFailure).toMatch(/card price ≠ search price|quoted/);
    w.testDb.close();
  });

  it("fails a deliberately broken scenario and names the first failing check", async () => {
    const w = evalWorld();
    const broken = {
      id: "E0-broken",
      name: "deliberately broken",
      description: "expects a different outcome",
      seed: "eval-seed",
      steps: [
        { step: "say" as const, text: "hello" },
        { step: "expect" as const, outcome: "cap_model_calls" },
      ],
    };
    const result = await runScenario(w.testDb.db, broken, w.user);
    expect(result.pass).toBe(false);
    expect(result.firstFailure).toMatch(/expect/);
    w.testDb.close();
  });
});
describe("booking invariants catch what they claim to (§ 2.5.10)", () => {
  it("I-1: a provider-side booking made outside any operation is reported", async () => {
    const w = evalWorld();
    await runScenario(w.testDb.db, SCENARIOS["E0"]!, w.user); // seeds the mock world
    w.testDb.db
      .prepare(
        `INSERT INTO mock_booking (id, user_id, provider_id, service, area, slot, price, status, cancel_503_served, created_at, updated_at)
         VALUES ('rogue', ?, (SELECT id FROM mock_provider LIMIT 1), 'plumber', 'hsr_layout', '2026-11-05T10:00:00+05:30', 500, 'booked', 0, 1, 1)`,
      )
      .run(w.user);
    expect(checkInvariants(w.testDb.db, { modelCalls: 6, toolCalls: 10, elapsedMs: 60_000 })).toMatch(/^I-1/);
    w.testDb.close();
  });

  it("I-3: a 'Booked:' reply whose run never saw get_booking_status say booked is reported", async () => {
    const w = evalWorld();
    const result = await runScenario(w.testDb.db, SCENARIOS["E0"]!, w.user);
    expect(result.pass).toBe(true);
    w.testDb.db.prepare(`UPDATE message SET text = 'Booked: nothing really' WHERE role = 'agent'`).run();
    expect(checkInvariants(w.testDb.db, { modelCalls: 6, toolCalls: 10, elapsedMs: 60_000 })).toMatch(/^I-3/);
    w.testDb.close();
  });

  it("I-10: another user's booking id in a run's tool results or reply is reported", async () => {
    const w = evalWorld();
    const result = await runScenario(w.testDb.db, SCENARIOS["E0"]!, "u-demo-bob");
    expect(result.pass).toBe(true);
    // alice's seeded booking leaking into bob's reply
    w.testDb.db
      .prepare(
        `UPDATE message SET parts = '[{"type":"bookings_list","bookings":[{"id":"mb-demo-ac"}]}]' WHERE role = 'agent'`,
      )
      .run();
    expect(checkInvariants(w.testDb.db, { modelCalls: 6, toolCalls: 10, elapsedMs: 60_000 })).toMatch(
      /^I-10/,
    );
    w.testDb.close();
  });

  it("eval 23 runs as the scenario's user, so isolation is checked from bob's side", async () => {
    const w = evalWorld();
    const result = await runScenario(w.testDb.db, SCENARIOS["23"]!, w.user);
    expect(result.pass).toBe(true);
    const runUsers = w.testDb.db.prepare(`SELECT DISTINCT user_id FROM run`).all() as { user_id: string }[];
    expect(runUsers).toEqual([{ user_id: "u-demo-bob" }]);
    w.testDb.close();
  });
});
