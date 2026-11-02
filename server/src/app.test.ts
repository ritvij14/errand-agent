import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createApp } from "./app.js";

let server: Server;
let baseUrl: string;

beforeAll(() => {
  server = createApp().listen(0);
  const address = server.address() as { port: number };
  baseUrl = `http://localhost:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("API scaffold", () => {
  it("responds 200 on /api/health", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({ status: "ok" });
  });

  it("needs deps to serve /api routes (no auth or conversations without a database)", async () => {
    const res = await fetch(`${baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });
});