import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createClock } from "../shared/clock.js";
import { createTestDb } from "../shared/test-db.js";
import { seedDemoUsers } from "../auth/index.js";
import { seedMockWorld } from "../tools/index.js";
import { createConversationService } from "../conversations/index.js";
import { readTrace } from "../tracing/index.js";
import { scriptedModel } from "./index.js";

// U30 (FR-15, FR-16, V-10): "never mind" abandons the request; a different request on an
// unfinished workflow asks before dropping; during executing the switch waits.

const ALICE = "u-demo-alice";

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
  const latest = () =>
    testDb.db
      .prepare(
        `SELECT phase, intent, pending_question, facts FROM workflow WHERE conversation_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
      )
      .get(id) as { phase: string; intent: string | null; pending_question: string | null; facts: unknown };
  const workflows = () =>
    testDb.db
      .prepare(`SELECT intent, phase FROM workflow WHERE conversation_id = ? ORDER BY rowid`)
      .all(id) as {
      intent: string | null;
      phase: string;
    }[];
  const tools = (runId: string) =>
    readTrace(testDb.db, runId)
      .filter((e) => e.type === "tool_call")
      .map((e) => (e.data as { tool: string }).tool);
  return { testDb, say, latest, workflows, tools };
};

describe("drop a request (FR-16, V-10)", () => {
  it("'never mind' mid-booking abandons the request without any tool call — wording says what was not done", async () => {
    const t = setup();
    await t.say("book a plumber in Indiranagar");
    const reply = await t.say("never mind");
    expect(t.latest()).toMatchObject({ phase: "abandoned" });
    expect(reply.message.text).toMatch(/^Okay, dropped\. Nothing was booked\.$/);
    expect(t.tools(reply.runId)).toEqual([]);
    t.testDb.close();
  });

  it("'never mind, <new request>' abandons the current request and starts the new one in the same message", async () => {
    const t = setup();
    await t.say("book a plumber in Indiranagar");
    const reply = await t.say("never mind, I want an electrician in HSR tomorrow");
    expect(t.workflows()).toEqual([
      { intent: "book", phase: "abandoned" },
      { intent: "book", phase: "choosing" },
    ]);
    expect(t.latest().facts).toMatch(/electrician/);
    expect(reply.message.text).toMatch(/^Okay, dropped\. Nothing was booked\. /);
    t.testDb.close();
  });

  it("'never mind, <new request>' with nothing open just starts the new request", async () => {
    const t = setup();
    await t.say("never mind, I want an electrician in HSR tomorrow");
    expect(t.workflows()).toEqual([{ intent: "book", phase: "choosing" }]);
    t.testDb.close();
  });

  it("dropping a reschedule says nothing was changed; dropping a cancel says the booking is unchanged", async () => {
    const t = setup();
    await t.say("move my AC servicing to Saturday afternoon");
    let reply = await t.say("forget it");
    expect(reply.message.text).toBe("Okay, dropped. Nothing was changed.");
    await t.say("cancel my AC servicing");
    reply = await t.say("cancel that");
    expect(reply.message.text).toBe("Okay, dropped. Your booking is unchanged.");
    expect(t.latest()).toMatchObject({ phase: "abandoned" });
    t.testDb.close();
  });
});

describe("switching tasks on an unfinished request (FR-15)", () => {
  it("a different request asks before dropping — the old workflow is untouched and holds the question", async () => {
    const t = setup();
    await t.say("book a plumber in Indiranagar");
    const reply = await t.say("move my AC servicing to Saturday afternoon");
    const w = t.latest();
    expect(w).toMatchObject({ phase: "collecting", intent: "book", pending_question: expect.any(String) });
    expect(w.pending_question).toContain("task_switch");
    expect(reply.message.text).toMatch(
      /haven't finished booking the plumber\. Drop it and move the AC servicing\?/,
    );
    expect(t.workflows()).toHaveLength(1);
    t.testDb.close();
  });

  it("'yes' to the switch abandons the old request and starts the new one", async () => {
    const t = setup();
    await t.say("book a plumber in Indiranagar");
    await t.say("move my AC servicing to Saturday evening"); // Ganesh Cooltech is free at 17:00
    const reply = await t.say("yes");
    expect(t.workflows()).toEqual([
      { intent: "book", phase: "abandoned" },
      { intent: "reschedule", phase: "choosing" },
    ]);
    expect(reply.message.text).toMatch(/price stays|tap one/i);
    t.testDb.close();
  });

  it("'no' keeps the old request — the new one is not applied", async () => {
    const t = setup();
    await t.say("book a plumber in Indiranagar");
    await t.say("move my AC servicing to Saturday afternoon");
    const reply = await t.say("no");
    expect(t.latest()).toMatchObject({ phase: "collecting", intent: "book", pending_question: null });
    const facts = JSON.parse(t.latest().facts as unknown as string) as { service: { value: string } };
    expect(facts.service.value).toBe("plumber");
    expect(reply.message.text).toMatch(/when|plumber/i);
    t.testDb.close();
  });

  it("a cancel request while booking asks first; 'yes' starts the cancel flow (V-10)", async () => {
    const t = setup();
    await t.say("book a plumber in Indiranagar");
    const reply = await t.say("cancel my AC servicing");
    expect(reply.message.text).toMatch(/Drop it and cancel the AC servicing\?/);
    expect(t.latest().intent).toBe("book");
    const yes = await t.say("yes");
    expect(t.latest()).toMatchObject({ phase: "awaiting_approval", intent: "cancel" });
    expect(JSON.stringify(yes.message.parts)).toContain('"cancel"');
    t.testDb.close();
  });

  it("'no' to the switch keeps the booking task", async () => {
    const t = setup();
    await t.say("book a plumber in Indiranagar");
    await t.say("cancel my AC servicing");
    const reply = await t.say("no");
    expect(t.latest()).toMatchObject({ intent: "book", pending_question: null });
    expect(reply.message.text).toMatch(/when|plumber/i);
    t.testDb.close();
  });

  it("with an approval card open, a new request is refused until the card is resolved — no stacked question (R9)", async () => {
    const t = setup();
    await t.say("cancel my AC servicing"); // → card immediately
    const reply = await t.say("book an electrician");
    expect(t.latest()).toMatchObject({
      phase: "awaiting_approval",
      intent: "cancel",
      pending_question: null,
    });
    expect(reply.message.text).toMatch(/approve or decline/i);
    t.testDb.close();
  });

  it("after the switch, later saves touch only the active workflow — the abandoned one is never rewritten", async () => {
    const t = setup();
    await t.say("book a plumber in Indiranagar");
    await t.say("move my AC servicing to Saturday afternoon");
    await t.say("yes"); // old row abandoned, both rows briefly sit on the same version
    await t.say("never mind");
    expect(t.workflows()).toEqual([
      { intent: "book", phase: "abandoned" },
      { intent: "reschedule", phase: "abandoned" },
    ]);
    t.testDb.close();
  });
});
describe("during executing the switch waits and corrections are refused", () => {
  // a booking whose operation is gone (only the phase says executing) — recovery has nothing to settle
  const forceExecuting = (t: ReturnType<typeof setup>) => {
    t.testDb.db.prepare(`UPDATE workflow SET phase = 'executing', version = version + 1`).run();
  };

  it("a correction is refused with CHANGE_REFUSED_IN_FLIGHT and nothing is applied", async () => {
    const t = setup();
    await t.say("book a plumber in Indiranagar");
    forceExecuting(t);
    const reply = await t.say("actually after 11 a.m.");
    expect(reply.message.text).toMatch(/can't change it while I'm confirming/i);
    expect(t.latest()).toMatchObject({ phase: "executing", intent: "book" });
    t.testDb.close();
  });

  it("a task switch during executing waits instead of dropping", async () => {
    const t = setup();
    await t.say("book a plumber in Indiranagar");
    forceExecuting(t);
    const reply = await t.say("cancel my AC servicing");
    expect(reply.message.text).toMatch(/still confirming/i);
    expect(t.latest()).toMatchObject({ phase: "executing", intent: "book" });
    t.testDb.close();
  });
});
