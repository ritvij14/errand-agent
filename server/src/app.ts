import express from "express";
import type { NextFunction, Request, Response } from "express";
import type { Db } from "./shared/db.js";
import type { Clock } from "./shared/clock.js";
import { sendError, sendUnknownError } from "./shared/errors.js";
import { createAuthRouter, verifyUser } from "./auth/index.js";
import { chatRouter } from "./chat/chat.routes.js";

export type AppDeps = { db: Db; clock: Clock };

// CSRF (§ 2.5.1): every mutating request must carry Sec-Fetch-Site: same-origin and
// a JSON content type; GETs skip the check.
const csrfGuard = (req: Request, res: Response, next: NextFunction): void => {
  if (req.method === "GET") return next();
  const site = req.headers["sec-fetch-site"];
  const type = (req.headers["content-type"] ?? "").split(";")[0];
  if (site !== "same-origin") return sendError(res, "CSRF_REJECTED", "Missing or wrong Sec-Fetch-Site header");
  if (type !== "application/json") return sendError(res, "CSRF_REJECTED", "Content-Type must be application/json");
  return next();
};

export function createApp(deps?: Partial<AppDeps>) {
  const app = express();
  // CSRF sits before body parsing: a non-JSON content type is refused 403, not a parse error
  app.use(csrfGuard);
  app.use(express.json({ type: () => true }));

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  if (deps?.db) {
    app.use("/api", createAuthRouter({ db: deps.db, clock: deps.clock! }));
  }
  app.use("/api", chatRouter);
  // anything that mutates should know who is calling — future routers check verifyUser(deps.db, deps.clock, req)
  void verifyUser;

  // Unknown route / last-resort handler: known errors keep their code, anything
  // uncaught returns the catalogue's unknown_error shape, never a stack trace.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    void _next;
    if (err && typeof err === "object" && "code" in err) {
      const known = err as { code: string; message: string };
      const status = (known as { status?: number }).status ?? 400;
      return void res.status(status).json({ error: known.message, code: known.code });
    }
    if (err instanceof SyntaxError || (err && typeof err === "object" && "type" in err && (err as { type?: string }).type === "entity.parse.failed")) {
      return sendError(res, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    console.error(err);
    sendUnknownError(res);
  });

  return app;
}