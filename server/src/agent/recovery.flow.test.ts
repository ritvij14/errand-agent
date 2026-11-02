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

// Restart recovery (MH-3, NFR-5, § 2.5.6, § 2.5.2 rule 5). A "restart" is a fresh
// service on the same database: nothing held in memory survives.

const ALICE = "u-demo-alice";
const REQUEST = "plumber in HSR Layout this week, mornings only, under ₹1,500";

const setup = () => {
  const testDb = createTestDb();
  const clock = createClock({ now: new Date("2026-11-02T03:45:00Z") });
  seedDemoUsers(testDb.db, clock.now().getTime());
  seedMockWorld(testDb.db, { seed: "errand-agent-v1", clock });
  const queue: { tool: string; outcome: string }[] = [];
  const forced: ForcedQueue = {
    take: (tool) => {
      const i = queue.findIndex((q) => q.tool === tool);
      return i === -1 ? undefined : { outcome: queue.splice(i, 1)[0]!.outcome };
    },
  };
  const start = () =>
    createConversationService({ db: testDb.db, clock, model: scriptedModel, mock: { forced } });
  const service = start();
  const conversationId = service.createConversation(ALICE).id;
  const say = async (svc: ReturnType<typeof start>, text: string) => {
    const result = await svc.sendMessage(ALICE, conversationId, text, randomUUID());
    if (!result.ok) throw new Error(result.code);
    return result.reply;
  };
  /** pick the first slot, then approve while the server "crashes" mid-book */
  const crashWhileBooking = async (crash: "server_crash_before_commit" | "server_crash_after_commit") => {
    const blocks = (await say(service, REQUEST)).message.parts.find((p) => p.type === "option_blocks")!
      .blocks as OptionBlock[];
    const card = (await say(service, blocks[0]!.slots[0]!.pickText)).message.parts.find(
      (p) => p.type === "approval_card",
    ) as {
      approvalId: string;
    };
    queue.push({ tool: "book", outcome: crash });
    await expect(service.decideApproval(ALICE, card.approvalId, "approve")).rejects.toThrow(
      /simulated server crash/,
    );
    return card.approvalId;
  };
  const agentBookings = () =>
    testDb.db
      .prepare(`SELECT * FROM mock_booking WHERE user_id = ? AND id NOT LIKE 'mb-demo%'`)
      .all(ALICE) as { id: string }[];
  const operation = () =>
    testDb.db.prepare(`SELECT * FROM operation WHERE conversation_id = ?`).get(conversationId) as Record<
      string,
      unknown
    >;
  const agentMessages = (svc: ReturnType<typeof start>) =>
    (
      (
        svc.readConversation(ALICE, conversationId) as {
          messages: {
            role: string;
            text: string;
            run_id: string;
            parts: { type: string; approvalId?: string }[];
          }[];
        }
      ).messages ?? []
    ).filter((m) => m.role === "agent");
  const recoveryRuns = () =>
    testDb.db
      .prepare(`SELECT * FROM run WHERE conversation_id = ? AND trigger = 'recovery'`)
      .all(conversationId) as { id: string; outcome: string }[];
  return {
    testDb,
    clock,
    queue,
    start,
    service,
    conversationId,
    say,
    crashWhileBooking,
    agentBookings,
    operation,
    agentMessages,
    recoveryRuns,
  };
};

describe("restart recovery (§ 2.5.6)", () => {
  it("a crash after the provider committed but before the operation was saved recovers to exactly one booking (R7)", async () => {
    const t = setup();
    await t.crashWhileBooking("server_crash_after_commit");
    expect(t.operation()).toMatchObject({ status: "in_flight" });
    expect(t.agentBookings()).toHaveLength(1);

    const restarted = t.start();
    await restarted.recoverInFlight();

    expect(t.agentBookings()).toHaveLength(1);
    expect(t.operation()).toMatchObject({ status: "succeeded" });
    const last = t.agentMessages(restarted).at(-1)!;
    expect(last.text).toMatch(/^Your booking went through/);
    expect(last.text).toContain(t.agentBookings()[0]!.id);
    t.testDb.close();
  });

  it("startup recovery is its own run with its own trace, and checks the status before anything else", async () => {
    const t = setup();
    await t.crashWhileBooking("server_crash_after_commit");
    const restarted = t.start();
    await restarted.recoverInFlight();
    const [run] = t.recoveryRuns();
    expect(run).toMatchObject({ outcome: "completed" });
    const tools = readTrace(t.testDb.db, run!.id)
      .filter((e) => e.type === "tool_call")
      .map((e) => (e.data as { tool: string }).tool);
    expect(tools).toEqual(["get_booking_status"]);
    t.testDb.close();
  });

  it("not_found and the hold still valid → resumed with the same key → one booking", async () => {
    const t = setup();
    await t.crashWhileBooking("server_crash_before_commit");
    const key = t.operation().idempotency_key;
    expect(t.agentBookings()).toHaveLength(0);

    t.queue.push({ tool: "book", outcome: "ok" });
    const restarted = t.start();
    await restarted.recoverInFlight();

    expect(t.agentBookings()).toHaveLength(1);
    expect(t.operation()).toMatchObject({ status: "succeeded", idempotency_key: key });
    expect(t.agentMessages(restarted).at(-1)!.text).toMatch(/^Booked:/);
    t.testDb.close();
  });

  it("not_found and the hold expired → nothing booked, and the user is asked to approve again on a new card", async () => {
    const t = setup();
    const oldApproval = await t.crashWhileBooking("server_crash_before_commit");
    t.clock.advanceMs(11 * 60 * 1000); // past the 10-minute hold

    const restarted = t.start();
    await restarted.recoverInFlight();

    expect(t.agentBookings()).toHaveLength(0);
    expect(t.operation()).toMatchObject({ status: "failed" });
    const last = t.agentMessages(restarted).at(-1)!;
    expect(last.text).toMatch(/nothing was booked/i);
    const card = last.parts.find((p) => p.type === "approval_card");
    expect(card?.approvalId).toBeDefined();
    expect(card!.approvalId).not.toBe(oldApproval);
    t.testDb.close();
  });

  it("without a startup check, the next message's run finishes the booking first, then answers (§ 2.5.2 rule 5)", async () => {
    const t = setup();
    await t.crashWhileBooking("server_crash_after_commit");
    const restarted = t.start();
    await t.say(restarted, "hello");
    expect(t.operation()).toMatchObject({ status: "succeeded" });
    const texts = t.agentMessages(restarted).map((m) => m.text);
    expect(texts.some((m) => /^Your booking went through/.test(m))).toBe(true);
    expect(t.agentBookings()).toHaveLength(1);
    t.testDb.close();
  });

  it("with nothing in flight, startup recovery starts no run", async () => {
    const t = setup();
    await t.start().recoverInFlight();
    expect(t.recoveryRuns()).toHaveLength(0);
    t.testDb.close();
  });
});
