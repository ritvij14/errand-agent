import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { Server } from "node:http";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createApp().listen(0);
  const address = server.address() as { port: number };
  baseUrl = `http://localhost:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function post(path: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("API scaffold", () => {
  it("responds 200 on /api/health", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({ status: "ok" });
  });

  it("echoes a chat message and returns a session id", async () => {
    const res = await post("/api/chat", { message: "Find a plumber for my kitchen tap" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; messages: unknown[] };
    expect(body.sessionId).toMatch(/[0-9a-f-]{36}/);
    expect(body.messages).toHaveLength(1);
  });

  it("returns 400 when message is missing", async () => {
    const res = await post("/api/chat", {});
    expect(res.status).toBe(400);
  });

  it("returns 400 when message is blank", async () => {
    const res = await post("/api/chat", { message: "   " });
    expect(res.status).toBe(400);
  });
});
