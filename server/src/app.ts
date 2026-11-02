import express from "express";
import type { NextFunction, Request, Response } from "express";
import type { Db } from "./shared/db.js";
import type { Clock } from "./shared/clock.js";
import type { AgentModel } from "./agent/index.js";
import { sendError, sendUnknownError } from "./shared/errors.js";
import { createAuthRouter, verifyUser } from "./auth/index.js";
import { createConversationsRouter } from "./conversations/index.js";
import { createMemoryRouter } from "./memory/index.js";

export type AppDeps = { db: Db; clock: Clock; model: AgentModel };

// CSRF (§ 2.5.1): every mutating request must carry Sec-Fetch-Site: same-origin and
// a JSON content type; GETs skip the check. Checked before body parsing so a bad
// content type is refused 403, not a parse error.
const csrfGuard = (req: Request, res: Response, next: NextFunction): void => {
  if (req.method === "GET") return next();
  const site = req.headers["sec-fetch-site"];
  const type = (req.headers["content-type"] ?? "").split(";")[0];
  if (site !== "same-origin") return sendError(res, "CSRF_REJECTED", "Missing or wrong Sec-Fetch-Site header");
  if (type !== "application/json") return sendError(res, "CSRF_REJECTED", "Content-Type must be application/json");
  return next();
};

// The app requires its deps in tests and start alike; the health check is the one
// dep-free route. Tests that need no conversations mount nothing but health.
export function createApp(deps: Partial<AppDeps> = {}) {
  const app = express();

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  if (deps.db && deps.clock && deps.model) {
    app.use(csrfGuard);
    app.use(express.json({ type: () => true }));
    app.use("/api", createAuthRouter({ db: deps.db, clock: deps.clock }));
    app.use("/api", createConversationsRouter({ db: deps.db, clock: deps.clock, model: deps.model }));
    app.use("/api", createMemoryRouter({ db: deps.db, clock: deps.clock }));
    // anything that mutates should know who is calling — future routers check verifyUser(deps.db, deps.clock, req)
    void verifyUser;

    // Last-resort handler: known errors keep their code; anything uncaught returns
    // the catalogue's unknown_error shape, never a stack trace.
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      void _next;
      if (err && typeof err === "object" && "code" in err) {
        const known = err as { code: string; message: string; status?: number };
        return void res.status(known.status ?? 400).json({ error: known.message, code: known.code });
      }
      if (err instanceof SyntaxError || (err && typeof err === "object" && (err as { type?: string }).type === "entity.parse.failed")) {
        return sendError(res, "VALIDATION_ERROR", "Request body must be valid JSON");
      }
      console.error(err);
      sendUnknownError(res);
    });
  }

  return app;
}