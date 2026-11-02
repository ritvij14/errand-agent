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

const setup = (bookOutcome: string) => {
  const testDb = createTestDb();
  const clock = createClock({ now: new Date("2026-11-02T03:45:00Z") });
  seedDemoUsers(testDb.db, clock.now().getTime());
  seedMockWorld(testDb.db, { seed: "errand-agent-v1", clock });
  const forced: ForcedQueue = { take: (tool) => (tool === "book" ? { outcome: bookOutcome } : undefined) };
  const service = createConversationService({ db: testDb.db, clock, model: scriptedModel, mock: { forced } });
  const conversationId = service.createConversation(ALICE).id;
  const say = async (text: string) => {
    const result = await service.sendMessage(ALICE, conversationId, text, randomUUID());
    if (!result.ok) throw new Error(result.code);
    return result.reply;
  };
  const approveFirstOption = async () => {
    const blocks = (await say(REQUEST)).message.parts.find((p) => p.type === "option_blocks")!
      .blocks as OptionBlock[];
    const card = (await say(blocks[0]!.slots[0]!.pickText)).message.parts.find(
      (p) => p.type === "approval_card",
    ) as { approvalId: string };
    const result = await service.decideApproval(ALICE, card.approvalId, "approve");
    if (!result.ok) throw new Error(result.code);
    return { reply: result.reply, approvalId: card.approvalId, block: blocks[0]! };
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
  return { testDb, approveFirstOption, agentBookings, operation, phase };
};

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

  it("when the checked status is not booked, the reply never says booked", async () => {
    const t = setup("timeout");
    const { reply } = await t.approveFirstOption();
    expect(t.agentBookings()).toHaveLength(0);
    expect(t.operation()).toMatchObject({ status: "failed" });
    expect(reply.message.text).not.toMatch(/^Booked/);
    expect(reply.message.text).toMatch(/nothing was booked/i);
    t.testDb.close();
  });
});
