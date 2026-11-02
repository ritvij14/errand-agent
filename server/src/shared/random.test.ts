import { describe, expect, it } from "vitest";
import { randomDraw } from "./random.js";

describe("seeded random", () => {
  it("same seed + inputs + attempt → same draw", () => {
    const a = randomDraw({ seed: "test-seed", tool: "book", inputs: ["k1"], attempt: 1 });
    const b = randomDraw({ seed: "test-seed", tool: "book", inputs: ["k1"], attempt: 1 });
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
  });

  it("different inputs → different draws", () => {
    const a = randomDraw({ seed: "s", tool: "book", inputs: ["k1"], attempt: 1 });
    const b = randomDraw({ seed: "s", tool: "book", inputs: ["k2"], attempt: 1 });
    expect(a).not.toBe(b);
  });

  it("different attempt number → a new independent draw", () => {
    const first = randomDraw({ seed: "s", tool: "book", inputs: ["k1"], attempt: 0 });
    const second = randomDraw({ seed: "s", tool: "book", inputs: ["k1"], attempt: 1 });
    expect(first).not.toBe(second);
  });

  it("different tool → different draws for the same inputs", () => {
    const a = randomDraw({ seed: "s", tool: "book", inputs: ["k1"], attempt: 1 });
    const b = randomDraw({ seed: "s", tool: "hold_slot", inputs: ["k1"], attempt: 1 });
    expect(a).not.toBe(b);
  });
});