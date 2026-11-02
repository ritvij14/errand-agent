import type { Db } from "../shared/db.js";
import type { Clock } from "../shared/clock.js";
import type { ToolResult } from "../tools/index.js";
import { operationRepo, type OperationRecord } from "./operation.repo.js";

// Executing a book operation (§ 2.5.6 "Book — step by step"). MH-3: success is never
// reported until get_booking_status(key) says booked — whatever `book` itself returned.
// Retries, re-holds and slot_taken handling are U22.

export type BookTools = {
  book: (args: { holdId: string; idempotencyKey: string }) => ToolResult<{ bookingId: string }>;
  status: (idempotencyKey: string) => ToolResult<{ status: string; bookingId?: string }>;
};

export type BookOutcome =
  { ok: true; bookingId: string } | { ok: false; error: string; checkedStatus: string };

export const executeBook = (
  db: Db,
  clock: Clock,
  tools: BookTools,
  op: OperationRecord,
  beforeVerify?: () => void,
): BookOutcome => {
  const repo = operationRepo(db);
  const { holdId } = JSON.parse(op.request) as { holdId: string };
  repo.recordAttempt(op.id, clock.now().getTime());
  const result = tools.book({ holdId, idempotencyKey: op.idempotency_key });
  beforeVerify?.();
  const checked = tools.status(op.idempotency_key);
  const checkedStatus = checked.ok ? checked.data.status : checked.error;
  if (
    checked.ok &&
    checked.data.status === "booked" &&
    checked.data.bookingId &&
    (!result.ok || result.data.bookingId === checked.data.bookingId)
  ) {
    repo.finish(op.id, "succeeded", { bookingId: checked.data.bookingId }, clock.now().getTime());
    return { ok: true, bookingId: checked.data.bookingId };
  }
  const error = result.ok ? "unverified" : result.error;
  repo.finish(op.id, "failed", { error, checkedStatus }, clock.now().getTime());
  return { ok: false, error, checkedStatus };
};
