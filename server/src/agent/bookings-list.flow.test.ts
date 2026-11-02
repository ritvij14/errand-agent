import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createClock } from "../shared/clock.js";
import { createTestDb } from "../shared/test-db.js";
import { seedDemoUsers } from "../auth/index.js";
import { seedMockWorld } from "../tools/index.js";
import { createConversationService } from "../conversations/index.js";
import { readTrace } from "../tracing/index.js";
import { scriptedModel } from "./index.js";

// List my bookings (FR-5) and user isolation (V-7, I-10): which user's bookings are
// read comes from the signed-in user, never from the text.

const ALICE = "u-demo-alice";
const BOB = "u-demo-bob";

const setup = () => {
  const testDb = createTestDb();
  const clock = createClock({ now: new Date("2026-11-02T03:45:00Z") });
  seedDemoUsers(testDb.db, clock.now().getTime());
  seedMockWorld(testDb.db, { seed: "errand-agent-v1", clock });
  testDb.db
    .prepare(
      `INSERT INTO mock_booking (id, user_id, provider_id, service, area, slot, price, status, cancel_503_served, created_at, updated_at)
       VALUES ('b-bob-1', ?, (SELECT id FROM mock_provider LIMIT 1), 'carpentry', 'indiranagar', '2026-11-09T09:00:00+05:30', 700, 'booked', 0, 0, 0)`,
    )
    .run(BOB);
  const service = createConversationService({ db: testDb.db, clock, model: scriptedModel });
  const chat = (userId: string) => {
    const conversationId = service.createConversation(userId).id;
    return async (text: string) => {
      const result = await service.sendMessage(userId, conversationId, text, randomUUID());
      if (!result.ok) throw new Error(result.code);
      return result.reply;
    };
  };
  const ownBookingIds = (userId: string) =>
    (
      testDb.db.prepare(`SELECT id FROM mock_booking WHERE user_id = ? ORDER BY id`).all(userId) as {
        id: string;
      }[]
    ).map((b) => b.id);
  return { testDb, chat, ownBookingIds };
};

type ListPart = {
  type: string;
  bookings: { id: string; providerName: string; slotLabel: string; price: number; status: string }[];
};
const listPart = (reply: { message: { parts: Record<string, unknown>[] } }) =>
  reply.message.parts.find((p) => p.type === "bookings_list") as ListPart | undefined;

describe("list my bookings (FR-5)", () => {
  it("'show my bookings' lists the signed-in user's bookings, past and upcoming, through list_bookings", async () => {
    const t = setup();
    const reply = await t.chat(ALICE)("show my bookings");
    const part = listPart(reply);
    expect(part?.bookings.map((b) => b.id).sort()).toEqual(t.ownBookingIds(ALICE));
    expect(part?.bookings.map((b) => b.status).sort()).toEqual(["booked", "completed"]);
    expect(part?.bookings.every((b) => b.slotLabel && b.providerName && b.price > 0)).toBe(true);
    const tools = readTrace(t.testDb.db, reply.runId)
      .filter((e) => e.type === "tool_call")
      .map((e) => (e.data as { tool: string }).tool);
    expect(tools).toEqual(["list_bookings"]);
    t.testDb.close();
  });

  it("naming another user changes nothing: alice asking for bob's bookings sees only her own (V-7)", async () => {
    const t = setup();
    const reply = await t.chat(ALICE)("show bob's bookings");
    const ids = listPart(reply)?.bookings.map((b) => b.id) ?? [];
    expect(ids.sort()).toEqual(t.ownBookingIds(ALICE));
    expect(JSON.stringify(reply.message)).not.toContain("b-bob-1");
    t.testDb.close();
  });

  it("each user sees only their own: bob gets his one booking, never alice's", async () => {
    const t = setup();
    const reply = await t.chat(BOB)("list my bookings and alice's too");
    expect(listPart(reply)?.bookings.map((b) => b.id)).toEqual(["b-bob-1"]);
    t.testDb.close();
  });

  it("a user with no bookings is told so", async () => {
    const t = setup();
    const reply = await t.chat("u-demo-charlie")("show my bookings");
    expect(listPart(reply)?.bookings).toEqual([]);
    expect(reply.message.text).toMatch(/no bookings/i);
    t.testDb.close();
  });

  it("asking mid-request answers the question and leaves the request where it was", async () => {
    const t = setup();
    const say = t.chat(ALICE);
    const options = await say("plumber in HSR Layout this week, mornings only, under ₹1,500");
    expect(options.message.parts.some((p) => p.type === "option_blocks")).toBe(true);
    const listed = await say("show my bookings");
    expect(listPart(listed)).toBeDefined();
    const phase = t.testDb.db.prepare(`SELECT phase FROM workflow WHERE user_id = ?`).get(ALICE) as {
      phase: string;
    };
    expect(phase.phase).toBe("choosing");
    t.testDb.close();
  });
});
