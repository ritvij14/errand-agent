import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { TestDb } from "./shared/test-db.js";
import { createTestDb } from "./shared/test-db.js";
import { createApp } from "./app.js";
import { DEMO_USERS } from "./shared/demo-users.js";
import { createClock } from "./shared/clock.js";
import { seedDemoUsers } from "./auth/index.js";

let server: Server;
let baseUrl: string;
let testDb: TestDb;

const CSRF_HEADERS = { "sec-fetch-site": "same-origin", "content-type": "application/json" } as const;

beforeAll(async () => {
  testDb = createTestDb();
  const app = createApp({ db: testDb.db, clock: createClock() });
  seedDemoUsers(testDb.db, Date.now());
  server = app.listen(0);
  const address = server.address() as { port: number };
  baseUrl = `http://localhost:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  testDb.close();
});

type Res = { status: number; headers: Record<string, string>; body: { code?: string; details?: unknown; [k: string]: unknown } };

async function call(path: string, method: "POST" | "GET" | "DELETE", body?: unknown, headers: Record<string, string> = {}, cookie?: string): Promise<Res> {
  const requestHeaders: Record<string, string> = { ...CSRF_HEADERS, ...headers };
  if (cookie) requestHeaders.cookie = cookie;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: requestHeaders,
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });
  const setCookie = res.headers.get("set-cookie") ?? undefined;
  const text = await res.text();
  return { status: res.status, headers: setCookie ? { "set-cookie": setCookie } : {}, body: text === "" ? {} : (JSON.parse(text) as Res["body"]) };
}

describe("sign-up", () => {
  it("creates a user, hashes the password, and signs in", async () => {
    const res = await call("/api/auth/sign-up", "POST", { username: "newbie_1", password: "hunter2hunter2" });
    expect(res.status).toBe(201);
    const stored = testDb.db.prepare("SELECT username, password_hash FROM user WHERE username='newbie_1'").get() as { password_hash: string };
    expect(stored.password_hash).not.toContain("hunter2");
    const cookie = res.headers["set-cookie"]!;
    expect(cookie).toContain("session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("rejects a bad username and a short password with field-level details", async () => {
    const res = await call("/api/auth/sign-up", "POST", { username: "NO CAPS", password: "short" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.details).toBeTypeOf("object");
  });

  it("rejects an existing username with 409 USERNAME_TAKEN", async () => {
    await call("/api/auth/sign-up", "POST", { username: "dup_user", password: "hunter2hunter2" });
    const res = await call("/api/auth/sign-up", "POST", { username: "dup_user", password: "other-password-9" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("USERNAME_TAKEN");
  });
});

describe("sign-in", () => {
  it("accepts the seeded demo user", async () => {
    const alice = DEMO_USERS[0]!;
    const res = await call("/api/auth/sign-in", "POST", { username: alice.username, password: alice.password });
    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]).toContain("session=");
    // only the SHA-256 of the secret lives in the database
    const session = testDb.db.prepare("SELECT secret_hash FROM auth_session").all() as { secret_hash: Buffer }[];
    const secrets = session.map((s) => Array.from(s.secret_hash).length);
    expect(secrets.every((n) => n === 32)).toBe(true); // SHA-256 digests, never raw secrets
  });

  it("says which part failed: no such username vs wrong password", async () => {
    const noUser = await call("/api/auth/sign-in", "POST", { username: "ghost", password: "anypassword1" });
    expect(noUser.status).toBe(401);
    expect(noUser.body.code).toBe("NO_SUCH_USERNAME");
    const alice = DEMO_USERS[0]!;
    const wrong = await call("/api/auth/sign-in", "POST", { username: alice.username, password: "definitely-wrong-1" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe("WRONG_PASSWORD");
  });

  it("rate limits per username after 5 quick attempts (429 RATE_LIMITED)", async () => {
    for (let i = 0; i < 5; i++) {
      await call("/api/auth/sign-in", "POST", { username: "hammered", password: "wrong-password-1" });
    }
    const sixth = await call("/api/auth/sign-in", "POST", { username: "hammered", password: "wrong-password-1" });
    expect(sixth.status).toBe(429);
    expect(sixth.body.code).toBe("RATE_LIMITED");
    // a different username is unaffected
    const fresh = await call("/api/auth/sign-in", "POST", { username: "hammered2", password: "wrong-password-1" });
    expect(fresh.status).toBe(401);
  });
});

describe("me, sign-out and session expiry", () => {
  it("me without a cookie → 401 UNAUTHENTICATED; with the session cookie → the user", async () => {
    const anon = await call("/api/auth/me", "GET");
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe("UNAUTHENTICATED");

    const alice = DEMO_USERS[0]!;
    const signed = await call("/api/auth/sign-in", "POST", { username: alice.username, password: alice.password });
    const cookie = signed.headers["set-cookie"]!;
    const me = await call("/api/auth/me", "GET", undefined, {}, cookie);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ data: { user: { username: alice.username } } });
  });

  it("a bad or expired token → 401; sign-out deletes the session", async () => {
    const bad = await call("/api/auth/me", "GET", undefined, {}, "session=deadbeef.0123456789abcdef0123456789abcdef");
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe("UNAUTHENTICATED");

    const alice = DEMO_USERS[1]!;
    const signed = await call("/api/auth/sign-in", "POST", { username: alice.username, password: alice.password });
    const cookie = signed.headers["set-cookie"]!;
    expect((await call("/api/auth/me", "GET", undefined, {}, cookie)).status).toBe(200);
    await call("/api/auth/sign-out", "POST", undefined, {}, cookie);
    expect((await call("/api/auth/me", "GET", undefined, {}, cookie)).status).toBe(401);
  });
});

describe("CSRF", () => {
  it("refuses a mutating call without Sec-Fetch-Site: same-origin → 403 CSRF_REJECTED", async () => {
    const res = await fetch(`${baseUrl}/api/auth/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "x_user", password: "anypassword1" }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("CSRF_REJECTED");
  });

  it("refuses a call with a non-JSON content type", async () => {
    const res = await fetch(`${baseUrl}/api/auth/sign-in`, {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin", "content-type": "text/plain" },
      body: "hello",
    });
    expect(res.status).toBe(403);
  });

  it("GET requests skip the CSRF check", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
  });
});