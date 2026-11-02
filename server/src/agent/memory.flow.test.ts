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

describe("stated memory (MH-6)", () => {
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

  it("'what do you remember about me?' answers from memory, marking source; other users' facts stay theirs (V-7)", async () => {
    const t = setup();
    const alice = t.conversation();
    await alice.say("I live in HSR");
    const reply = await alice.say("what do you remember about me?");
    expect(reply.message.text).toMatch(/hsr/i);
    t.testDb.close();
  });
});
