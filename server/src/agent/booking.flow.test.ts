import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createClock } from "../shared/clock.js";
import { createTestDb } from "../shared/test-db.js";
import { seedDemoUsers } from "../auth/index.js";
import { seedMockWorld, type ForcedQueue } from "../tools/index.js";
import { createConversationService } from "../conversations/index.js";
import { readTrace } from "../tracing/index.js";
import { scriptedModel } from "./index.js";
import type { OptionBlock } from "./options.js";

// approve → executing → verifying → done (MH-3, FR-11, § 2.5.6). The reply says
// "Booked" only after get_booking_status said booked. Fixed now: Mon 09:15 IST.

const ALICE = "u-demo-alice";
const REQUEST = "plumber in HSR Layout this week, mornings only, under ₹1,500";

const setup = (...bookOutcomes: string[]) => {
  const testDb = createTestDb();
  const clock = createClock({ now: new Date("2026-11-02T03:45:00Z") });
  seedDemoUsers(testDb.db, clock.now().getTime());
  seedMockWorld(testDb.db, { seed: "errand-agent-v1", clock });
  // forced outcomes are consumed in order, per tool (NFR-4); `force` queues more later
  const queue: { tool: string; outcome: string }[] = bookOutcomes.map((outcome) => ({
    tool: "book",
    outcome,
  }));
  const force = (tool: string, outcome: string) => queue.push({ tool, outcome });
  const forced: ForcedQueue = {
    take: (tool) => {
      const i = queue.findIndex((q) => q.tool === tool);
      return i === -1 ? undefined : { outcome: queue.splice(i, 1)[0]!.outcome };
    },
  };
  const service = createConversationService({ db: testDb.db, clock, model: scriptedModel, mock: { forced } });
  const conversationId = service.createConversation(ALICE).id;
  const say = async (text: string) => {
    const result = await service.sendMessage(ALICE, conversationId, text, randomUUID());
    if (!result.ok) throw new Error(result.code);
    return result.reply;
  };
  const approveFirstOption = async (beforeApprove?: () => void) => {
    const blocks = (await say(REQUEST)).message.parts.find((p) => p.type === "option_blocks")!
      .blocks as OptionBlock[];
    const card = (await say(blocks[0]!.slots[0]!.pickText)).message.parts.find(
      (p) => p.type === "approval_card",
    ) as { approvalId: string; price: number };
    beforeApprove?.();
    const result = await service.decideApproval(ALICE, card.approvalId, "approve");
    if (!result.ok) throw new Error(result.code);
    return { reply: result.reply, approvalId: card.approvalId, block: blocks[0]!, cardPrice: card.price };
  };
  const agentBookings = () =>
    testDb.db
      .prepare(`SELECT * FROM mock_booking WHERE user_id = ? AND id NOT LIKE 'mb-demo%'`)
      .all(ALICE) as { id: string; provider_id: string; slot: string; price: number }[];
  const operation = () =>
    testDb.db.prepare(`SELECT * FROM operation WHERE conversation_id = ?`).get(conversationId) as Record<
      string,
      unknown
    >;
  const phase = () =>
    (
      testDb.db.prepare(`SELECT phase FROM workflow WHERE conversation_id = ?`).get(conversationId) as {
        phase: string;
      }
    ).phase;
  const approval = (id: string) =>
    testDb.db.prepare(`SELECT * FROM approval WHERE id = ?`).get(id) as Record<string, unknown>;
  const bookCalls = (runId: string) =>
    readTrace(testDb.db, runId)
      .filter((e) => e.type === "tool_call")
      .map((e) => e.data as { tool: string; args: { idempotencyKey?: string }; errorCode: string | null });
  return {
    testDb,
    clock,
    service,
    conversationId,
    say,
    force,
    approveFirstOption,
    agentBookings,
    operation,
    phase,
    approval,
    bookCalls,
  };
};

const part = (reply: { message: { parts: Record<string, unknown>[] } }, type: string) =>
  reply.message.parts.find((p) => p.type === type);

describe("failure paths (§ 2.5.6 decision table, NFR-2, NFR-3, V-4)", () => {
  it("timeout, nothing booked → not_found → waits 0.5 s on the clock → retries with the SAME key → one booking", async () => {
    const t = setup("timeout", "ok");
    const before = t.clock.now().getTime();
    const { reply } = await t.approveFirstOption();
    expect(t.agentBookings()).toHaveLength(1);
    expect(t.operation()).toMatchObject({ status: "succeeded", attempts: 2, hold_seq: 1 });
    const books = t.bookCalls(reply.runId).filter((c) => c.tool === "book");
    expect(books.map((c) => c.args.idempotencyKey)).toEqual([
      t.operation().idempotency_key,
      t.operation().idempotency_key,
    ]);
    expect(t.clock.now().getTime() - before).toBeGreaterThanOrEqual(10_000 + 500); // the provider's pause + the first wait
    expect(reply.message.text).toMatch(/^Booked:/);
    t.testDb.close();
  });

  it("3 attempts all timing out with nothing booked → a final status check → a truthful 'nothing was booked'", async () => {
    const t = setup("timeout", "timeout", "timeout");
    const { reply } = await t.approveFirstOption();
    expect(t.agentBookings()).toHaveLength(0);
    expect(t.operation()).toMatchObject({ status: "failed", attempts: 3 });
    expect(t.bookCalls(reply.runId).filter((c) => c.tool === "book")).toHaveLength(3);
    expect(reply.message.text).not.toMatch(/^Booked/);
    expect(reply.message.text).toMatch(/nothing was booked/i);
    t.testDb.close();
  });

  it("slot_taken → operation failed, approval stays used, back to the options without that slot (NFR-3)", async () => {
    const t = setup("slot_taken");
    const { reply, approvalId, block } = await t.approveFirstOption();
    expect(t.agentBookings()).toHaveLength(0);
    expect(t.operation()).toMatchObject({ status: "failed" });
    expect(t.approval(approvalId)).toMatchObject({ status: "used" });
    expect(t.phase()).toBe("choosing");
    const remaining = (part(reply, "option_blocks")!.blocks as OptionBlock[]).flatMap((b) =>
      b.slots.map((s) => s.start),
    );
    expect(remaining).not.toContain(block.slots[0]!.start);
    expect(reply.message.text).toMatch(/taken/i);
    t.testDb.close();
  });

  it("hold_expired, re-hold at the same price → key ':2' and booked without asking again (V-4)", async () => {
    const t = setup("hold_expired", "ok");
    const { reply, approvalId } = await t.approveFirstOption();
    expect(t.agentBookings()).toHaveLength(1);
    const op = t.operation();
    expect(op).toMatchObject({ status: "succeeded", hold_seq: 2, idempotency_key: `${String(op.id)}:2` });
    expect(t.approval(approvalId)).toMatchObject({ status: "used" });
    expect(t.bookCalls(reply.runId).map((c) => c.tool)).toEqual([
      "book",
      "hold_slot",
      "book",
      "get_booking_status",
    ]);
    expect(reply.message.text).toMatch(/^Booked:/);
    t.testDb.close();
  });

  it("hold_expired, re-hold at a new price → approval voided (price_changed), a new card at the new price, nothing booked", async () => {
    const t = setup("hold_expired");
    const { reply, approvalId, cardPrice } = await t.approveFirstOption(() =>
      t.force("hold_slot", "price_changed"),
    );
    expect(t.agentBookings()).toHaveLength(0);
    expect(t.approval(approvalId)).toMatchObject({ status: "voided", void_reason: "price_changed" });
    const card = part(reply, "approval_card") as { approvalId: string; price: number };
    expect(card.price).not.toBe(cardPrice);
    expect(t.approval(card.approvalId)).toMatchObject({ status: "pending", price: card.price });
    expect(t.phase()).toBe("awaiting_approval");
    t.testDb.close();
  });

  it("hold_expired, re-hold finds the slot gone → approval voided (slot_changed), back to the options, nothing booked", async () => {
    const t = setup("hold_expired");
    const { reply, approvalId } = await t.approveFirstOption(() => t.force("hold_slot", "slot_unavailable"));
    expect(t.agentBookings()).toHaveLength(0);
    expect(t.approval(approvalId)).toMatchObject({ status: "voided", void_reason: "slot_changed" });
    expect(t.operation()).toMatchObject({ status: "failed" });
    expect(t.phase()).toBe("choosing");
    expect(part(reply, "option_blocks")).toBeDefined();
    t.testDb.close();
  });
});

describe("execute and verify a booking", () => {
  it("approving books exactly once, confirms it with get_booking_status, then reports it", async () => {
    const t = setup("ok");
    const { reply, approvalId, block } = await t.approveFirstOption();
    const bookings = t.agentBookings();
    expect(bookings).toHaveLength(1);
    expect(bookings[0]).toMatchObject({ provider_id: block.provider.id, slot: block.slots[0]!.start });
    expect(t.operation()).toMatchObject({ status: "succeeded", approval_id: approvalId, attempts: 1 });
    expect(JSON.parse(t.operation().result as string)).toMatchObject({ bookingId: bookings[0]!.id });
    expect(t.phase()).toBe("done");
    expect(reply.message.text).toMatch(/^Booked:/);
    expect(reply.message.text).toContain(bookings[0]!.id);
    const tools = readTrace(t.testDb.db, reply.runId)
      .filter((e) => e.type === "tool_call")
      .map((e) => (e.data as { tool: string }).tool);
    expect(tools).toEqual(["book", "get_booking_status"]); // verified before the reply
    t.testDb.close();
  });

  it("a timeout that did book is still verified and reported as booked (timeout after success)", async () => {
    const t = setup("timeout_booked");
    const { reply } = await t.approveFirstOption();
    expect(t.agentBookings()).toHaveLength(1);
    expect(t.operation()).toMatchObject({ status: "succeeded" });
    expect(reply.message.text).toMatch(/^Booked:/);
    t.testDb.close();
  });

  it("the trace records real latency for every model and tool call, never the simulated 10 s pause (MH-7)", async () => {
    const t = setup("timeout_booked");
    const { reply } = await t.approveFirstOption();
    const events = readTrace(t.testDb.db, reply.runId);
    const timed = events.filter(
      (e) => e.type === "tool_call" || e.type === "model_call" || e.type === "run_ended",
    );
    expect(timed.map((e) => e.type)).toEqual(["tool_call", "tool_call", "model_call", "run_ended"]); // a button approval has no read
    for (const e of timed) {
      expect(e.durationMs).toBeTypeOf("number");
      expect(e.durationMs!).toBeGreaterThanOrEqual(0);
      expect(e.durationMs!).toBeLessThan(5_000); // real time, while clock_at jumped 10 s
    }
    // the run's time as the caps count it (simulated pauses included) stays visible
    expect((events.at(-1)!.data as { countedMs: number }).countedMs).toBeGreaterThanOrEqual(10_000);
    t.testDb.close();
  });
});

describe("repeated yes and overlapping messages (MH-3, § 2.5.6, § 2.3)", () => {
  const toolCalls = (t: ReturnType<typeof setup>, runId: string) => t.bookCalls(runId).map((c) => c.tool);

  it("typed yes, yes again, then the Approve button → one book call; the repeats report the booking id and call no tool", async () => {
    const t = setup("ok");
    const { reply, approvalId } = await t.approveFirstOption();
    expect(reply.message.text).toMatch(/^Booked:/);
    const bookingId = t.agentBookings()[0]!.id;

    const again = await t.say("yes");
    expect(again.message.text).toContain(bookingId);
    expect(again.message.text).toMatch(/already booked/i);
    expect(toolCalls(t, again.runId)).toEqual([]);

    const clicked = await t.service.decideApproval(ALICE, approvalId, "approve");
    if (!clicked.ok) throw new Error(clicked.code);
    expect(clicked.reply.message.text).toMatch(/already booked/i);
    expect(clicked.reply.message.text).toContain(bookingId);
    expect(toolCalls(t, clicked.reply.runId)).toEqual([]);

    expect(t.agentBookings()).toHaveLength(1);
    expect(t.testDb.db.prepare(`SELECT COUNT(*) n FROM operation`).get()).toEqual({ n: 1 });
    t.testDb.close();
  });

  it("a click on an approval whose booking failed says nothing was booked, and calls no tool", async () => {
    const t = setup("slot_taken");
    const { approvalId } = await t.approveFirstOption();
    const clicked = await t.service.decideApproval(ALICE, approvalId, "approve");
    if (!clicked.ok) throw new Error(clicked.code);
    expect(clicked.reply.message.text).toMatch(/nothing was booked/i);
    expect(clicked.reply.message.text).not.toMatch(/^Booked/);
    expect(toolCalls(t, clicked.reply.runId)).toEqual([]);
    t.testDb.close();
  });

  it("a yes sent while the approve run is still going is refused with CONVERSATION_BUSY, not queued — one booking", async () => {
    const t = setup("ok");
    const blocks = (await t.say(REQUEST)).message.parts.find((p) => p.type === "option_blocks")!
      .blocks as OptionBlock[];
    const card = (await t.say(blocks[0]!.slots[0]!.pickText)).message.parts.find(
      (p) => p.type === "approval_card",
    ) as { approvalId: string };
    const runsBefore = (t.testDb.db.prepare(`SELECT COUNT(*) n FROM run`).get() as { n: number }).n;

    const [clicked, typed] = await Promise.all([
      t.service.decideApproval(ALICE, card.approvalId, "approve"),
      t.service.sendMessage(ALICE, t.conversationId, "yes", randomUUID()),
    ]);
    expect(clicked.ok && clicked.reply.message.text).toMatch(/^Booked:/);
    expect(typed).toMatchObject({ ok: false, code: "CONVERSATION_BUSY" });
    expect((t.testDb.db.prepare(`SELECT COUNT(*) n FROM run`).get() as { n: number }).n).toBe(runsBefore + 1); // refused, not queued
    expect(t.agentBookings()).toHaveLength(1);
    t.testDb.close();
  });
});
