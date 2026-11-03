import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createTestDb, type TestDb } from "./shared/test-db.js";
import { createApp } from "./app.js";
import { createClock } from "./shared/clock.js";
import { DEMO_USERS } from "./shared/demo-users.js";
import { seedDemoUsers } from "./auth/index.js";
import { DEFAULT_SEED, seedMockWorld } from "./tools/index.js";

let server: Server;
let baseUrl: string;
let testDb: TestDb;
let armBusyTest: (park: Promise<void>) => void;
let releaseBusyTest: () => void;

const alice = DEMO_USERS[0]!;
const bob = DEMO_USERS[1]!;

const cookies: Record<string, string> = {};

async function call(who: string, path: string, method: "POST" | "GET" | "DELETE", body?: unknown) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "sec-fetch-site": "same-origin",
  };
  if (cookies[who]) headers.cookie = cookies[who];
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie && !cookies[who]) cookies[who] = setCookie.split(";")[0]!;
  const text = await res.text();
  return { status: res.status, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

beforeAll(async () => {
  testDb = createTestDb();
  const clock = createClock();
  const { default: baseModel } = await import("./agent/index.js");
  // the busy test parks the model's read call until released; unarmed otherwise
  let gate: Promise<void> | null = null;
  const gatedModel = {
    ...baseModel,
    read: async (input: Parameters<typeof baseModel.read>[0]) => {
      if (gate) await gate;
      return baseModel.read(input);
    },
  };
  armBusyTest = (park) => {
    gate = park;
  };
  releaseBusyTest = () => {
    gate = null;
  };
  const app = createApp({ db: testDb.db, clock, model: gatedModel });
  seedDemoUsers(testDb.db, clock.now().getTime());
  seedMockWorld(testDb.db, { seed: DEFAULT_SEED, clock });
  server = app.listen(0);
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`;
  await call("alice", "/api/auth/sign-in", "POST", { username: alice.username, password: alice.password });
  await call("bob", "/api/auth/sign-in", "POST", { username: bob.username, password: bob.password });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  testDb.close();
});

describe("conversations", () => {
  it("create, list — a user sees only their conversations", async () => {
    const mine = await call("alice", "/api/conversations", "POST");
    expect(mine.status).toBe(201);
    const bobList = await call("bob", "/api/conversations", "GET");
    expect(bobList.body.data as unknown[]).toEqual([]);
    const aliceList = await call("alice", "/api/conversations", "GET");
    expect(
      (aliceList.body.data as { id: string }[]).some((c) => c.id === (mine.body.data as { id: string }).id),
    ).toBe(true);
  });

  it("read returns messages oldest first; another user's conversation → NOT_FOUND", async () => {
    const created = (await call("alice", "/api/conversations", "POST")).body.data as { id: string };
    await call("alice", `/api/conversations/${created.id}/messages`, "POST", {
      text: "hello",
      clientMessageId: "cm-read-1",
    });
    const read = await call("alice", `/api/conversations/${created.id}`, "GET");
    expect(read.status).toBe(200);
    const messages = (read.body.data as { messages: { role: string; text: string }[] }).messages;
    expect(messages.map((m) => m.role)).toEqual(["user", "agent"]);

    const intruder = await call("bob", `/api/conversations/${created.id}`, "GET");
    expect(intruder.status).toBe(404);
    expect(intruder.body.code).toBe("NOT_FOUND");
  });

  it("unauthenticated → 401", async () => {
    const headers = { "content-type": "application/json", "sec-fetch-site": "same-origin" };
    const res = await fetch(`${baseUrl}/api/conversations`, { method: "POST", headers, body: "{}" });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("UNAUTHENTICATED");
  });
});

describe("send message", () => {
  it("returns a help reply with runId, outcome completed, and records a run with 2 model calls", async () => {
    const created = (await call("alice", "/api/conversations", "POST")).body.data as { id: string };
    const res = await call("alice", `/api/conversations/${created.id}/messages`, "POST", {
      text: "find a plumber",
      clientMessageId: "cm-help-1",
    });
    expect(res.status).toBe(200);
    const reply = res.body.data as {
      runId: string;
      outcome: string;
      message: { role: string; text: string; parts: unknown[] };
    };
    expect(reply.outcome).toBe("completed");
    expect(reply.message.role).toBe("agent");
    expect(reply.message.text.length).toBeGreaterThan(0);
    expect(reply.message.parts).toEqual([]);
    const run = testDb.db.prepare("SELECT outcome, model_calls FROM run WHERE id = ?").get(reply.runId) as {
      outcome: string;
      model_calls: number;
    };
    expect(run.outcome).toBe("completed");
    expect(run.model_calls).toBe(2);
    expect((reply.runId as string).length).toBeGreaterThan(0);
    // messages saved: user + agent
    const stored = testDb.db
      .prepare("SELECT role FROM message WHERE conversation_id = ? ORDER BY created_at")
      .all(created.id) as { role: string }[];
    expect(stored.map((m) => m.role)).toEqual(["user", "agent"]);
  });

  it("the trace of that run shows run_started → model_call ×2 → run_ended", async () => {
    const created = (await call("alice", "/api/conversations", "POST")).body.data as { id: string };
    const sent = (
      await call("alice", `/api/conversations/${created.id}/messages`, "POST", {
        text: "hi",
        clientMessageId: "cm-trace-1",
      })
    ).body.data as { runId: string };
    const trace = await call("alice", `/api/runs/${sent.runId}/trace`, "GET");
    expect(trace.status).toBe(200);
    const all = (trace.body.data as { events: { type: string; data: Record<string, unknown> }[] }).events;
    const events = all.map((e) => e.type);
    expect(events).toEqual(["run_started", "model_call", "model_call", "run_ended"]);
    // both model calls show what went in and what came out (§ 2.5.9): read ← the text, write ← the decision
    expect(all[1]!.data).toMatchObject({ job: "read", input: "hi" });
    expect(all[2]!.data).toMatchObject({ job: "write", input: { phase: expect.any(String) } });
    expect(all[2]!.data.output).toEqual(expect.any(String));
    // the page finds the trace from the reloaded conversation: each agent message names its run as `runId` (api-contracts)
    const reloaded = (await call("alice", `/api/conversations/${created.id}`, "GET")).body.data as {
      messages: Record<string, unknown>[];
    };
    expect(reloaded.messages.find((m) => m.role === "agent")?.runId).toBe(sent.runId);
    // bob cannot read alice's run trace
    const stolen = await call("bob", `/api/runs/${sent.runId}/trace`, "GET");
    expect(stolen.status).toBe(404);
  });

  it("empty message → VALIDATION_ERROR; longer than 2000 chars → VALIDATION_ERROR", async () => {
    const created = (await call("alice", "/api/conversations", "POST")).body.data as { id: string };
    const empty = await call("alice", `/api/conversations/${created.id}/messages`, "POST", {
      text: "  ",
      clientMessageId: "cm-e1",
    });
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe("VALIDATION_ERROR");
    const long = await call("alice", `/api/conversations/${created.id}/messages`, "POST", {
      text: "x".repeat(2001),
      clientMessageId: "cm-e2",
    });
    expect(long.status).toBe(400);
  });

  it("a resent clientMessageId replays the stored reply and starts no new run", async () => {
    const created = (await call("alice", "/api/conversations", "POST")).body.data as { id: string };
    const first = await call("alice", `/api/conversations/${created.id}/messages`, "POST", {
      text: "hello there",
      clientMessageId: "cm-replay",
    });
    const runsBefore = (testDb.db.prepare("SELECT COUNT(*) c FROM run").get() as { c: number }).c;
    const replay = await call("alice", `/api/conversations/${created.id}/messages`, "POST", {
      text: "hello there",
      clientMessageId: "cm-replay",
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    const runsAfter = (testDb.db.prepare("SELECT COUNT(*) c FROM run").get() as { c: number }).c;
    expect(runsAfter).toBe(runsBefore);
  });

  it("a second message while a run is in progress → 409 CONVERSATION_BUSY", async () => {
    const created = (await call("alice", "/api/conversations", "POST")).body.data as { id: string };
    let release!: () => void;
    armBusyTest(new Promise<void>((resolve) => (release = resolve)));
    // the first run parks inside the gated model's read call
    const first = call("alice", `/api/conversations/${created.id}/messages`, "POST", {
      text: "first",
      clientMessageId: "cm-busy-1",
    });
    await new Promise((r) => setTimeout(r, 20)); // let the first run start and park in the model call
    const second = await call("alice", `/api/conversations/${created.id}/messages`, "POST", {
      text: "second",
      clientMessageId: "cm-busy-2",
    });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("CONVERSATION_BUSY");
    release();
    expect((await first).status).toBe(200);
    releaseBusyTest();
  });
});
