import { Router, type Request, type Response, type NextFunction } from "express";
import { sendError } from "../shared/errors.js";
import type { Db } from "../shared/db.js";
import type { Clock } from "../shared/clock.js";
import type { AgentModel } from "../agent/index.js";
import { verifyUser } from "../auth/index.js";
import {
  createConversationService,
  type ConversationFailure,
  type ConversationsDeps,
} from "./conversations.service.js";

export type ConversationsRouterDeps = {
  db: Db;
  clock: Clock;
  model: AgentModel;
  mock?: ConversationsDeps["mock"];
};

// Route codes → HTTP status via the shared catalogue (§ 2.5.3).
const STATUS: Record<string, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  CSRF_REJECTED: 403,
  NOT_FOUND: 404,
  USERNAME_TAKEN: 409,
  NO_SUCH_USERNAME: 401,
  WRONG_PASSWORD: 401,
  RATE_LIMITED: 429,
  CONVERSATION_BUSY: 409,
};

type UserRequest = Request & { user?: { userId: string } };

const userIdOf = (req: Request): string | undefined => (req as UserRequest).user?.userId;

const fail = (res: Response, failure: ConversationFailure): Response => {
  const status = STATUS[failure.code] ?? 400;
  res.status(status).json({ error: failure.message, code: failure.code });
  return res;
};

export const createConversationsRouter = (deps: ConversationsRouterDeps): Router => {
  const router = Router();
  const service = createConversationService(deps);

  const requireUser = (req: Request, res: Response, next: NextFunction): void => {
    const session = verifyUser(deps.db, deps.clock, req);
    if (!session) {
      sendError(res, "UNAUTHENTICATED", "Sign in first");
      return;
    }
    (req as Request & { user?: { userId: string } }).user = { userId: session.userId };
    next();
  };

  router.use(requireUser);

  router.post("/conversations", (req, res, next) => {
    try {
      const conversation = service.createConversation(userIdOf(req)!);
      res.status(201).json({
        data: {
          id: conversation.id,
          title: conversation.title,
          createdAt: conversation.created_at,
          updatedAt: conversation.updated_at,
          busy: false,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/conversations", (req, res, next) => {
    try {
      res.status(200).json({ data: service.listConversations(userIdOf(req)!) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/conversations/:id", (req, res, next) => {
    try {
      const result = service.readConversation(userIdOf(req)!, req.params.id!);
      if ("code" in result) return fail(res, result);
      res.status(200).json({
        data: {
          conversation: result.conversation,
          messages: result.messages,
          busy: result.busy,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/conversations/:id/messages", async (req, res, next) => {
    try {
      const result = await service.sendMessage(
        userIdOf(req)!,
        req.params.id!,
        req.body?.text as string | undefined,
        req.body?.clientMessageId as string | undefined,
        typeof req.body?.approvalId === "string" ? req.body.approvalId : undefined,
        typeof req.body?.memoryFactId === "string" ? req.body.memoryFactId : undefined,
      );
      if (!result.ok) return fail(res, result);
      res.status(200).json({ data: result.reply });
    } catch (err) {
      next(err);
    }
  });

  // Approve / Decline buttons (§ 2.5.5) — a run in the approval's conversation
  router.post("/approvals/:id/decision", async (req, res, next) => {
    try {
      const result = await service.decideApproval(userIdOf(req)!, req.params.id!, req.body?.decision);
      if (!result.ok) return fail(res, result);
      res.status(200).json({ data: result.reply });
    } catch (err) {
      next(err);
    }
  });

  router.get("/runs/:id/trace", (req, res, next) => {
    try {
      const result = service.runTrace(userIdOf(req)!, req.params.id!);
      if ("code" in result) return fail(res, result);
      res.status(200).json({ data: result });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
