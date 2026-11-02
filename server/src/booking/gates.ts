import { randomUUID } from "node:crypto";
import type { Db } from "../shared/db.js";
import type { Clock } from "../shared/clock.js";
import { approvalRepo, type ApprovalRecord } from "../approval/index.js";
import { operationRepo, type OperationRecord } from "./operation.repo.js";

// The two gates (§ 2.5.5 "The check", R1). A bug in one place can't book without
// approval: Gate 1 needs an approved-and-unused approval to create an operation;
// Gate 2 needs a persisted in-flight operation (with a used approval) to call a tool.

export type BookRequest = { providerId: string; slot: string; price: number; holdId: string };

type GateResult = { ok: true; operation: OperationRecord } | { ok: false; reason: string };

/**
 * Gate 1: in ONE transaction — check the approval is `approved`, for this action, and
 * equals the request; mark it `used`; create the operation (`in_flight`, key
 * `<op id>:1`); and run `alsoInTransaction` (the workflow moving to `executing`).
 * Any failure rolls all of it back.
 */
const startOperation = (
  db: Db,
  clock: Clock,
  approvalId: string,
  kind: "book" | "cancel",
  matches: (approval: ApprovalRecord) => boolean,
  sent: Record<string, unknown>, // exactly what the tool is sent
  bookingId: string | null,
  alsoInTransaction?: () => void,
): GateResult => {
  try {
    return db.transaction((): GateResult => {
      const approval = approvalRepo(db).getById(approvalId);
      if (!approval || approval.status !== "approved" || approval.action !== kind)
        return { ok: false, reason: "approval not approved" };
      if (!matches(approval)) return { ok: false, reason: "request differs from what was approved" };
      const now = clock.now().getTime();
      if (!approvalRepo(db).markUsed(approvalId, now)) return { ok: false, reason: "approval already used" };
      const id = randomUUID();
      const operation = operationRepo(db).insert(
        {
          id,
          kind,
          user_id: approval.user_id,
          conversation_id: approval.conversation_id,
          workflow_id: approval.workflow_id,
          approval_id: approvalId,
          idempotency_key: `${id}:1`,
          request: JSON.stringify(sent),
          booking_id: bookingId,
        },
        now,
      );
      alsoInTransaction?.();
      return { ok: true, operation };
    })();
  } catch (error) {
    // R3: the database allows one in-flight operation per booking
    if (String(error).includes("operation.booking_id"))
      return { ok: false, reason: "another change to this booking is in progress" };
    throw error;
  }
};

export const startBookOperation = (
  db: Db,
  clock: Clock,
  approvalId: string,
  request: BookRequest,
  alsoInTransaction?: () => void,
): GateResult =>
  startOperation(
    db,
    clock,
    approvalId,
    "book",
    (a) =>
      a.provider_id === request.providerId &&
      a.slot === request.slot &&
      a.price === request.price &&
      a.hold_id === request.holdId,
    { holdId: request.holdId },
    null,
    alsoInTransaction,
  );

/** Gate 1 for a cancel: the approval names this booking (R3 re-check happens before, via list_bookings). */
export const startCancelOperation = (
  db: Db,
  clock: Clock,
  approvalId: string,
  request: { bookingId: string },
  alsoInTransaction?: () => void,
): GateResult =>
  startOperation(
    db,
    clock,
    approvalId,
    "cancel",
    (a) => a.booking_id === request.bookingId,
    { bookingId: request.bookingId },
    request.bookingId,
    alsoInTransaction,
  );

/**
 * Gate 2, handed to the tool gateway: a write runs only for this user's persisted
 * in-flight operation of that kind, whose approval is `used`, with the operation's own request.
 */
export const authorizeWrite =
  (db: Db, userId: string) =>
  (tool: string, args: Record<string, unknown>): boolean => {
    if (tool !== "book" && tool !== "cancel") return false; // reschedule gets its own check with its unit
    const op = operationRepo(db).byKey(String(args.idempotencyKey));
    if (!op || op.user_id !== userId || op.kind !== tool || op.status !== "in_flight") return false;
    if (approvalRepo(db).getById(op.approval_id)?.status !== "used") return false;
    const sent = JSON.parse(op.request) as { holdId?: string; bookingId?: string };
    return tool === "book" ? sent.holdId === args.holdId : sent.bookingId === args.bookingId;
  };
