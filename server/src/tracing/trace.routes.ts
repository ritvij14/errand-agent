import { Router, type Request, type Response, type NextFunction } from "express";
import { sendError } from "../shared/errors.js";
import type { Db } from "../shared/db.js";
import type { Clock } from "../shared/clock.js";
import { verifyUser } from "../auth/index.js";
import { exportTrace } from "./export.js";

export type TraceRouterDeps = { db: Db; clock: Clock };

const userIdOf = (deps: TraceRouterDeps, req: Request): string | undefined =>
  verifyUser(deps.db, deps.clock, req)?.userId;

// 2.5.9 viewing: after each reply the page loads that run's trace (FR-13). A user can
// only load traces of their own conversations — the run row's user decides (V-7).
export const createTraceRouter = (deps: TraceRouterDeps): Router => {
  const router = Router();

  router.use("/runs", (req: Request, res: Response, next: NextFunction): void => {
    if (!userIdOf(deps, req)) return void sendError(res, "UNAUTHENTICATED", "Sign in first");
    next();
  });

  router.get("/runs/:id/trace", (req: Request, res: Response): void => {
    const userId = userIdOf(deps, req)!;
    const own = deps.db
      .prepare(
        `SELECT 1 FROM run r JOIN conversation c ON c.id = r.conversation_id WHERE r.id = ? AND c.user_id = ?`,
      )
      .get(String(req.params.id), userId);
    if (!own) return void sendError(res, "NOT_FOUND", "No such run");
    const trace = exportTrace(deps.db, String(req.params.id));
    if (!trace) return void sendError(res, "NOT_FOUND", "No such run");
    return void res.json({ data: trace });
  });

  return router;
};
