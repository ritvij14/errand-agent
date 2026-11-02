import { describe, expect, it } from "vitest";
import { CapHit, createRunBudget } from "./run-budget.js";

const still = { ms: () => 0 }; // an elapsed timer that never moves on its own

const capOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof CapHit ? error.cap : "other";
  }
  return undefined;
};

describe("the run budget (NFR-1, § 2.5.3 caps)", () => {
  it("allows 6 model calls and refuses the 7th before it is made", () => {
    const budget = createRunBudget({ elapsed: still });
    for (let i = 0; i < 6; i += 1) budget.beforeModelCall();
    expect(capOf(() => budget.beforeModelCall())).toBe("cap_model_calls");
    expect(budget.used().modelCalls).toBe(6);
  });

  it("allows 10 tool calls and refuses the 11th before it is made", () => {
    const budget = createRunBudget({ elapsed: still });
    for (let i = 0; i < 10; i += 1) budget.beforeToolCall();
    expect(capOf(() => budget.beforeToolCall())).toBe("cap_tool_calls");
    expect(budget.used().toolCalls).toBe(10);
  });

  it("a simulated wait counts toward the 60 s and is cut short at the time left (R8)", () => {
    const budget = createRunBudget({ elapsed: still });
    expect(budget.wait(25_000)).toBe(25_000);
    expect(budget.wait(50_000)).toBe(35_000); // only what is left
    expect(capOf(() => budget.checkTime())).toBe("cap_time");
    expect(capOf(() => budget.beforeToolCall())).toBe("cap_time");
  });

  it("real elapsed time counts too, whatever the calendar clock says", () => {
    let now = 0;
    const budget = createRunBudget({ elapsed: { ms: () => now } });
    now = 60_001;
    expect(capOf(() => budget.beforeModelCall())).toBe("cap_time");
  });

  it("awaited work that outlives the time left is stopped at the deadline (R8)", async () => {
    const budget = createRunBudget({ caps: { modelCalls: 6, toolCalls: 10, elapsedMs: 50 } });
    const started = performance.now();
    const slow = new Promise((resolve) => setTimeout(() => resolve("late"), 400));
    await expect(budget.race(slow)).rejects.toMatchObject({ cap: "cap_time" });
    expect(performance.now() - started).toBeLessThan(300);
  });

  it("awaited work that finishes in time returns its result", async () => {
    const budget = createRunBudget();
    await expect(budget.race(Promise.resolve("ok"))).resolves.toBe("ok");
  });
});
