import { describe, expect, it } from "vitest";
import { createClock } from "../shared/clock.js";
import { scriptedModel, type ReadResult } from "./index.js";

// The scripted model's phrase table (V-1): phrases the agent must read correctly.
// Fixed "now" per the design's readings: Mon 2026-11-02 09:15 IST.

const FIX_NOW = new Date("2026-11-02T03:45:00Z");
const read = async (text: string) => scriptedModel.read({ text, waitingFor: "", clock: createClock({ now: FIX_NOW }) });

describe("the scripted model reads V-1 phrases", () => {
  it('"I need a plumber" → book intent, plumbing service, nothing else', async () => {
    const result = await read("I need a plumber");
    expect(result).toMatchObject({ kind: "workflow", intent: "book", service: "plumber" });
    if (result.kind === "workflow") {
      expect(result.area).toBeUndefined();
      expect(result.timeWindow).toBeUndefined();
      expect(result.budget).toBeUndefined();
    }
  });

  it('"book AC servicing" → ac_servicing; "deep cleaning" / "carpenter" similarly', async () => {
    expect(await read("book ac cleaning")).toMatchObject({ service: "ac_servicing" });
    expect(await read("get deep cleaning")).toMatchObject({ service: "deep_cleaning" });
    expect(await read("need a carpenter")).toMatchObject({ service: "carpentry" });
  });

  it('areas: "in HSR Layout" → hsr_layout; Koramangala similarly', async () => {
    expect(await read("book a plumber in HSR Layout")).toMatchObject({ area: "hsr_layout" });
    expect(await read("plumber near Koramangala")).toMatchObject({ area: "koramangala" });
  });

  it('"under ₹1,500" → budget 1500', async () => {
    expect(await read("plumber under ₹1,500")).toMatchObject({ budget: 1500 });
    expect(await read("plumber under 800")).toMatchObject({ budget: 800 });
  });

  it('"any budget" / "don\'t care" → the any-reading, stored, never asked again (V-1)', async () => {
    const anyBudget = (await read("plumber, any budget")) as Extract<ReadResult, { kind: "workflow" }>;
    expect(anyBudget).toMatchObject({ budget: "any" });
    expect(anyBudget.area).toBeUndefined();
    const r = (await read("anytime is fine, deep cleaning")) as Extract<ReadResult, { kind: "workflow" }>;
    expect(r).toMatchObject({ service: "deep_cleaning" });
    expect(r.timeWindow).toBeUndefined();
  });

  it('a full booking request carries service + area + time window in one go', async () => {
    const result = await read("plumber this week, mornings only, under ₹1,500 in HSR Layout");
    expect(result).toMatchObject({
      kind: "workflow",
      intent: "book",
      service: "plumber",
      area: "hsr_layout",
      budget: 1500,
    });
    if (result.kind === "workflow") {
      expect(result.timeWindow).toMatchObject({ dateFrom: "2026-11-02", dateTo: "2026-11-08", latest: "12:00" });
    }
  });

  it("unknown service / area / gibberish → NOT_UNDERSTOOD (kind unknown)", async () => {
    expect(await read("book pest control")).toMatchObject({ kind: "workflow", unknownService: true });
    expect(await read("find a gardener")).toMatchObject({ kind: "workflow", unknownService: true });
    expect((await read("what's the weather?")).kind).toBe("unknown");
  });
});

describe("corrections (R9)", () => {
  it('"make it Saturday" → a time correction that merges', async () => {
    const result = await read("make it Saturday");
    expect(result).toMatchObject({ kind: "correction", target: "time_window" });
    if (result.kind === "correction") {
      expect(result.correctionText).toBe("Saturday");
      expect(result.mergeTime).toBe(true);
    }
  });

  it('"correction phrase but not a time fact" merges; "never mind" is a drop', async () => {
    expect(await read("never mind")).toMatchObject({ kind: "drop" });
    expect(await read("forget it")).toMatchObject({ kind: "drop" });
    expect(await read("no, keep my budget but after 11")).toMatchObject({ kind: "correction", target: "time_window" });
  });

  it('plain yes/no are decision answers when something is waiting', async () => {
    expect(await read("yes")).toMatchObject({ kind: "decision", decision: "yes" });
    expect(await read("no")).toMatchObject({ kind: "decision", decision: "no" });
    expect(await read("confirm")).toMatchObject({ kind: "decision", decision: "yes" });
  });
});