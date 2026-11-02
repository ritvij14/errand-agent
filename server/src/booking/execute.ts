import type { Db } from "../shared/db.js";
import type { Clock } from "../shared/clock.js";
import type { ToolResult } from "../tools/index.js";
import { operationRepo, type OperationRecord } from "./operation.repo.js";

// Executing a book operation (§ 2.5.6 "Book — step by step"). MH-3: success is never
// reported until get_booking_status(key) says booked — whatever `book` itself returned.

export const MAX_BOOK_ATTEMPTS = 3; // per key (NFR-2)

export type BookTools = {
  book: (args: { holdId: string; idempotencyKey: string }) => ToolResult<{ bookingId: string }>;
  status: (idempotencyKey: string) => ToolResult<{ status: string; bookingId?: string }>;
  /** waits between retries of the same key, on the clock: 0.5 s, then 1 s (NFR-2) */
  retryWaitsMs: number[];
};

export type BookOutcome =
  | { ok: true; bookingId: string }
  /** the operation is finished as failed; `checkedStatus` is what the provider says now (R5) */
  | { ok: false; kind: "slot_taken" | "not_booked"; checkedStatus: string }
  /** the hold ran out: the operation stays in flight so the caller can re-hold (V-4) */
  | { ok: false; kind: "hold_expired" };

export const executeBook = (
  db: Db,
  clock: Clock,
  tools: BookTools,
  op: OperationRecord,
  beforeVerify?: () => void,
): BookOutcome => {
  const repo = operationRepo(db);
  const now = () => clock.now().getTime();
  const { holdId } = JSON.parse(op.request) as { holdId: string };
  const key = op.idempotency_key;
  let verifying = false;

  for (let attempt = 1; ; attempt += 1) {
    repo.recordAttempt(op.id, now());
    const result = tools.book({ holdId, idempotencyKey: key });
    if (!result.ok && result.error === "hold_expired") return { ok: false, kind: "hold_expired" };
    if (!result.ok && result.error === "slot_taken") {
      repo.finish(op.id, "failed", { error: "slot_taken" }, now());
      return { ok: false, kind: "slot_taken", checkedStatus: "failed" };
    }
    // ok, a timeout, or anything unclear: never trusted — always checked (MH-3)
    if (!verifying) {
      verifying = true;
      beforeVerify?.();
    }
    const checked = tools.status(key);
    const status = checked.ok ? checked.data.status : checked.error;
    if (
      checked.ok &&
      status === "booked" &&
      checked.data.bookingId &&
      (!result.ok || result.data.bookingId === checked.data.bookingId)
    ) {
      repo.finish(op.id, "succeeded", { bookingId: checked.data.bookingId }, now());
      return { ok: true, bookingId: checked.data.bookingId };
    }
    // a timeout that left nothing behind is retried with the SAME key (the provider can't double-book it)
    if (status === "not_found" && !result.ok && result.transient && attempt < MAX_BOOK_ATTEMPTS) {
      clock.advanceMs(tools.retryWaitsMs[attempt - 1] ?? tools.retryWaitsMs.at(-1) ?? 0);
      continue;
    }
    repo.finish(
      op.id,
      "failed",
      { error: result.ok ? "unverified" : result.error, checkedStatus: status },
      now(),
    );
    return { ok: false, kind: "not_booked", checkedStatus: status };
  }
};
