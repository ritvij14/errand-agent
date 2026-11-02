import { Router, type Request, type Response, type NextFunction } from "express";
import { sendError } from "../shared/errors.js";
import type { Db } from "../shared/db.js";
import type { Clock } from "../shared/clock.js";
import { verifyUser } from "../auth/index.js";
import * as memory from "./index.js";

export type MemoryRouterDeps = { db: Db; clock: Clock };

const userIdOf = (deps: MemoryRouterDeps, req: Request): string | undefined =>
  verifyUser(deps.db, deps.clock, req)?.userId;

// FR-12 + 2.5.8: the panel's endpoints — the same memory code chat uses. Panel actions
// change memory directly; they are not runs. Value shapes per key are checked here
// (areas enum, HH:MM, provider id) so the panel can't store junk.
const validateValue = (key: string, value: unknown): boolean => {
  if (typeof value !== "string" || value.length > 100 || value.length === 0) return false;
  if (key === "area")
    return ["indiranagar", "koramangala", "hsr_layout", "jayanagar", "whitefield"].includes(value);
  if (key === "earliest_time") return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  if (key === "preferred_provider") return /^mp-\d{3}$/.test(value);
  return false;
};

export const createMemoryRouter = (deps: MemoryRouterDeps): Router => {
  const router = Router();

  router.use("/memory", (req: Request, res: Response, next: NextFunction): void => {
    if (!userIdOf(deps, req)) return void sendError(res, "UNAUTHENTICATED", "Sign in first");
    next();
  });

  const factOf = (req: Request): memory.MemoryFactRecord | undefined =>
    memory.byId(deps.db, userIdOf(deps, req)!, String(req.params.id));

  router.get("/memory", (req, res) => {
    const facts = memory.view(deps.db, userIdOf(deps, req)!);
    return void res.json({
      data: facts.map((f) => ({
        id: f.id,
        key: f.key,
        service: f.service,
        value: f.value,
        source: f.source,
        status: f.status,
        evidence: f.evidence,
        updatedAt: f.updatedAt,
      })),
    });
  });

  router.put("/memory/:id", (req: Request, res: Response) => {
    const fact = factOf(req);
    if (!fact) return void sendError(res, "NOT_FOUND", "No such memory fact");
    if (!validateValue(fact.key, (req.body as { value?: unknown }).value))
      return void sendError(res, "VALIDATION_ERROR", `The value doesn't fit ${fact.key}`);
    const updated = memory.saveStated(
      deps.db,
      deps.clock,
      userIdOf(deps, req)!,
      fact.key,
      (req.body as { value: string }).value,
      fact.service ?? undefined,
    );
    return void res.json({ data: updated });
  });

  const decide =
    (action: "confirm" | "reject") =>
    (req: Request, res: Response): void => {
      const fact = factOf(req);
      if (!fact || fact.status !== "awaiting_confirmation")
        return void sendError(res, "NOT_FOUND", "No memory fact waiting for confirmation");
      const updated =
        action === "confirm"
          ? memory.confirm(deps.db, deps.clock, userIdOf(deps, req)!, fact.id)
          : memory.reject(deps.db, deps.clock, userIdOf(deps, req)!, fact.id);
      return void res.json({ data: updated });
    };
  router.post("/memory/:id/confirm", decide("confirm"));
  router.post("/memory/:id/reject", decide("reject"));

  router.delete("/memory/:id", (req: Request, res: Response) => {
    const fact = factOf(req);
    if (!fact) return void sendError(res, "NOT_FOUND", "No such memory fact");
    memory.forget(deps.db, deps.clock, userIdOf(deps, req)!, fact.key, fact.service ?? undefined);
    return void res.json({ data: { id: fact.id, forgotten: true } });
  });

  return router;
};
