import { describe, expect, it } from "vitest";
import { createClock } from "../shared/clock.js";
import { scriptedModel, type ReadResult } from "./index.js";

// The scripted model's phrase table (V-1): phrases the agent must read correctly.
// Fixed "now" per the design's readings: Mon 2026-11-02 09:15 IST.

const FIX_NOW = new Date("2026-11-02T03:45:00Z");
const read = async (text: string) =>
  scriptedModel.read({ text, waitingFor: "", clock: createClock({ now: FIX_NOW }) });

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

  it("a full booking request carries service + area + time window in one go", async () => {
    const result = await read("plumber this week, mornings only, under ₹1,500 in HSR Layout");
    expect(result).toMatchObject({
      kind: "workflow",
      intent: "book",
      service: "plumber",
      area: "hsr_layout",
      budget: 1500,
    });
    if (result.kind === "workflow") {
      expect(result.timeWindow).toMatchObject({
        dateFrom: "2026-11-02",
        dateTo: "2026-11-08",
        latest: "12:00",
      });
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

  it('memory reads (MH-6): "I live in HSR" states an area, "forget my area" forgets, "what do you remember" views; a one-off area never states', async () => {
    expect(await read("I live in HSR")).toMatchObject({
      kind: "memory_save",
      key: "area",
      value: "hsr_layout",
    });
    expect(await read("my area is Koramangala now")).toMatchObject({
      kind: "memory_save",
      key: "area",
      value: "koramangala",
    });
    expect(await read("never before 10am")).toMatchObject({
      kind: "memory_save",
      key: "earliest_time",
      value: "10:00",
    });
    expect(await read("forget my area")).toMatchObject({ kind: "memory_forget", key: "area" });
    for (const text of ["forget everything you know about me", "forget all my preferences", "forget me"])
      expect(await read(text)).toEqual({ kind: "memory_forget", key: "all" });
    expect(await read("what do you remember about me?")).toMatchObject({ kind: "memory_view" });
    // a one-off area is a booking request, never a memory save
    expect(await read("plumber in HSR")).toMatchObject({
      kind: "workflow",
      intent: "book",
      area: "hsr_layout",
    });
  });

  it("a 'not before' inside a booking request is this request's time, never a saved preference (MH-1, MH-6)", async () => {
    expect(await read("Book the same electrician as last time, but not before 10 a.m.")).toMatchObject({
      kind: "workflow",
      intent: "book",
      service: "electrician",
      sameAsLast: true,
      timeWindow: { earliest: "10:00" },
    });
    expect(await read("electrician in Koramangala tomorrow, not before 10am")).toMatchObject({
      kind: "workflow",
      service: "electrician",
      area: "koramangala",
      timeWindow: { dateFrom: "2026-11-03", earliest: "10:00" },
    });
    // a request that names a service stays a request even with lasting phrasing
    expect(await read("plumber in HSR tomorrow, never before 10am")).toMatchObject({
      kind: "workflow",
      service: "plumber",
      timeWindow: { earliest: "10:00" },
    });
    expect(await read("I need a plumber, I live in HSR")).toMatchObject({
      kind: "workflow",
      service: "plumber",
      area: "hsr_layout",
    });
    // a bare 'not before 10' answers 'when?' — only 'never before' is lasting
    expect(await read("not before 10am")).toMatchObject({
      kind: "workflow",
      timeWindow: { earliest: "10:00" },
    });
  });

  it('"cancel that" / "never mind" / "stop" / "forget it" are drops; "cancel my AC servicing" is the cancel action (FR-16, V-10)', async () => {
    expect(await read("cancel that")).toMatchObject({ kind: "drop" });
    expect(await read("never mind")).toMatchObject({ kind: "drop" });
    expect(await read("stop")).toMatchObject({ kind: "drop" });
    expect(await read("forget it")).toMatchObject({ kind: "drop" });
    expect(await read("cancel my AC servicing")).toMatchObject({ kind: "cancel" });
    expect(await read("cancel my AC servicing")).not.toMatchObject({ kind: "drop" });
  });

  it("drop words inside an ordinary sentence are not a drop (FR-16)", async () => {
    expect(await read("I need a plumber in HSR, my kitchen tap wont stop leaking")).toMatchObject({
      kind: "workflow",
      service: "plumber",
      area: "hsr_layout",
    });
    expect(await read("plumber in HSR this week, not that expensive please")).toMatchObject({
      kind: "workflow",
      service: "plumber",
    });
    expect(await read("not that expensive please")).not.toMatchObject({ kind: "drop" });
    expect(await read("I don't need it anymore")).toEqual({ kind: "drop" });
    expect(await read("Stop.")).toEqual({ kind: "drop" });
  });

  it("'never mind, <new request>' drops and carries the new request along", async () => {
    expect(await read("never mind, I want an electrician in HSR tomorrow")).toEqual({
      kind: "drop",
      rest: "I want an electrician in HSR tomorrow",
    });
    expect(await read("forget it. electrician in Koramangala")).toEqual({
      kind: "drop",
      rest: "electrician in Koramangala",
    });
  });

  it('"tell me about provider 2" / a provider name with options → details read (FR-6)', async () => {
    const options = [
      {
        provider: { id: "mp-001", name: "Sri Sai Plumbing Works", rating: 4.1, price: 500 },
        slots: [{ start: "2026-11-06T10:00:00+05:30", label: "", pickText: "" }],
      },
      { provider: { id: "mp-010", name: "Kalyani Woodworks", rating: 4.4, price: 800 }, slots: [] },
    ];
    const withOptions = (text: string) =>
      scriptedModel.read({ text, waitingFor: "choosing", clock: createClock({ now: FIX_NOW }), options });
    expect(await withOptions("tell me about provider 2")).toMatchObject({
      kind: "provider_details",
      providerId: "mp-010",
    });
    expect(await withOptions("Tell me more about Kalyani Woodworks")).toMatchObject({
      kind: "provider_details",
      providerId: "mp-010",
    });
    expect(await withOptions("tell me about the provider with the best warranty")).toMatchObject({
      kind: "provider_details",
    });
  });

  it('"correction phrase but not a time fact" merges; "never mind" is a drop', async () => {
    expect(await read("never mind")).toMatchObject({ kind: "drop" });
    expect(await read("forget it")).toMatchObject({ kind: "drop" });
    expect(await read("no, keep my budget but after 11")).toMatchObject({
      kind: "correction",
      target: "time_window",
    });
  });

  it("plain yes/no are decision answers when something is waiting", async () => {
    expect(await read("yes")).toMatchObject({ kind: "decision", decision: "yes" });
    expect(await read("no")).toMatchObject({ kind: "decision", decision: "no" });
    expect(await read("confirm")).toMatchObject({ kind: "decision", decision: "yes" });
  });
});
describe("only a plain yes counts (§ 2.5.5 rule 2)", () => {
  it("plain yes / no phrases are decisions", async () => {
    for (const text of ["yes", "Yes!", "confirm", "go ahead", "book it", "ok"])
      expect(await read(text)).toEqual({ kind: "decision", decision: "yes" });
    for (const text of ["no", "decline", "not this one"])
      expect(await read(text)).toEqual({ kind: "decision", decision: "no" });
  });

  it("a yes or no carrying a change is a correction, never an approval", async () => {
    expect(await read("yes but 11am")).toMatchObject({
      kind: "correction",
      target: "time_window",
      mergeTime: true,
    });
    expect(await read("yes, but make the budget ₹900")).toMatchObject({
      kind: "correction",
      target: "budget",
      budget: 900,
    });
  });

  it("a yes with words we can't read is not an approval either", async () => {
    expect((await read("yes but hmm")).kind).toBe("unknown");
  });
});
