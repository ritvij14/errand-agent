import request from "supertest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClock } from "../shared/clock.js";
import { createTestDb } from "../shared/test-db.js";
import { seedDemoUsers, createSession, COOKIE_NAME } from "../auth/index.js";
import { seedMockWorld } from "../tools/index.js";
import { scriptedModel } from "../agent/index.js";
import { createApp } from "../app.js";
import { createConversationService } from "../conversations/index.js";
import { exportTrace, writeTraceFile } from "./export.js";

// 2.5.9 viewing + export: a user loads only their own runs' traces (NOT_FOUND for
// another user's, V-7); the export writes the run's events and nothing else; no trace
// contains a password, session token or cookie (I-9).

const ALICE_ID = "u-demo-alice";
const BOB_ID = "u-demo-bob";
const CLOCK = () => createClock({ now: new Date("2026-11-02T03:45:00Z") });

describe("trace viewing and export (MH-7, FR-13, I-9)", () => {
  let testDb: ReturnType<typeof createTestDb>;
  let app: ReturnType<typeof createApp>;
  let runId: string;

  beforeEach(async () => {
    testDb = createTestDb();
    seedDemoUsers(testDb.db, CLOCK().now().getTime());
    seedMockWorld(testDb.db, { seed: "errand-agent-v1", clock: CLOCK() });
    app = createApp({ db: testDb.db, clock: CLOCK(), model: scriptedModel });
    const service = createConversationService({ db: testDb.db, clock: CLOCK(), model: scriptedModel });
    const c = service.createConversation(ALICE_ID).id;
    const reply = await service.sendMessage(ALICE_ID, c, "plumber in Indiranagar tomorrow, under 1000", "m1");
    if (!reply.ok) throw new Error(reply.code);
    runId = reply.reply.runId;
  });

  afterEach(() => testDb.close());

  it("GET /api/runs/:id/trace returns the run and its ordered events", async () => {
    const res = await request(app)
      .get(`/api/runs/${runId}/trace`)
      .set("Cookie", `${COOKIE_NAME}=${createSession(testDb.db, CLOCK(), ALICE_ID)}`)
      .set("Sec-Fetch-Site", "same-origin");
    expect(res.status).toBe(200);
    const data = res.body.data as {
      run: { id: string; outcome: string; modelCalls: number; toolCalls: number };
      events: { seq: number; type: string }[];
    };
    expect(data.run).toMatchObject({ id: runId, outcome: "completed" });
    expect(data.run.modelCalls).toBeGreaterThan(0);
    expect(data.events.length).toBeGreaterThan(3);
    expect(data.events.map((e) => e.seq)).toEqual(data.events.map((e) => e.seq).sort((a, b) => a - b));
    expect(data.events.some((e) => e.type === "tool_call")).toBe(true);
  });

  it("another user's run → NOT_FOUND, unchanged", async () => {
    const res = await request(app)
      .get(`/api/runs/${runId}/trace`)
      .set("Cookie", `${COOKIE_NAME}=${createSession(testDb.db, CLOCK(), BOB_ID)}`)
      .set("Sec-Fetch-Site", "same-origin");
    expect(res.status).toBe(404);
  });

  it("unauthenticated → 401", async () => {
    const res = await request(app).get(`/api/runs/${runId}/trace`).set("Sec-Fetch-Site", "same-origin");
    expect(res.status).toBe(401);
  });

  it("exportTrace returns the run and its events and nothing else; writeTraceFile writes them", () => {
    const exported = exportTrace(testDb.db, runId)!;
    expect(Object.keys(exported).sort()).toEqual(["events", "run"]);
    expect((exported.run as { id: string }).id).toBe(runId);
    const dir = mkdtempSync(join(tmpdir(), "trace-export-"));
    const file = writeTraceFile(dir, runId, exported);
    expect(existsSync(file)).toBe(true);
    const written = JSON.parse(readFileSync(file, "utf8")) as typeof exported;
    expect(written.events).toEqual(exported.events);
    expect(file.endsWith(`${runId}.json`)).toBe(true);
  });

  it("no trace anywhere holds a password, token or cookie (I-9)", async () => {
    void app;
    const rows = testDb.db.prepare(`SELECT type, data FROM trace_event`).all() as {
      type: string;
      data: string;
    }[];
    const all = JSON.stringify(rows).toLowerCase();
    expect(all).not.toContain("demo-password");
    expect(all).not.toContain("set-cookie");
    expect(all).not.toContain("authorization");
    // only the SHA-256 of the token secret is stored — the raw secret can never leak
    const session = testDb.db.prepare(`SELECT id, secret_hash FROM auth_session LIMIT 1`).get() as
      { id: string; secret_hash: Buffer } | undefined;
    if (session) {
      expect(all).not.toContain(session.id);
      expect(all).not.toContain(Buffer.from(session.secret_hash).toString("hex"));
    }
  });
});
