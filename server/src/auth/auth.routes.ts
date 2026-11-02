import { randomUUID } from "node:crypto";
import { Router, type CookieOptions, type Request } from "express";
import type { Db } from "../shared/db.js";
import type { Clock } from "../shared/clock.js";
import { sendError } from "../shared/errors.js";
import { checkPasswordRules, hashPassword, verifyPassword, createSession, deleteSession, verifySession, allowSignInAttempt } from "./auth-core.js";

export type AuthDeps = { db: Db; clock: Clock };

export const COOKIE_NAME = "session";
const COOKIE_OPTS: CookieOptions = { httpOnly: true, sameSite: "lax", path: "/", maxAge: 10 * 24 * 60 * 60 * 1000 };

export const readToken = (req: Request): string | undefined =>
  (req.headers.cookie ?? "")
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1);

const USERNAME_RE = /^[a-z0-9_]{3,32}$/;

const validate = (
  body: unknown,
): { username?: string; password?: string; problems?: Record<string, string> } => {
  const { username, password } = (body ?? {}) as { username?: unknown; password?: unknown };
  const problems: Record<string, string> = {};
  if (typeof username !== "string" || !USERNAME_RE.test(username)) problems.username = "3–32 characters: lowercase letters, digits, _";
  if (typeof password !== "string") problems.password = "required";
  else {
    const check = checkPasswordRules(password);
    if (!check.ok) problems.password = check.reason;
  }
  return Object.keys(problems).length > 0 ? { problems } : { username: username as string, password: password as string };
};

export const createAuthRouter = (deps: AuthDeps): Router => {
  const router = Router();
  const { db, clock } = deps;

  router.post("/auth/sign-up", (req, res, next) => {
    try {
      const v = validate(req.body);
      if (v.problems) return sendError(res, "VALIDATION_ERROR", "Sign-up details are invalid", v.problems);
      if (db.prepare(`SELECT 1 FROM user WHERE username = ?`).get(v.username!)) {
        return sendError(res, "USERNAME_TAKEN", "That username is already taken");
      }
      const userId = randomUUID();
      db.prepare(`INSERT INTO user (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)`).run(
        userId,
        v.username!,
        hashPassword(v.password!),
        clock.now().getTime(),
      );
      const token = createSession(db, clock, userId);
      res.cookie(COOKIE_NAME, token, COOKIE_OPTS).status(201).json({ data: { user: { id: userId, username: v.username } } });
    } catch (err) {
      next(err);
    }
  });

  router.post("/auth/sign-in", (req, res, next) => {
    try {
      const v = validate(req.body);
      if (v.problems) return sendError(res, "VALIDATION_ERROR", "Sign-in details are invalid", v.problems);
      if (!allowSignInAttempt(clock, v.username!)) {
        return sendError(res, "RATE_LIMITED", "Too many sign-in attempts — wait a minute");
      }
      const user = db.prepare(`SELECT id, password_hash FROM user WHERE username = ?`).get(v.username!) as
        | { id: string; password_hash: string }
        | undefined;
      if (!user) return sendError(res, "NO_SUCH_USERNAME", "No such username");
      if (!verifyPassword(user.password_hash, v.password!)) return sendError(res, "WRONG_PASSWORD", "Wrong password");
      const token = createSession(db, clock, user.id);
      res.cookie(COOKIE_NAME, token, COOKIE_OPTS).status(200).json({ data: { user: { id: user.id, username: v.username! } } });
    } catch (err) {
      next(err);
    }
  });

  router.post("/auth/sign-out", (req, res, next) => {
    try {
      deleteSession(db, readToken(req));
      res.clearCookie(COOKIE_NAME, { path: "/" }).status(204).send();
    } catch (err) {
      next(err);
    }
  });

  router.get("/auth/me", (req, res, next) => {
    try {
      const session = verifySession(db, clock, readToken(req));
      if (!session) return sendError(res, "UNAUTHENTICATED", "Sign in first");
      const user = db.prepare(`SELECT id, username FROM user WHERE id = ?`).get(session.userId) as { id: string; username: string };
      res.status(200).json({ data: { user } });
    } catch (err) {
      next(err);
    }
  });

  return router;
};