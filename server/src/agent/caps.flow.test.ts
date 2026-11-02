import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createClock } from "../shared/clock.js";
import { createTestDb } from "../shared/test-db.js";
import type { Caps } from "../shared/run-budget.js";
import { seedDemoUsers } from "../auth/index.js";
import { createMockSettings, seedMockWorld, type ForcedQueue, type MockSettings } from "../tools/index.js";
import { createConversationService } from "../conversations/index.js";
import { readTrace } from "../tracing/index.js";
import { scriptedModel, type AgentModel } from "./index.js";
import type { OptionBlock } from "./options.js";

// Caps and truthful endings (MH-5, NFR-1, FR-14, § 2.5.3, R5, R8). Every way a run
// can end is recorded as its outcome and comes with a clear reply.

const ALICE = "u-demo-alice";
const REQUEST = "plumber in HSR Layout this week, mornings only, under ₹1,500";

const setup = (o?: { caps?: Caps; model?: AgentModel; settings?: Partial<MockSettings> }) => {
  const testDb = createTestDb();
  const clock = createClock({ now: new Date("2026-11-02T03:45:00Z") });
  seedDemoUsers(testDb.db, clock.now().getTime());
  seedMockWorld(testDb.db, { seed: "errand-agent-v1", clock });
  const queue: { tool: string; outcome: string }[] = [];
  const force = (tool: string, ...outcomes: string[]) =>
    outcomes.forEach((outcome) => queue.push({ tool, outcome }));
  const forced: ForcedQueue = {
    take: (tool) => {
      const i = queue.findIndex((q) => q.tool === tool);
      return i === -1 ? undefined : { outcome: queue.splice(i, 1)[0]!.outcome };
    },
  };
  const service = createConversationService({
    db: testDb.db,
    clock,
    model: o?.model ?? scriptedModel,
    caps: o?.caps,
    mock: { forced, settings: { ...createMockSettings(), ...o?.settings } },
  });
  const conversationId = service.createConversation(ALICE).id;
  const say = async (text: string) => {
    const result = await service.sendMessage(ALICE, conversationId, text, randomUUID());
    if (!result.ok) throw new Error(result.code);
    return result.reply;
  };
  /** search, pick the first slot, queue the book outcomes, approve */
  const approveWith = async (...bookOutcomes: string[]) => {
    const blocks = (await say(REQUEST)).message.parts.find((p) => p.type === "option_blocks")!
      .blocks as OptionBlock[];
    const card = (await say(blocks[0]!.slots[0]!.pickText)).message.parts.find(
      (p) => p.type === "approval_card",
    ) as { approvalId: string };
    force("book", ...bookOutcomes);
    const result = await service.decideApproval(ALICE, card.approvalId, "approve");
    if (!result.ok) throw new Error(result.code);
    return result.reply;
  };
  const run = (id: string) =>
    testDb.db.prepare(`SELECT outcome, model_calls, tool_calls, ended_at FROM run WHERE id = ?`).get(id) as {
      outcome: string;
      model_calls: number;
      tool_calls: number;
      ended_at: number | null;
    };
  const events = (runId: string, type: string) =>
    readTrace(testDb.db, runId)
      .filter((e) => e.type === type)
      .map((e) => e.data);
  const agentBookings = () =>
    testDb.db
      .prepare(`SELECT id FROM mock_booking WHERE user_id = ? AND id NOT LIKE 'mb-demo%'`)
      .all(ALICE) as { id: string }[];
  const operation = () =>
    testDb.db.prepare(`SELECT * FROM operation WHERE conversation_id = ?`).get(conversationId) as Record<
      string,
      unknown
    >;
  return { testDb, say, force, approveWith, run, events, agentBookings, operation };
};

describe("caps (NFR-1)", () => {
  it("an unusable read is read again; a model that never gives one stops at 6 model calls with cap_model_calls", async () => {
    const t = setup();
    t.force("model_read", ...Array<string>(10).fill("unusable"));
    const reply = await t.say(REQUEST);
    expect(t.run(reply.runId)).toMatchObject({ outcome: "cap_model_calls", model_calls: 6 });
    expect(reply.message.text).toMatch(/6 model calls/);
    expect(t.events(reply.runId, "limit_hit")).toEqual([
      expect.objectContaining({ cap: "cap_model_calls", modelCalls: 6 }),
    ]);
    t.testDb.close();
  });

  it("one unusable read followed by a usable one just costs one more model call", async () => {
    const t = setup();
    t.force("model_read", "unusable");
    const reply = await t.say(REQUEST);
    expect(t.run(reply.runId)).toMatchObject({ outcome: "completed", model_calls: 3 });
    expect(reply.message.parts.some((p) => p.type === "option_blocks")).toBe(true);
    t.testDb.close();
  });

  it("a slow model is stopped at the deadline, not when it finally answers (R8)", async () => {
    const slow: AgentModel = {
      read: (job) => new Promise((resolve) => setTimeout(() => resolve(scriptedModel.read(job)), 400)),
      write: (job) => scriptedModel.write(job),
    };
    const t = setup({ model: slow, caps: { modelCalls: 6, toolCalls: 10, elapsedMs: 50 } });
    const started = performance.now();
    const reply = await t.say(REQUEST);
    expect(performance.now() - started).toBeLessThan(300);
    expect(t.run(reply.runId)).toMatchObject({ outcome: "cap_time" });
    expect(reply.message.text).toMatch(/60 seconds|time limit/i);
    t.testDb.close();
  });

  it("a booking that needs an 11th tool call stops with cap_tool_calls, leaves the operation in flight, and the next message resolves it", async () => {
    const t = setup();
    // key 1: timeout, status, hold_expired, re-hold · key 2: the same · key 3: timeout, status → the 11th call is refused
    const reply = await t.approveWith("timeout", "hold_expired", "timeout", "hold_expired", "timeout");
    expect(t.run(reply.runId)).toMatchObject({ outcome: "cap_tool_calls", tool_calls: 10 });
    expect(reply.message.text).toMatch(/10 provider calls/);
    expect(reply.message.text).toMatch(/booking check didn't finish/i);
    expect(t.operation()).toMatchObject({ status: "in_flight" });
    expect(t.agentBookings()).toHaveLength(0);

    t.force("book", "ok");
    await t.say("hello");
    expect(t.operation()).toMatchObject({ status: "succeeded" });
    expect(t.agentBookings()).toHaveLength(1);
    t.testDb.close();
  });

  it("simulated pauses count toward the time cap: long timeouts stop the run with cap_time mid-check", async () => {
    const t = setup({ settings: { timeoutPauseMs: 25_000 } });
    const reply = await t.approveWith("timeout", "timeout", "timeout");
    expect(t.run(reply.runId)).toMatchObject({ outcome: "cap_time" });
    expect(reply.message.text).toMatch(/booking check didn't finish/i);
    expect(t.operation()).toMatchObject({ status: "in_flight" });
    t.testDb.close();
  });

  it("the longest normal path (timeout → status → re-hold → book) fits inside the caps (V-5)", async () => {
    const t = setup();
    const reply = await t.approveWith("timeout", "hold_expired", "ok");
    const r = t.run(reply.runId);
    expect(r.outcome).toBe("completed");
    expect(r.tool_calls).toBeLessThanOrEqual(10);
    expect(r.model_calls).toBeLessThanOrEqual(6);
    expect(reply.message.text).toMatch(/^Booked:/);
    t.testDb.close();
  });
});

describe("truthful endings (MH-5, R5)", () => {
  it("3 timeouts with nothing booked end as retries_exhausted, worded from the checked status", async () => {
    const t = setup();
    const reply = await t.approveWith("timeout", "timeout", "timeout");
    expect(t.run(reply.runId)).toMatchObject({ outcome: "retries_exhausted" });
    expect(reply.message.text).toMatch(/nothing was booked/i);
    expect(reply.message.text).toMatch(/not_found/);
    t.testDb.close();
  });

  it("an unforeseen error with no provider record → unknown_error, 'Nothing was booked', details only in the trace", async () => {
    const t = setup();
    const reply = await t.approveWith("throw_before_commit");
    expect(t.run(reply.runId)).toMatchObject({ outcome: "unknown_error" });
    expect(reply.message.text).toMatch(/nothing was booked/i);
    expect(reply.message.text).not.toMatch(/Error|at |stack/);
    expect(t.events(reply.runId, "error")).toEqual([
      expect.objectContaining({
        code: "unknown_error",
        internalDetails: expect.stringContaining("unexpected provider failure"),
      }),
    ]);
    expect(t.agentBookings()).toHaveLength(0);
    t.testDb.close();
  });

  it("an unforeseen error after the provider booked → the booking is reported, not hidden", async () => {
    const t = setup();
    const reply = await t.approveWith("throw_after_commit");
    expect(t.run(reply.runId)).toMatchObject({ outcome: "unknown_error" });
    expect(reply.message.text).toMatch(/your booking went through/i);
    expect(reply.message.text).toContain(t.agentBookings()[0]!.id);
    expect(t.operation()).toMatchObject({ status: "succeeded" });
    t.testDb.close();
  });

  it("an unforeseen error and an unreadable status → 'couldn't confirm — don't book again yet', operation left for recovery", async () => {
    const t = setup();
    t.force("get_booking_status", "throw");
    const reply = await t.approveWith("throw_after_commit");
    expect(t.run(reply.runId)).toMatchObject({ outcome: "unknown_error" });
    expect(reply.message.text).toMatch(/couldn't confirm whether it went through/i);
    expect(reply.message.text).toMatch(/don't book again yet/i);
    expect(t.operation()).toMatchObject({ status: "in_flight" });
    t.testDb.close();
  });

  it("every run in these endings is finished: an outcome, an end time and a non-empty reply (I-5)", async () => {
    const t = setup();
    const reply = await t.approveWith("timeout", "timeout", "timeout");
    expect(t.run(reply.runId).ended_at).not.toBeNull();
    expect(reply.message.text.trim()).not.toBe("");
    t.testDb.close();
  });
});
