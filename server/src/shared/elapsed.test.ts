import { describe, expect, it } from "vitest";
import { createElapsed } from "./elapsed.js";

describe("elapsed", () => {
  it("starts near 0", () => {
    const timer = createElapsed();
    expect(timer.ms()).toBeLessThan(50);
  });

  it("grows with real time", async () => {
    const timer = createElapsed();
    await sleep(15);
    expect(timer.ms()).toBeGreaterThanOrEqual(10);
  });

  it("uses an injected ticking function for tests", () => {
    let virtual = 0;
    const timer = createElapsed({ nowMs: () => virtual });
    expect(timer.ms()).toBe(0);
    virtual = 5000;
    expect(timer.ms()).toBe(5000);
  });
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}