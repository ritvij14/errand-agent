import { createAuthRouter, COOKIE_NAME, readToken } from "./auth.routes.js";
import { verifySession, seedDemoUsers } from "./auth-core.js";
import type { Db } from "../shared/db.js";
import type { Clock } from "../shared/clock.js";
import type { Request } from "express";

// Public API of the auth feature. Other features never import auth-core or
// auth.routes directly — this is the boundary.

export const verifyUser = (db: Db, clock: Clock, req: Request): { userId: string; sessionId: string } | null => {
  const session = verifySession(db, clock, readToken(req));
  return session ? { userId: session.userId, sessionId: session.id } : null;
};

export { createAuthRouter, COOKIE_NAME, seedDemoUsers };