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

// choosing → holding → awaiting_approval (FR-9, FR-10, § 2.5.5, V-2), driven through
// the conversation service. Fixed now: Mon 2026-11-02 09:15 IST.

const ALICE = "u-demo-alice";
const REQUEST = "plumber in HSR Layout this week, mornings only, under ₹1,500";

const setup = (forcedHold?: string) => {
  const testDb = createTestDb();
  const clock = createClock({ now: new Date("2026-11-02T03:45:00Z") });
  seedDemoUsers(testDb.db, clock.now().getTime());
  seedMockWorld(testDb.db, { seed: "errand-agent-v1", clock });
  let pending = forcedHold;
  const forced: ForcedQueue = {
    take: (tool) =>
      tool === "hold_slot" && pending ? ((pending = undefined), { outcome: forcedHold! }) : undefined,
  };
  const service = createConversationService({ db: testDb.db, clock, model: scriptedModel, mock: { forced } });
  const conversationId = service.createConversation(ALICE).id;
  const say = async (text: string) => {
    const result = await service.sendMessage(ALICE, conversationId, text, randomUUID());
    if (!result.ok) throw new Error(`send failed: ${result.code}`);
    return result.reply;
  };
  const workflow = () =>
    testDb.db
      .prepare(`SELECT phase, candidates FROM workflow WHERE conversation_id = ?`)
      .get(conversationId) as {
      phase: string;
      candidates: string;
    };
  const approvals = () =>
    testDb.db.prepare(`SELECT * FROM approval WHERE conversation_id = ?`).all(conversationId) as Record<
      string,
      unknown
    >[];
  return { testDb, say, workflow, approvals };
};

type Reply = Awaited<ReturnType<ReturnType<typeof setup>["say"]>>;
const part = (reply: Reply, type: string) => reply.message.parts.find((p) => p.type === type);
const blocksOf = (reply: Reply) => part(reply, "option_blocks")?.blocks as OptionBlock[];

describe("pick → hold → approval card", () => {
  it("tapping a slot (its pickText) holds it and shows a card drawn from a pending approval record", async () => {
    const { testDb, say, workflow, approvals } = setup();
    const block = blocksOf(await say(REQUEST))[0]!;
    const reply = await say(block.slots[0]!.pickText);

    expect(workflow().phase).toBe("awaiting_approval");
    const [record] = approvals();
    expect(record).toMatchObject({
      status: "pending",
      action: "book",
      provider_id: block.provider.id,
      slot: block.slots[0]!.start,
    });
    const card = part(reply, "approval_card");
    expect(card).toEqual({
      type: "approval_card",
      approvalId: record!.id,
      action: "book",
      provider: { id: block.provider.id, name: block.provider.name },
      slot: record!.slot,
      slotLabel: block.slots[0]!.label,
      price: record!.price,
      status: "pending",
    });
    const tools = readTrace(testDb.db, reply.runId)
      .filter((e) => e.type === "tool_call")
      .map((e) => (e.data as { tool: string }).tool);
    expect(tools).toEqual(["hold_slot"]);
    testDb.close();
  });

  it("the card shows the hold's quoted price when it differs from the search price (V-2)", async () => {
    const { testDb, say, approvals } = setup("price_changed");
    const block = blocksOf(await say(REQUEST))[0]!;
    const reply = await say(block.slots[0]!.pickText);
    const card = part(reply, "approval_card") as { price: number };
    const hold = testDb.db.prepare(`SELECT quoted_price FROM mock_hold`).get() as { quoted_price: number };
    expect(card.price).toBe(hold.quoted_price);
    expect(card.price).not.toBe(block.provider.price);
    expect(approvals()[0]!.price).toBe(hold.quoted_price);
    expect(reply.message.text).toContain(`₹${block.provider.price.toLocaleString("en-IN")}`); // says it changed
    testDb.close();
  });

  it("a slot that can't be held goes back to choosing without that slot, and no approval is created", async () => {
    const { testDb, say, workflow, approvals } = setup("slot_unavailable");
    const block = blocksOf(await say(REQUEST))[0]!;
    const taken = block.slots[0]!.start;
    const reply = await say(block.slots[0]!.pickText);
    expect(workflow().phase).toBe("choosing");
    expect(approvals()).toHaveLength(0);
    const remaining = blocksOf(reply).flatMap((b) => b.slots.map((s) => s.start));
    expect(remaining).not.toContain(taken);
    expect(reply.message.text).toMatch(/taken|no longer/i);
    testDb.close();
  });

  it("an unclear pick asks which slot and holds nothing", async () => {
    const { testDb, say, workflow } = setup();
    await say(REQUEST);
    const reply = await say("the second one");
    expect(reply.message.text).toMatch(/which/i);
    expect(workflow().phase).toBe("choosing");
    expect(testDb.db.prepare(`SELECT COUNT(*) AS c FROM mock_hold`).get()).toEqual({ c: 0 });
    testDb.close();
  });

  it("'the second one' with no options shown → NOTHING_TO_PICK", async () => {
    const { testDb, say } = setup();
    const reply = await say("the second one");
    expect(reply.message.text).toMatch(/no list of options/i);
    expect(reply.message.parts).toEqual([]);
    testDb.close();
  });
});
