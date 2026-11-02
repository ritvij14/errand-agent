import { randomUUID } from "node:crypto";
import type { Db } from "../shared/db.js";
import type { Clock } from "../shared/clock.js";
import { approvalRepo } from "../approval/index.js";
import { operationRepo, type OperationRecord } from "./operation.repo.js";

// The two gates (§ 2.5.5 "The check", R1). A bug in one place can't book without
// approval: Gate 1 needs an approved-and-unused approval to create an operation;
// Gate 2 needs a persisted in-flight operation (with a used approval) to call a tool.

export type BookRequest = { providerId: string; slot: string; price: number; holdId: string };

/**
 * Gate 1: in ONE transaction — check the approval is `approved` and equals the request,
 * mark it `used`, create the operation (`in_flight`, key `<op id>:1`), and run
 * `alsoInTransaction` (the workflow moving to `executing`).
 */
export const startBookOperation = (
  db: Db,
  clock: Clock,
  approvalId: string,
  request: BookRequest,
  alsoInTransaction?: () => void,
): { ok: true; operation: OperationRecord } | { ok: false; reason: string } =>
  db.transaction(() => {
    const approval = approvalRepo(db).getById(approvalId);
    if (!approval || approval.status !== "approved" || approval.action !== "book")
      return { ok: false as const, reason: "approval not approved" };
    const matches =
      approval.provider_id === request.providerId &&
      approval.slot === request.slot &&
      approval.price === request.price &&
      approval.hold_id === request.holdId;
    if (!matches) return { ok: false as const, reason: "request differs from what was approved" };
    const now = clock.now().getTime();
    if (!approvalRepo(db).markUsed(approvalId, now))
      return { ok: false as const, reason: "approval already used" };
    const id = randomUUID();
    const operation = operationRepo(db).insert(
      {
        id,
        kind: "book",
        user_id: approval.user_id,
        conversation_id: approval.conversation_id,
        workflow_id: approval.workflow_id,
        approval_id: approvalId,
        idempotency_key: `${id}:1`,
        request: JSON.stringify({ holdId: request.holdId }), // exactly what `book` is sent
      },
      now,
    );
    alsoInTransaction?.();
    return { ok: true as const, operation };
  })();

/**
 * Gate 2, handed to the tool gateway: `book` runs only for this user's persisted
 * in-flight operation, whose approval is `used`, with the operation's own request.
 */
export const authorizeWrite =
  (db: Db, userId: string) =>
  (tool: string, args: Record<string, unknown>): boolean => {
    if (tool !== "book") return false; // cancel / reschedule get their own checks with their units
    const op = operationRepo(db).byKey(String(args.idempotencyKey));
    if (!op || op.user_id !== userId || op.kind !== "book" || op.status !== "in_flight") return false;
    if (approvalRepo(db).getById(op.approval_id)?.status !== "used") return false;
    return (JSON.parse(op.request) as { holdId: string }).holdId === args.holdId;
  };
