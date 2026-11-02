import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createClock } from "../shared/clock.js";
import { createTestDb } from "../shared/test-db.js";
import { seedDemoUsers } from "../auth/index.js";
import { seedMockWorld } from "../tools/index.js";
import { createConversationService } from "../conversations/index.js";
import { readTrace } from "../tracing/index.js";
import { scriptedModel } from "./index.js";
import type { OptionBlock } from "./options.js";

// Approval decisions (MH-2, FR-10, § 2.5.5, R2, R9). Fixed now: Mon 2026-11-02 09:15 IST.

const ALICE = "u-demo-alice";
const BOB = "u-demo-bob";
const REQUEST = "plumber in HSR Layout this week, mornings only, under ₹1,500";

type Reply = { runId: string; message: { text: string; parts: Record<string, unknown>[] } };
type Card = { approvalId: string; price: number; slot: string };

const setup = async () => {
  const testDb = createTestDb();
  const clock = createClock({ now: new Date("2026-11-02T03:45:00Z") });
  seedDemoUsers(testDb.db, clock.now().getTime());
  seedMockWorld(testDb.db, { seed: "errand-agent-v1", clock });
  const service = createConversationService({ db: testDb.db, clock, model: scriptedModel });
  const conversationId = service.createConversation(ALICE).id;
  const say = async (text: string, approvalId?: string): Promise<Reply> => {
    const result = await service.sendMessage(ALICE, conversationId, text, randomUUID(), approvalId);
    if (!result.ok) throw new Error(`send failed: ${result.code}`);
    return result.reply;
  };
  const click = async (approvalId: string, decision: string, userId = ALICE) =>
    service.decideApproval(userId, approvalId, decision);
  const approval = (id: string) =>
    testDb.db.prepare(`SELECT * FROM approval WHERE id = ?`).get(id) as Record<string, unknown>;
  const workflow = () =>
    testDb.db
      .prepare(
        `SELECT phase, facts, candidates, selection, hold FROM workflow WHERE conversation_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
      )
      .get(conversationId) as {
      phase: string;
      facts: string;
      candidates: string;
      selection: string | null;
      hold: string | null;
    };
  const part = (reply: Reply, type: string) => reply.message.parts.find((p) => p.type === type);
  const toCard = async (): Promise<Card> => {
    const options = part(await say(REQUEST), "option_blocks")!.blocks as OptionBlock[];
    return part(await say(options[0]!.slots[0]!.pickText), "approval_card") as unknown as Card;
  };
  return { testDb, clock, say, click, approval, workflow, part, toCard };
};

describe("approving", () => {
  it("the Approve button approves the card's record (decided_via button) and records the decision in the trace", async () => {
    const t = await setup();
    const card = await t.toCard();
    const result = await t.click(card.approvalId, "approve");
    if (!result.ok) throw new Error(result.code);
    expect(t.approval(card.approvalId)).toMatchObject({ status: "approved", decided_via: "button" });
    expect(t.workflow().phase).toBe("executing");
    const events = readTrace(t.testDb.db, result.reply.runId);
    expect(events.find((e) => e.type === "approval_event")?.data).toMatchObject({
      event: "approved",
      via: "button",
      approvalId: card.approvalId,
    });
    t.testDb.close();
  });

  it("a typed plain yes carrying the card id approves it (decided_via typed); without an id it answers the waiting card", async () => {
    const t = await setup();
    const card = await t.toCard();
    await t.say("yes", card.approvalId);
    expect(t.approval(card.approvalId)).toMatchObject({ status: "approved", decided_via: "typed" });

    const u = await setup();
    const other = await u.toCard();
    await u.say("go ahead");
    expect(u.approval(other.approvalId)).toMatchObject({ status: "approved", decided_via: "typed" });
    t.testDb.close();
    u.testDb.close();
  });

  it("a second approve of the same card changes nothing and says it is already approved", async () => {
    const t = await setup();
    const card = await t.toCard();
    await t.click(card.approvalId, "approve");
    const again = await t.click(card.approvalId, "approve");
    if (!again.ok) throw new Error(again.code);
    expect(again.reply.message.text).toMatch(/already approved/i);
    expect(t.approval(card.approvalId)).toMatchObject({ status: "approved" });
    t.testDb.close();
  });
});

describe("declining (R9: back by intent)", () => {
  it("Decline goes back to choosing with the same options and every detail kept", async () => {
    const t = await setup();
    const card = await t.toCard();
    const before = t.workflow();
    const result = await t.click(card.approvalId, "decline");
    if (!result.ok) throw new Error(result.code);
    expect(t.approval(card.approvalId)).toMatchObject({ status: "declined", decided_via: "button" });
    const after = t.workflow();
    expect(after.phase).toBe("choosing");
    expect(after.facts).toBe(before.facts);
    expect(after.candidates).toBe(before.candidates);
    expect(after.selection).toBeNull();
    expect(t.part(result.reply, "option_blocks")).toBeDefined();
    t.testDb.close();
  });

  it("a typed 'no' declines the waiting card the same way", async () => {
    const t = await setup();
    const card = await t.toCard();
    await t.say("no");
    expect(t.approval(card.approvalId)).toMatchObject({ status: "declined", decided_via: "typed" });
    expect(t.workflow().phase).toBe("choosing");
    t.testDb.close();
  });
});

describe("voiding and stale cards", () => {
  it("'yes but 11am' is a change, not an approval: the card is voided and the time merges (R9)", async () => {
    const t = await setup();
    const card = await t.toCard();
    await t.say("yes but 11am", card.approvalId);
    expect(t.approval(card.approvalId)).toMatchObject({ status: "voided", void_reason: "user_correction" });
    const facts = JSON.parse(t.workflow().facts) as { time_window: { value: Record<string, unknown> } };
    expect(facts.time_window.value).toMatchObject({
      dateFrom: "2026-11-02",
      dateTo: "2026-11-08",
      earliest: "11:00",
    });
    expect(t.workflow().phase).not.toBe("awaiting_approval");
    t.testDb.close();
  });

  it("a correction while a card waits voids it (user_correction) and searches again", async () => {
    const t = await setup();
    const card = await t.toCard();
    const reply = await t.say("make the budget ₹2,000");
    expect(t.approval(card.approvalId)).toMatchObject({ status: "voided", void_reason: "user_correction" });
    expect(t.workflow().phase).toBe("choosing");
    expect(t.part(reply, "option_blocks")).toBeDefined();
    t.testDb.close();
  });

  it("'never mind' voids the card (user_dropped) and abandons the request", async () => {
    const t = await setup();
    const card = await t.toCard();
    await t.say("never mind");
    expect(t.approval(card.approvalId)).toMatchObject({ status: "voided", void_reason: "user_dropped" });
    expect(t.workflow().phase).toBe("abandoned");
    t.testDb.close();
  });

  it("a yes carrying an old card's id does not approve the new card (R2)", async () => {
    const t = await setup();
    const first = await t.toCard();
    await t.say("make the budget ₹2,000"); // voids the first card
    const options = t.part(await t.say("make the budget ₹1,400"), "option_blocks")!.blocks as OptionBlock[];
    const second = t.part(await t.say(options[0]!.slots[0]!.pickText), "approval_card") as unknown as Card;
    const reply = await t.say("yes", first.approvalId);
    expect(reply.message.text).toMatch(/no longer valid|changed/i);
    expect(t.approval(second.approvalId)).toMatchObject({ status: "pending" });
    expect(t.approval(first.approvalId)).toMatchObject({ status: "voided" });
    t.testDb.close();
  });

  it("a card left waiting over 10 minutes is voided (expired) and approving shows fresh details instead", async () => {
    const t = await setup();
    const card = await t.toCard();
    t.clock.advanceMs(11 * 60 * 1000);
    const result = await t.click(card.approvalId, "approve");
    if (!result.ok) throw new Error(result.code);
    expect(t.approval(card.approvalId)).toMatchObject({ status: "voided", void_reason: "expired" });
    const fresh = t.part(result.reply, "approval_card") as unknown as Card | undefined;
    if (fresh) {
      expect(fresh.approvalId).not.toBe(card.approvalId);
      expect(t.approval(fresh.approvalId)).toMatchObject({ status: "pending" });
    }
    expect(result.reply.message.text).toMatch(/expired|fresh|again/i);
    t.testDb.close();
  });
});

describe("authorization", () => {
  it("another user's approval → NOT_FOUND and nothing changes", async () => {
    const t = await setup();
    const card = await t.toCard();
    const result = await t.click(card.approvalId, "approve", BOB);
    expect(result).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(t.approval(card.approvalId)).toMatchObject({ status: "pending" });
    t.testDb.close();
  });

  it("a decision other than approve / decline → VALIDATION_ERROR", async () => {
    const t = await setup();
    const card = await t.toCard();
    expect(await t.click(card.approvalId, "maybe")).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
    t.testDb.close();
  });
});
