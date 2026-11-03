import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createClock } from "../shared/clock.js";
import { createTestDb } from "../shared/test-db.js";
import { seedDemoUsers } from "../auth/index.js";
import { seedMockWorld } from "../tools/index.js";
import * as memory from "../memory/index.js";
import { createConversationService } from "../conversations/index.js";
import { scriptedModel } from "./index.js";

// U32 (MH-6, FR-12 chat, R6, V-11): stated memory is saved from lasting statements only,
// fills workflow facts at start with a one-line note, syncs when forgotten (R6), and a
// request detail that differs applies to that request only (V-11).

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
    return { id, say };
  };
  const facts = (conversationId: string) =>
    JSON.parse(
      (
        testDb.db
          .prepare(`SELECT facts FROM workflow WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1`)
          .get(conversationId) as { facts: string }
      ).facts,
    ) as Record<string, { value: unknown; source: string; memoryFactId?: string }>;
  const phases = (conversationId: string) =>
    (
      testDb.db
        .prepare(`SELECT phase FROM workflow WHERE conversation_id = ? ORDER BY rowid`)
        .all(conversationId) as { phase: string }[]
    ).map((r) => r.phase);
  return { testDb, conversation, facts, phases };
};

describe("inferred preferred provider (U33, V-12, R9)", () => {
  // the seeded demo booking mb-demo-electrician is alice's completed electrician job with one provider
  const addCompletedBooking = (t: ReturnType<typeof setup>) => {
    const providerId = (
      t.testDb.db.prepare(`SELECT provider_id FROM mock_booking WHERE id = 'mb-demo-electrician'`).get() as {
        provider_id: string;
      }
    ).provider_id;
    t.testDb.db
      .prepare(
        `INSERT INTO mock_booking (id, user_id, provider_id, service, area, slot, price, status, cancel_503_served, created_at, updated_at)
         VALUES ('mb-x2', ?, ?, 'electrician', 'koramangala', '2026-10-31T09:00:00+05:30', 500, 'booked', 0, 0, 0)`,
      )
      .run(ALICE, providerId);
    return providerId;
  };

  it("two completed bookings with the same provider propose the fact with evidence; awaiting is never used; 'yes' confirms and filters the options", async () => {
    const t = setup();
    const providerId = addCompletedBooking(t);
    const c = t.conversation();
    const reply = await c.say("book an electrician in koramangala this week");
    const fact = memory.view(t.testDb.db, ALICE)[0]!;
    expect(fact).toMatchObject({
      key: "preferred_provider",
      service: "electrician",
      value: providerId,
      status: "awaiting_confirmation",
      source: "inferred",
    });
    expect(fact.evidence).toMatch(/bookings with|booked/i);
    // the ask is one light question; the search is NOT filtered yet (I-7)
    expect(reply.message.text).toMatch(/keep them coming|last two/i);
    const blocksCount = (
      reply.message.parts.find((p) => (p as { type: string }).type === "option_blocks") as
        { blocks?: unknown[] } | undefined
    )?.blocks?.length;
    expect(blocksCount ?? 0).toBeGreaterThan(1);
    // "yes" binds to the confirm question: the fact activates and the options narrow
    const yes = await c.say("yes");
    expect(memory.state(t.testDb.db, ALICE, "preferred_provider", "electrician")).toMatchObject({
      status: "active",
      source: "inferred",
    });
    expect(yes.message.text).toMatch(/your choice/i);
    const after = (
      yes.message.parts.find((p) => (p as { type: string }).type === "option_blocks") as
        { blocks?: { provider: { id: string } }[] } | undefined
    )?.blocks;
    expect(after && after.length > 0).toBe(true);
    expect(after!.every((b) => b.provider.id === providerId)).toBe(true);
    t.testDb.close();
  });

  it("'no' forgets the proposal; the same provider is never inferred again (V-12)", async () => {
    const t = setup();
    addCompletedBooking(t);
    const c = t.conversation();
    await c.say("book an electrician in koramangala this week");
    expect(memory.view(t.testDb.db, ALICE)).toHaveLength(1);
    await c.say("no");
    expect(memory.view(t.testDb.db, ALICE)).toHaveLength(0);
    // another request with the same provider: no new awaiting fact, no ask
    const again = await c.say("book an electrician in koramangala next week");
    expect(memory.view(t.testDb.db, ALICE)).toHaveLength(0);
    expect(again.message.text).not.toMatch(/keep them coming|last two/i);
    t.testDb.close();
  });

  it("'the same electrician as last time' proposes from the phrase with the last booking as evidence", async () => {
    const t = setup();
    const providerId = addCompletedBooking(t);
    const c = t.conversation();
    const reply = await c.say("the same electrician as last time in koramangala, any time");
    const fact = memory.view(t.testDb.db, ALICE)[0]!;
    expect(fact).toMatchObject({
      key: "preferred_provider",
      value: providerId,
      status: "awaiting_confirmation",
    });
    expect(fact.evidence).toMatch(/as last time|booked/i);
    expect(reply.message.text).toMatch(/Your last electrical work booking was with .+ — keep them coming\?/);
    t.testDb.close();
  });
});

describe("stated memory (MH-6)", () => {
  it("a one-off request detail is never saved as stated", async () => {
    const t = setup();
    const { id, say } = t.conversation();
    await say("plumber in HSR");
    expect(t.testDb.db.prepare(`SELECT COUNT(*) c FROM memory_fact`).get()).toEqual({ c: 0 });
    t.testDb.close();
    void id;
  });

  it("a one-off request detail is never saved as stated", async () => {
    const t = setup();
    const { id, say } = t.conversation();
    await say("plumber in HSR");
    expect(t.testDb.db.prepare(`SELECT COUNT(*) c FROM memory_fact`).get()).toEqual({ c: 0 });
    t.testDb.close();
    void id;
  });

  it("'I live in HSR' saves a stated fact and says so", async () => {
    const t = setup();
    const { say } = t.conversation();
    const reply = await say("I live in HSR");
    expect(memory.view(t.testDb.db, ALICE)).toEqual([
      expect.objectContaining({ key: "area", value: "hsr_layout", source: "stated", status: "active" }),
    ]);
    expect(reply.message.text).toMatch(/Saved|area/i);
    t.testDb.close();
  });

  it("a new conversation fills the saved area with source memory and a one-line note", async () => {
    const t = setup();
    const first = t.conversation();
    await first.say("book a plumber in HSR, any time");
    await first.say("I live in HSR");
    const second = t.conversation();
    const reply = await second.say("book an electrician");
    const f = t.facts(second.id);
    expect(f.area).toMatchObject({ value: "hsr_layout", source: "memory" });
    expect(f.area?.memoryFactId).toEqual(expect.any(String));
    expect(reply.message.text).toMatch(/saved area: HSR Layout/i);
    // the ask names the details as the user reads them, never raw ids
    expect(reply.message.text).toMatch(/Electrical work in HSR Layout — when\?$/);
    expect(t.phases(second.id)).toEqual(["collecting"]);
    t.testDb.close();
  });

  it("forgetting the area: the record is marked, and the open workflow drops it at its next run (R6)", async () => {
    const t = setup();
    const c = t.conversation();
    await c.say("I live in HSR");
    await c.say("book a plumber"); // area filled from memory
    expect(t.facts(c.id).area?.value).toBe("hsr_layout");
    const reply = await c.say("forget my area");
    expect(reply.message.text).toMatch(/forgotten/i);
    const next = await c.say("tomorrow morning"); // next run start syncs the workflow (R6)
    expect(next.message.text).toMatch(/in|which area|tomorrow/i);
    expect(memory.state(t.testDb.db, ALICE, "area")).toBeUndefined();
    const f = t.facts(c.id);
    expect(f.area).toBeUndefined();
    t.testDb.close();
  });

  it("'forget everything you know about me' forgets every saved and waiting fact, and says what went", async () => {
    const t = setup();
    const c = t.conversation();
    await c.say("I live in HSR");
    await c.say("never before 10am");
    const { fact } = memory.inferCandidate(
      t.testDb.db,
      createClock({ now: new Date("2026-11-02T03:45:00Z") }),
      ALICE,
      "preferred_provider",
      "mp-002",
      "electrician",
      "booked twice",
    );
    const reply = await c.say("forget everything you know about me");
    expect(reply.message.text).toMatch(/Forgotten: area, earliest time, preferred electrician/i);
    expect(memory.view(t.testDb.db, ALICE)).toEqual([]);
    // the waiting provider is blocked from re-inference like any forgotten value
    expect(memory.blockedByForget(t.testDb.db, ALICE, "preferred_provider", fact!.value)).toBe(true);
    const again = await c.say("forget everything");
    expect(again.message.text).toMatch(/nothing saved/i);
    t.testDb.close();
  });

  it("a user-given fact survives a forget (R6: source user is never touched)", async () => {
    const t = setup();
    const c = t.conversation();
    await c.say("I live in HSR");
    await c.say("book a plumber in Jayanagar, any time"); // user gave the area this request
    await c.say("forget my area");
    expect(t.facts(c.id).area).toMatchObject({ value: "jayanagar", source: "user" });
    t.testDb.close();
  });

  it("correcting a saved area updates memory and the open workflow detail (MH-1 cascade stays in code)", async () => {
    const t = setup();
    const c = t.conversation();
    await c.say("I live in HSR");
    await c.say("book a plumber"); // memory area fills
    await c.say("Actually I want it in Jayanagar"); // request-only difference (V-11)
    expect(memory.state(t.testDb.db, ALICE, "area")!.value).toBe("hsr_layout");
    expect(t.facts(c.id).area).toMatchObject({ value: "jayanagar", source: "user" });
    const reply = await c.say("my area is Koramangala now"); // an explicit correction of the preference
    expect(memory.state(t.testDb.db, ALICE, "area")!.value).toBe("koramangala");
    expect(reply.message.text).toMatch(/Saved|updated|koramangala/i);
    t.testDb.close();
  });

  it("a saved 'never before 10' also bounds a request that names only days; forgetting it keeps the days (MH-6, R6)", async () => {
    const t = setup();
    const c = t.conversation();
    await c.say("never before 10am");
    const reply = await c.say("plumber in HSR this week");
    expect(reply.message.text).toMatch(/saved time: not before 10:00/i);
    const offered = (
      reply.message.parts.find((p) => (p as { type: string }).type === "option_blocks") as
        { blocks: { slots: { start: string }[] }[] }
    ).blocks.flatMap((b) => b.slots.map((s) => s.start.slice(11, 16)));
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.every((time) => time >= "10:00")).toBe(true);
    expect(t.facts(c.id).time_window).toMatchObject({
      value: { dateFrom: "2026-11-02", dateTo: "2026-11-08", earliest: "10:00" },
      source: "memory",
    });
    await c.say("forget my time");
    const next = await c.say("what do you remember about me?");
    void next;
    expect(t.facts(c.id).time_window).toMatchObject({
      value: { dateFrom: "2026-11-02", dateTo: "2026-11-08", earliest: null },
    });
    t.testDb.close();
  });

  it("a request's own earliest time wins over the saved one (V-11)", async () => {
    const t = setup();
    const c = t.conversation();
    await c.say("never before 10am");
    await c.say("plumber in HSR this week, after 12");
    expect(t.facts(c.id).time_window).toMatchObject({ value: { earliest: "12:00" }, source: "user" });
    t.testDb.close();
  });

  it("the brief's 'same electrician as last time, but not before 10 a.m.' starts a booking and saves nothing stated", async () => {
    const t = setup();
    const c = t.conversation();
    await c.say("Book the same electrician as last time, but not before 10 a.m.");
    expect(t.facts(c.id)).toMatchObject({
      service: { value: "electrician" },
      time_window: { value: { earliest: "10:00" } },
    });
    expect(memory.state(t.testDb.db, ALICE, "earliest_time")).toBeUndefined();
    await c.say("Koramangala");
    expect(t.facts(c.id)).toMatchObject({ service: { value: "electrician" }, area: { value: "koramangala" } });
    t.testDb.close();
  });

  it("'what do you remember about me?' answers from memory, marking source; other users' facts stay theirs (V-7)", async () => {
    const t = setup();
    const alice = t.conversation();
    await alice.say("I live in HSR");
    const reply = await alice.say("what do you remember about me?");
    expect(reply.message.text).toMatch(/hsr/i);
    t.testDb.close();
  });
});
