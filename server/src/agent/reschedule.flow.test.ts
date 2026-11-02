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

// Reschedule (FR-3, V-3, V-9, R3): identifying_booking → collecting (new time) →
// choosing (the booked provider's slots only) → awaiting_approval → executing → done.

const ALICE = "u-demo-alice";
const BOOKING = "mb-demo-ac"; // alice's upcoming AC servicing

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
  const service = createConversationService({ db: testDb.db, clock, model: scriptedModel, mock: { forced } });
  const conversationId = service.createConversation(ALICE).id;
  const say = async (text: string) => {
    const result = await service.sendMessage(ALICE, conversationId, text, randomUUID());
    if (!result.ok) throw new Error(result.code);
    return result.reply;
  };
  const click = async (approvalId: string) => {
    const result = await service.decideApproval(ALICE, approvalId, "approve");
    if (!result.ok) throw new Error(result.code);
    return result.reply;
  };
  const booking = () =>
    testDb.db
      .prepare(`SELECT provider_id, slot, price, status FROM mock_booking WHERE id = ?`)
      .get(BOOKING) as {
      provider_id: string;
      slot: string;
      price: number;
      status: string;
    };
  const phase = () =>
    (
      testDb.db.prepare(`SELECT phase FROM workflow WHERE conversation_id = ?`).get(conversationId) as {
        phase: string;
      }
    ).phase;
  const tools = (runId: string) =>
    readTrace(testDb.db, runId)
      .filter((e) => e.type === "tool_call")
      .map((e) => (e.data as { tool: string }).tool);
  const force = (tool: string, outcome: string) => queue.push({ tool, outcome });
  return { testDb, say, click, booking, phase, tools, force };
};

const blocksOf = (reply: { message: { parts: Record<string, unknown>[] } }) =>
  (reply.message.parts.find((p) => p.type === "option_blocks")?.blocks ?? []) as OptionBlock[];
const cardOf = (reply: { message: { parts: Record<string, unknown>[] } }) =>
  reply.message.parts.find((p) => p.type === "approval_card") as
    { approvalId: string; action: string; slot: string; price: number; bookingId: string } | undefined;

describe("reschedule flow (FR-3)", () => {
  it("'move my AC servicing to Saturday' offers only the booked provider's Saturday slots, at the booking's price (V-3)", async () => {
    const t = setup();
    const original = t.booking();
    const reply = await t.say("move my AC servicing to Saturday");
    const blocks = blocksOf(reply);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.provider).toMatchObject({ id: original.provider_id, price: original.price });
    expect(blocks[0]!.slots.length).toBeGreaterThan(0);
    expect(blocks[0]!.slots.every((s) => s.start.startsWith("2026-11-07"))).toBe(true);
    expect(t.tools(reply.runId)).toEqual(["list_bookings", "search_providers"]);
    expect(t.phase()).toBe("choosing");
    t.testDb.close();
  });

  it("without a time it asks for the new time, then offers slots", async () => {
    const t = setup();
    const ask = await t.say("move my AC servicing");
    expect(t.phase()).toBe("collecting");
    expect(ask.message.text).toMatch(/when|what day|time/i);
    const reply = await t.say("Saturday morning");
    expect(blocksOf(reply)[0]?.provider.id).toBe(t.booking().provider_id);
    t.testDb.close();
  });

  it("tapping a slot shows a reschedule card with the new slot and the booking's original price — no hold (V-9)", async () => {
    const t = setup();
    const original = t.booking();
    const slot = blocksOf(await t.say("move my AC servicing to Saturday"))[0]!.slots[0]!;
    const reply = await t.say(slot.pickText);
    expect(cardOf(reply)).toMatchObject({
      action: "reschedule",
      slot: slot.start,
      price: original.price,
      bookingId: BOOKING,
    });
    expect(t.tools(reply.runId)).toEqual([]);
    expect(t.phase()).toBe("awaiting_approval");
    t.testDb.close();
  });

  it("approving re-checks the booking and moves it, price unchanged", async () => {
    const t = setup();
    const original = t.booking();
    const slot = blocksOf(await t.say("move my AC servicing to Saturday"))[0]!.slots[0]!;
    const card = cardOf(await t.say(slot.pickText))!;
    t.force("reschedule", "ok");
    const reply = await t.click(card.approvalId);
    expect(t.tools(reply.runId)).toEqual(["list_bookings", "reschedule"]);
    expect(t.booking()).toMatchObject({ slot: slot.start, price: original.price, status: "booked" });
    expect(reply.message.text).toMatch(/^Moved:/);
    expect(t.phase()).toBe("done");
    t.testDb.close();
  });

  it("slot_conflict → back to the same provider's options without that slot; the booking is unchanged (V-9 eval 12)", async () => {
    const t = setup();
    const original = t.booking();
    const slot = blocksOf(await t.say("move my AC servicing to Saturday"))[0]!.slots[0]!;
    const card = cardOf(await t.say(slot.pickText))!;
    t.force("reschedule", "slot_conflict");
    const reply = await t.click(card.approvalId);
    expect(t.phase()).toBe("choosing");
    const left = blocksOf(reply);
    expect(left.every((b) => b.provider.id === original.provider_id)).toBe(true);
    expect(left.flatMap((b) => b.slots.map((s) => s.start))).not.toContain(slot.start);
    expect(t.booking()).toMatchObject({ slot: original.slot, status: "booked" });
    t.testDb.close();
  });
});
