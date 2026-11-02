import { describe, expect, it } from "vitest";
import { createClock } from "../shared/clock.js";
import { createTestDb } from "../shared/test-db.js";
import { DEMO_USERS } from "../shared/demo-users.js";
import { seedDemoUsers } from "../auth/index.js";
import { runScenario } from "./runner.js";
import { SCENARIOS } from "./scenarios.js";

function evalWorld() {
  const testDb = createTestDb();
  const clock = createClock({ now: new Date("2026-11-02T03:45:00Z") });
  seedDemoUsers(testDb.db, clock.now().getTime());
  return { testDb, clock, user: DEMO_USERS[0]!.id };
}

describe("the eval runner", () => {
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