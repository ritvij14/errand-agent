import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createClock } from "../shared/clock.js";
import { createTestDb } from "../shared/test-db.js";
import { seedDemoUsers } from "../auth/index.js";
import { seedMockWorld } from "../tools/index.js";
import { createConversationService } from "../conversations/index.js";
import { readTrace } from "../tracing/index.js";
import { scriptedModel } from "./index.js";

// Cancel (FR-4, V-8, R3, R9): identifying_booking → awaiting_approval → executing → done.
// alice's seeded bookings: mb-demo-ac (AC servicing, upcoming) and mb-demo-electrician (past).

const ALICE = "u-demo-alice";

const setup = () => {
  const testDb = createTestDb();
  const clock = createClock({ now: new Date("2026-11-02T03:45:00Z") });
  seedDemoUsers(testDb.db, clock.now().getTime());
  seedMockWorld(testDb.db, { seed: "errand-agent-v1", clock });
  const service = createConversationService({ db: testDb.db, clock, model: scriptedModel });
  const conversation = () => {
    const id = service.createConversation(ALICE).id;
    const say = async (text: string) => {
      const result = await service.sendMessage(ALICE, id, text, randomUUID());
      if (!result.ok) throw new Error(result.code);
      return result.reply;
    };
    const phase = () =>
      (
        testDb.db
          .prepare(
            `SELECT phase FROM workflow WHERE conversation_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
          )
          .get(id) as { phase: string }
      ).phase;
    return { id, say, phase };
  };
  const click = async (approvalId: string, decision: "approve" | "decline") => {
    const result = await service.decideApproval(ALICE, approvalId, decision);
    if (!result.ok) throw new Error(result.code);
    return result.reply;
  };
  const bookingStatus = (id: string) =>
    (testDb.db.prepare(`SELECT status FROM mock_booking WHERE id = ?`).get(id) as { status: string }).status;
  const toolCalls = (runId: string) =>
    readTrace(testDb.db, runId)
      .filter((e) => e.type === "tool_call")
      .map((e) => e.data as { tool: string; errorCode: string | null; args: { idempotencyKey?: string } });
  const addUpcoming = (id: string, service_: string) =>
    testDb.db
      .prepare(
        `INSERT INTO mock_booking (id, user_id, provider_id, service, area, slot, price, status, cancel_503_served, created_at, updated_at)
         VALUES (?, ?, (SELECT id FROM mock_provider WHERE service = ? LIMIT 1), ?, 'indiranagar', '2026-11-09T09:00:00+05:30', 700, 'booked', 0, 0, 0)`,
      )
      .run(id, ALICE, service_, service_);
  return { testDb, conversation, click, bookingStatus, toolCalls, addUpcoming };
};

type Card = {
  approvalId: string;
  action: string;
  bookingId: string;
  provider: { name: string };
  slot: string;
  price: number;
};
const cardOf = (reply: { message: { parts: Record<string, unknown>[] } }) =>
  reply.message.parts.find((p) => p.type === "approval_card") as Card | undefined;

describe("cancel flow (FR-4)", () => {
  it("'cancel my AC servicing' finds the booking and shows a cancel card with its provider, slot and price — nothing cancelled yet", async () => {
    const t = setup();
    const c = t.conversation();
    const reply = await c.say("cancel my AC servicing");
    const booking = t.testDb.db
      .prepare(`SELECT provider_id, slot, price FROM mock_booking WHERE id = 'mb-demo-ac'`)
      .get() as Record<string, unknown>;
    expect(cardOf(reply)).toMatchObject({
      action: "cancel",
      bookingId: "mb-demo-ac",
      slot: booking.slot,
      price: booking.price,
    });
    expect(c.phase()).toBe("awaiting_approval");
    expect(t.toolCalls(reply.runId).map((x) => x.tool)).toEqual(["list_bookings"]);
    expect(t.bookingStatus("mb-demo-ac")).toBe("booked");
    t.testDb.close();
  });

  it("approving re-checks the booking, survives the first-call 503 with the same key, and cancels it once (V-8)", async () => {
    const t = setup();
    const c = t.conversation();
    const card = cardOf(await c.say("cancel my AC servicing"))!;
    const reply = await t.click(card.approvalId, "approve");
    const calls = t.toolCalls(reply.runId);
    expect(calls.map((x) => `${x.tool}:${x.errorCode ?? "ok"}`)).toEqual([
      "list_bookings:ok",
      "cancel:glitch",
      "cancel:ok",
    ]);
    const keys = calls.filter((x) => x.tool === "cancel").map((x) => x.args.idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(t.bookingStatus("mb-demo-ac")).toBe("cancelled");
    expect(reply.message.text).toMatch(/^Cancelled:/);
    expect(c.phase()).toBe("done");
    t.testDb.close();
  });

  it("'cancel my booking' with two upcoming bookings asks which one (BOOKING_AMBIGUOUS), then the answer picks it", async () => {
    const t = setup();
    t.addUpcoming("b-carpentry", "carpentry");
    const c = t.conversation();
    const ask = await c.say("cancel my booking");
    expect(c.phase()).toBe("identifying_booking");
    expect(ask.message.text).toMatch(/which/i);
    expect(cardOf(ask)).toBeUndefined();
    const reply = await c.say("the carpentry one");
    expect(cardOf(reply)).toMatchObject({ action: "cancel", bookingId: "b-carpentry" });
    t.testDb.close();
  });

  it("nothing matching → BOOKING_NOT_FOUND: stays identifying and says what it has", async () => {
    const t = setup();
    const c = t.conversation();
    const reply = await c.say("cancel my plumber booking");
    expect(c.phase()).toBe("identifying_booking");
    expect(reply.message.text).toMatch(/can't find/i);
    expect(cardOf(reply)).toBeUndefined();
    t.testDb.close();
  });

  it("a past booking can't be cancelled: only upcoming ones are offered", async () => {
    const t = setup();
    const c = t.conversation();
    const reply = await c.say("cancel my electrician booking");
    expect(cardOf(reply)).toBeUndefined();
    expect(reply.message.text).toMatch(/can't find/i);
    t.testDb.close();
  });

  it("decline ends the cancel: no cancel call, the booking stays (R9)", async () => {
    const t = setup();
    const c = t.conversation();
    const card = cardOf(await c.say("cancel my AC servicing"))!;
    const reply = await t.click(card.approvalId, "decline");
    expect(t.toolCalls(reply.runId).filter((x) => x.tool === "cancel")).toEqual([]);
    expect(t.bookingStatus("mb-demo-ac")).toBe("booked");
    expect(c.phase()).toBe("abandoned");
    expect(reply.message.text).toMatch(/kept|not cancel/i);
    t.testDb.close();
  });

  it("the booking changed since approval (cancelled in another conversation) → approval voided, no cancel call (R3)", async () => {
    const t = setup();
    const a = t.conversation();
    const b = t.conversation();
    const cardA = cardOf(await a.say("cancel my AC servicing"))!;
    const cardB = cardOf(await b.say("cancel my AC servicing"))!;
    await t.click(cardB.approvalId, "approve");
    expect(t.bookingStatus("mb-demo-ac")).toBe("cancelled");

    const reply = await t.click(cardA.approvalId, "approve");
    expect(t.toolCalls(reply.runId).filter((x) => x.tool === "cancel")).toEqual([]);
    const approval = t.testDb.db
      .prepare(`SELECT status, void_reason FROM approval WHERE id = ?`)
      .get(cardA.approvalId);
    expect(approval).toEqual({ status: "voided", void_reason: "booking_changed" });
    expect(reply.message.text).toMatch(/changed/i);
    expect(reply.message.text).not.toMatch(/^Cancelled/);
    t.testDb.close();
  });
});
