import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createClock } from "../shared/clock.js";
import { createTestDb } from "../shared/test-db.js";
import { seedDemoUsers } from "../auth/index.js";
import { seedMockWorld } from "../tools/index.js";
import { createConversationService } from "../conversations/index.js";
import { readTrace } from "../tracing/index.js";
import { scriptedModel } from "./index.js";
import { createWorkflowStore } from "./workflow.js";
import type { OptionBlock } from "./options.js";

// searching → choosing (FR-9, § 2.5.2) driven through the conversation service, the
// way the API does it. Fixed now: Mon 2026-11-02 09:15 IST; "this week" = 02–08 Nov.

const ALICE = "u-demo-alice";

const setup = (now = new Date("2026-11-02T03:45:00Z")) => {
  const testDb = createTestDb();
  const clock = createClock({ now });
  seedDemoUsers(testDb.db, clock.now().getTime());
  seedMockWorld(testDb.db, { seed: "errand-agent-v1", clock });
  const service = createConversationService({ db: testDb.db, clock, model: scriptedModel });
  const conversationId = service.createConversation(ALICE).id;
  const say = async (text: string) => {
    const result = await service.sendMessage(ALICE, conversationId, text, randomUUID());
    if (!result.ok) throw new Error(`send failed: ${result.code}`);
    return result.reply;
  };
  const workflow = () =>
    testDb.db.prepare(`SELECT phase, facts FROM workflow WHERE conversation_id = ?`).get(conversationId) as {
      phase: string;
      facts: string;
    };
  return { testDb, say, workflow };
};

const blocksOf = (reply: { message: { parts: Record<string, unknown>[] } }): OptionBlock[] | undefined =>
  reply.message.parts.find((p) => p.type === "option_blocks")?.blocks as OptionBlock[] | undefined;

describe("search and option blocks", () => {
  it("a complete request returns provider blocks that respect budget and time, and waits in choosing", async () => {
    const { testDb, say, workflow } = setup();
    const reply = await say("plumber in HSR Layout this week, mornings only, under ₹1,500");
    const blocks = blocksOf(reply);
    expect(blocks?.length).toBeGreaterThan(0);
    for (const block of blocks!) {
      expect(block.provider.price).toBeLessThanOrEqual(1500);
      for (const slot of block.slots) {
        expect(slot.start.slice(0, 10) >= "2026-11-02" && slot.start.slice(0, 10) <= "2026-11-08").toBe(true);
        expect(slot.start.slice(11, 16) < "12:00").toBe(true);
      }
    }
    expect(reply.message.text).toMatch(/tap a slot/i);
    expect(workflow().phase).toBe("choosing");
    const events = readTrace(testDb.db, reply.runId);
    expect(
      events.filter((e) => e.type === "tool_call").map((e) => (e.data as { tool: string }).tool),
    ).toEqual(["search_providers"]);
    const run = testDb.db.prepare(`SELECT tool_calls FROM run WHERE id = ?`).get(reply.runId) as {
      tool_calls: number;
    };
    expect(run.tool_calls).toBe(1);
    testDb.close();
  });

  it("correcting the budget after options redoes the search and keeps service, area and time (rule 2)", async () => {
    const { testDb, say, workflow } = setup();
    await say("plumber in HSR Layout this week, mornings only, under ₹1,500");
    const before = JSON.parse(workflow().facts) as Record<string, { value: unknown }>;
    const reply = await say("make the budget ₹900");
    const after = JSON.parse(workflow().facts) as Record<string, { value: unknown }>;
    expect(after.budget!.value).toBe(900);
    for (const key of ["service", "area", "time_window"])
      expect(after[key]!.value).toEqual(before[key]!.value);
    const searched = readTrace(testDb.db, reply.runId).filter((e) => e.type === "tool_call");
    expect(searched).toHaveLength(1);
    const blocks = blocksOf(reply);
    if (blocks) expect(blocks.every((b) => b.provider.price <= 900)).toBe(true);
    else expect(reply.message.text).toMatch(/budget/i);
    testDb.close();
  });

  it("when nothing fits the budget, NO_MATCHES says the budget excluded everything and shows no options", async () => {
    const { testDb, say, workflow } = setup();
    const reply = await say("plumber in HSR Layout this week under ₹100");
    expect(blocksOf(reply)).toBeUndefined();
    expect(reply.message.text).toMatch(/budget/i);
    expect(reply.message.text).toMatch(/₹/);
    expect(workflow().phase).toBe("searching");
    testDb.close();
  });

  it("asked in the evening, 'this week, mornings only' still offers the coming mornings (regression)", async () => {
    const { testDb, say } = setup(new Date("2026-11-02T12:30:00Z")); // Mon 18:00 IST
    const blocks = blocksOf(await say("plumber in HSR Layout this week, mornings only"));
    expect(blocks?.length).toBeGreaterThan(0);
    for (const slot of blocks!.flatMap((b) => b.slots)) {
      expect(slot.start.slice(0, 10) > "2026-11-02").toBe(true); // today's mornings are past
      expect(slot.start.slice(11, 16) < "12:00").toBe(true);
    }
    testDb.close();
  });

  it("raising the budget after NO_MATCHES searches again and shows options", async () => {
    const { testDb, say } = setup();
    await say("plumber in HSR Layout this week under ₹100");
    const reply = await say("make the budget ₹2,000");
    expect(blocksOf(reply)?.length).toBeGreaterThan(0);
    testDb.close();
  });
});

describe("workflow saves", () => {
  it("a save that fails for a reason other than the one-active-workflow race is raised, not reported as a lost race", () => {
    const testDb = createTestDb();
    const clock = createClock({ now: new Date("2026-11-02T03:45:00Z") });
    const store = createWorkflowStore(testDb.db, clock, scriptedModel);
    // no such conversation → foreign-key failure, a real bug that must surface
    expect(() => store.saveWorkflow("missing-conversation", -1, (w) => ({ ...w, user_id: ALICE }))).toThrow(
      /FOREIGN KEY/,
    );
    testDb.close();
  });
});
