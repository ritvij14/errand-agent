import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClock } from "../shared/clock.js";
import { createTestDb } from "../shared/test-db.js";
import { seedDemoUsers, createSession, COOKIE_NAME } from "../auth/index.js";
import { seedMockWorld } from "../tools/index.js";
import { scriptedModel } from "../agent/index.js";
import { createApp } from "../app.js";
import * as memory from "./index.js";

// FR-12 + 2.5.8: the panel endpoints call the same memory code as chat. Panel actions
// change memory directly — they are not runs. Demo users have fixed ids (V-7).

const ALICE = "alice";
const ALICE_ID = "u-demo-alice";
const BOB_ID = "u-demo-bob";
const CLOCK = () => createClock({ now: new Date("2026-11-02T03:45:00Z") });

describe("the memory endpoints", () => {
  let testDb: ReturnType<typeof createTestDb>;
  let app: ReturnType<typeof createApp>;
  let aliceCookie: string;
  const signIn = (username: string): string => {
    // direct session creation: the sign-in rate limiter is a shared module map, and a
    // test file full of HTTP sign-ins trips it before the endpoint tests run
    const userId = username === ALICE ? ALICE_ID : BOB_ID;
    return `${COOKIE_NAME}=${createSession(testDb.db, CLOCK(), userId)}`;
  };

  beforeEach(async () => {
    testDb = createTestDb();
    seedDemoUsers(testDb.db, CLOCK().now().getTime());
    seedMockWorld(testDb.db, { seed: "errand-agent-v1", clock: CLOCK() });
    app = createApp({ db: testDb.db, clock: CLOCK(), model: scriptedModel });
    aliceCookie = signIn(ALICE);
  });

  afterEach(() => testDb.close());

  const get = (cookie: string) =>
    request(app).get("/api/memory").set("Cookie", cookie).set("Sec-Fetch-Site", "same-origin");
  const call = (method: "put" | "post" | "delete", cookie: string, path: string, body?: object) =>
    request(app)
      [method](path)
      .set("Cookie", cookie)
      .set("Sec-Fetch-Site", "same-origin")
      .send(body ?? {});

  it("GET lists the signed-in user's active and awaiting facts with labels (V-7)", async () => {
    memory.saveStated(testDb.db, CLOCK(), ALICE_ID, "area", "hsr_layout");
    memory.inferCandidate(
      testDb.db,
      CLOCK(),
      ALICE_ID,
      "preferred_provider",
      "mp-002",
      "electrician",
      "booked twice",
    );
    memory.saveStated(testDb.db, CLOCK(), BOB_ID, "area", "whitefield");
    const res = await get(aliceCookie);
    expect(res.status).toBe(200);
    const facts = res.body.data as {
      key: string;
      value: string;
      source: string;
      status: string;
      updatedAt: number;
    }[];
    expect(facts).toHaveLength(2);
    expect(facts.map((f) => f.key)).toEqual(["area", "preferred_provider"]);
    expect(facts[0]).toMatchObject({ value: "hsr_layout", source: "stated", status: "active" });
    expect(facts[1]).toMatchObject({ source: "inferred", status: "awaiting_confirmation" });
    expect(facts.every((f) => f.value !== "whitefield")).toBe(true);
    expect(facts.every((f) => typeof f.updatedAt === "number")).toBe(true);
  });

  it("unauthenticated → 401", async () => {
    expect((await get("not-a-cookie")).status).toBe(401);
  });

  it("PUT corrects a fact: value replaced, source becomes stated", async () => {
    const fact = memory.saveStated(testDb.db, CLOCK(), ALICE_ID, "area", "hsr_layout")!;
    const res = await call("put", aliceCookie, `/api/memory/${fact.id}`, { value: "koramangala" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: fact.id,
      value: "koramangala",
      source: "stated",
      status: "active",
    });
    expect(memory.state(testDb.db, ALICE_ID, "area")).toMatchObject({ value: "koramangala" });
  });

  it("PUT validation: a bad area, a bad time and a missing value → VALIDATION_ERROR", async () => {
    const area = memory.saveStated(testDb.db, CLOCK(), ALICE_ID, "area", "hsr_layout")!;
    const time = memory.saveStated(testDb.db, CLOCK(), ALICE_ID, "earliest_time", "10:00")!;
    expect((await call("put", aliceCookie, `/api/memory/${area.id}`, { value: "mars" })).status).toBe(400);
    expect((await call("put", aliceCookie, `/api/memory/${time.id}`, { value: "25:99" })).status).toBe(400);
    expect((await call("put", aliceCookie, `/api/memory/${time.id}`, {})).status).toBe(400);
  });

  it("PUT / confirm / reject / DELETE on another user's fact → NOT_FOUND; nothing changes", async () => {
    const fact = memory.saveStated(testDb.db, CLOCK(), BOB_ID, "area", "whitefield")!;
    expect((await call("put", aliceCookie, `/api/memory/${fact.id}`, { value: "indiranagar" })).status).toBe(
      404,
    );
    expect((await call("post", aliceCookie, `/api/memory/${fact.id}/confirm`)).status).toBe(404);
    expect((await call("post", aliceCookie, `/api/memory/${fact.id}/reject`)).status).toBe(404);
    expect((await call("delete", aliceCookie, `/api/memory/${fact.id}`, {})).status).toBe(404);
    expect(memory.state(testDb.db, BOB_ID, "area")).toMatchObject({ value: "whitefield" });
  });

  it("confirm and reject an awaiting inferred fact", async () => {
    const first = memory.inferCandidate(
      testDb.db,
      CLOCK(),
      ALICE_ID,
      "preferred_provider",
      "mp-002",
      "electrician",
      "booked twice",
    ).fact!;
    expect((await call("post", aliceCookie, `/api/memory/${first.id}/confirm`)).body.data).toMatchObject({
      status: "active",
      source: "inferred",
    });
    const second = memory.inferCandidate(
      testDb.db,
      CLOCK(),
      ALICE_ID,
      "area",
      "jayanagar",
      null,
      "booked in Jayanagar twice",
    ).fact!;
    expect((await call("post", aliceCookie, `/api/memory/${second.id}/reject`)).body.data).toMatchObject({
      status: "forgotten",
    });
    expect(memory.blockedByForget(testDb.db, ALICE_ID, "area", "jayanagar")).toBe(true);
  });

  it("DELETE forgets: gone from the view, the row stays as a marker", async () => {
    const fact = memory.saveStated(testDb.db, CLOCK(), ALICE_ID, "area", "hsr_layout")!;
    const res = await call("delete", aliceCookie, `/api/memory/${fact.id}`, {});
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: fact.id, forgotten: true });
    expect((await get(aliceCookie)).body.data).toHaveLength(0);
    expect(
      (testDb.db.prepare(`SELECT status FROM memory_fact WHERE id = ?`).get(fact.id) as { status: string })
        .status,
    ).toBe("forgotten");
  });
});
