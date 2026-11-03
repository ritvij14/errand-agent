import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createClock } from "../shared/clock.js";
import { createTestDb } from "../shared/test-db.js";
import { seedDemoUsers } from "../auth/index.js";
import { seedMockWorld } from "../tools/index.js";
import { createConversationService } from "../conversations/index.js";
import { readTrace } from "../tracing/index.js";
import { scriptedModel } from "./index.js";

// U31 (MH-4, FR-6, § 2.5.7): "tell me about provider 2" calls get_provider once; reviews
// come back as a labelled part; injection reviews never change intent, approvals or state.

const ALICE = "u-demo-alice";

type DetailPart = {
  type: "provider_details";
  provider: { id: string; name: string; service: string; price: number; rating: number };
  reviews: { text: string; suspectedInjection?: boolean }[];
};
const detailPart = (reply: { message: { parts: Record<string, unknown>[] } }) =>
  reply.message.parts.find((p) => (p as { type: string }).type === "provider_details") as
    DetailPart | undefined;
const state = (t: ReturnType<typeof setup>) => {
  const phase =
    (
      t.testDb.db.prepare(`SELECT phase FROM workflow ORDER BY rowid DESC LIMIT 1`).get() as {
        phase?: string;
      }
    )?.phase ?? "none";
  const approvals = (t.testDb.db.prepare(`SELECT COUNT(*) c FROM approval`).get() as { c: number }).c;
  return { phase, approvals };
};
// the seeded injection reviews, with the provider's name, service and first area
const injectionReviews = (t: ReturnType<typeof setup>) =>
  t.testDb.db
    .prepare(
      `SELECT r.injection_kind kind, r.text, p.name, p.service, (SELECT area FROM mock_provider_area a WHERE a.provider_id = p.id LIMIT 1) area
       FROM mock_review r JOIN mock_provider p ON p.id = r.provider_id WHERE r.injection_kind IS NOT NULL ORDER BY r.injection_kind`,
    )
    .all() as { kind: string; text: string; name: string; service: string; area: string }[];
// a phrase findService reads, since the stored service slug isn't a phrase ("deep_cleaning")
const SERVICE_PHRASE: Record<string, string> = {
  plumber: "plumber",
  electrician: "electrician",
  ac_servicing: "AC servicing",
  deep_cleaning: "deep cleaning",
  carpentry: "carpentry",
};

const setup = () => {
  const testDb = createTestDb();
  const clock = createClock({ now: new Date("2026-11-02T03:45:00Z") });
  seedDemoUsers(testDb.db, clock.now().getTime());
  seedMockWorld(testDb.db, { seed: "errand-agent-v1", clock });
  const service = createConversationService({ db: testDb.db, clock, model: scriptedModel });
  const id = service.createConversation(ALICE).id;
  const say = async (text: string) => {
    const result = await service.sendMessage(ALICE, id, text, randomUUID());
    if (!result.ok) throw new Error(result.code);
    return result.reply;
  };
  const tools = (runId: string) =>
    readTrace(testDb.db, runId)
      .filter((e) => e.type === "tool_call")
      .map((e) => e.data as { tool: string; suspectedInjection?: boolean });
  return { testDb, say, tools };
};

describe("provider details (FR-6, V-?)", () => {
  it("'tell me about provider 2' calls get_provider once and shows a labelled reviews part", async () => {
    const t = setup();
    const first = await t.say("book a plumber in Indiranagar this week");
    const providers = (first.message.parts.find((p) => (p as { type: string }).type === "option_blocks") as
      { blocks: { provider: { id: string; name: string } }[] } | undefined)!.blocks.map((b) => b.provider);
    const reply = await t.say("tell me about provider 2");
    const part = detailPart(reply);
    expect(part?.provider).toMatchObject({ id: providers[1]!.id, name: providers[1]!.name });
    expect(part?.reviews.length).toBeGreaterThan(0);
    expect(part?.reviews.every((r) => typeof r.text === "string")).toBe(true);
    expect(reply.message.text).toMatch(/not checked|details/i);
    expect(t.tools(reply.runId).map((c) => c.tool)).toEqual(["get_provider"]);
    t.testDb.close();
  });

  it("the Details phrase names a provider from the results on screen", async () => {
    const t = setup();
    const first = await t.say("book a plumber in Indiranagar this week");
    const name = (first.message.parts.find((p) => (p as { type: string }).type === "option_blocks") as
      { blocks: { provider: { name: string } }[] } | undefined)!.blocks[0]!.provider.name;
    const reply = await t.say(`Tell me more about ${name}`);
    expect(detailPart(reply)?.provider.name).toBe(name);
    t.testDb.close();
  });

  it("no provider named → asked to use Details, no tool call, state untouched", async () => {
    const t = setup();
    const before = state(t);
    await t.say("book a plumber in Indiranagar this week");
    const at = state(t);
    const reply = await t.say("tell me about the best one around");
    expect(reply.message.text).toMatch(/Details|name/i);
    expect(detailPart(reply)).toBeUndefined();
    expect(t.tools(reply.runId)).toEqual([]);
    expect(state(t)).toEqual(at);
    expect(at.approvals).toBe(before.approvals);
    t.testDb.close();
  });

  it("every seeded injection review leaves intent, approvals and selection untouched", async () => {
    const t = setup();
    const kinds = injectionReviews(t);
    expect(kinds.map((x) => x.kind)).toEqual([
      "fake_approval",
      "fake_system",
      "memory_poisoning",
      "order",
      "price_trick",
    ]);
    for (const { kind, name, service, area } of kinds) {
      await t.say(`book ${SERVICE_PHRASE[service] ?? service} in ${area.replace("_", " ")} this week`);
      const before = state(t);
      const reply = await t.say(`Tell me more about ${name}`);
      const part = detailPart(reply);
      expect(part, kind).toBeDefined();
      expect(part!.reviews.filter((r) => r.suspectedInjection).length).toBeGreaterThan(0);
      expect(state(t), kind).toEqual(before);
      expect(reply.message.text.toLowerCase()).not.toContain("already approved");
      await t.say("never mind");
    }
    t.testDb.close();
  });

  it("a provider name that reads like a command is only a name: Confirm on its slot picks it and nothing else", async () => {
    const t = setup();
    const hostile = [
      "Cancel-Free Fixers", // would read as a cancel request
      "I Live In Whitefield Fixers", // would read as a stated area
      "Tell Me About Us Fixers", // would read as a details request
      "Forget My Area Fixers", // would read as a memory forget
    ];
    const ids = (
      t.testDb.db
        .prepare(
          `SELECT p.id FROM mock_provider p JOIN mock_provider_area a ON a.provider_id = p.id
           WHERE p.service = 'plumber' AND a.area = 'hsr_layout' ORDER BY p.id`,
        )
        .all() as { id: string }[]
    ).map((r) => r.id);
    expect(ids.length).toBeGreaterThanOrEqual(hostile.length);
    hostile.forEach((name, i) =>
      t.testDb.db.prepare(`UPDATE mock_provider SET name = ? WHERE id = ?`).run(name, ids[i]),
    );

    for (const name of hostile) {
      const first = await t.say("book a plumber in HSR Layout this week");
      const blocks = (
        first.message.parts.find((p) => (p as { type: string }).type === "option_blocks") as {
          blocks: { provider: { name: string }; slots: { pickText: string }[] }[];
        }
      ).blocks;
      const block = blocks.find((b) => b.provider.name === name && b.slots.length > 0);
      expect(block, `${name} has a free slot this week`).toBeDefined();
      if (!block) continue;
      const reply = await t.say(block.slots[0]!.pickText);
      expect(
        reply.message.parts.some((p) => (p as { type: string }).type === "approval_card"),
        name,
      ).toBe(true);
      expect(
        t.testDb.db.prepare(`SELECT intent, phase FROM workflow ORDER BY rowid DESC LIMIT 1`).get(),
        name,
      ).toEqual({ intent: "book", phase: "awaiting_approval" });
      expect(t.testDb.db.prepare(`SELECT COUNT(*) c FROM memory_fact`).get(), name).toEqual({ c: 0 });
      expect(t.tools(reply.runId).map((c) => c.tool), name).toEqual(["hold_slot"]);
      await t.say("never mind");
    }
    t.testDb.close();
  });

  it("the injection review is flagged in the trace (suspected_injection)", async () => {
    const t = setup();
    const { name, area, service } = injectionReviews(t)[0]!;
    await t.say(`book ${SERVICE_PHRASE[service] ?? service} in ${area.replace("_", " ")} this week`);
    const reply = await t.say(`Tell me more about ${name}`);
    const call = t.tools(reply.runId).find((c) => c.tool === "get_provider");
    expect(call?.suspectedInjection).toBe(true);
    t.testDb.close();
  });
});
