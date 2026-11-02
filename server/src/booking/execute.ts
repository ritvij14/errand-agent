import type { Db } from "../shared/db.js";
import type { Clock } from "../shared/clock.js";
import type { BookingRecord, ToolResult } from "../tools/index.js";
import { operationRepo, type OperationRecord } from "./operation.repo.js";

// Executing a book operation (§ 2.5.6 "Book — step by step"). MH-3: success is never
// reported until get_booking_status(key) says booked — whatever `book` itself returned.

export const MAX_BOOK_ATTEMPTS = 3; // per key (NFR-2)

export type BookTools = {
  book: (args: { holdId: string; idempotencyKey: string }) => ToolResult<{ bookingId: string }>;
  status: (idempotencyKey: string) => ToolResult<{ status: string; bookingId?: string }>;
  /** waits between retries of the same key, on the clock: 0.5 s, then 1 s (NFR-2) */
  retryWaitsMs: number[];
  /** the run's budget for a wait: returns the ms actually waited (R8) */
  wait: (ms: number) => number;
};

export type BookOutcome =
  | { ok: true; bookingId: string }
  /** the operation is finished as failed; `checkedStatus` is what the provider says now (R5) */
  | { ok: false; kind: "slot_taken" | "not_booked" | "retries_exhausted"; checkedStatus: string }
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
      waitBeforeRetry(clock, tools, attempt);
      continue;
    }
    const exhausted = status === "not_found" && !result.ok && result.transient; // every attempt used
    const error = exhausted ? "retries_exhausted" : result.ok ? "unverified" : result.error;
    repo.finish(op.id, "failed", { error, checkedStatus: status }, now());
    return { ok: false, kind: exhausted ? "retries_exhausted" : "not_booked", checkedStatus: status };
  }
};

/** NFR-2: 0.5 s, then 1 s, on the clock — through the run's budget, so a wait never passes the cap. */
const waitBeforeRetry = (
  clock: Clock,
  tools: { retryWaitsMs: number[]; wait: (ms: number) => number },
  attempt: number,
): void => {
  clock.advanceMs(tools.wait(tools.retryWaitsMs[attempt - 1] ?? tools.retryWaitsMs.at(-1) ?? 0));
};

type ChangeTools = {
  list: () => ToolResult<{ bookings: BookingRecord[] }>;
  retryWaitsMs: number[];
  wait: (ms: number) => number;
};

export type CancelTools = ChangeTools & {
  cancel: (args: { bookingId: string; idempotencyKey: string }) => ToolResult<{ bookingId: string }>;
};

export type RescheduleTools = ChangeTools & {
  reschedule: (args: { bookingId: string; newSlot: string; idempotencyKey: string }) => ToolResult<unknown>;
};

export type ChangeOutcome =
  | { ok: true }
  /** `checkedStatus` is the booking's status from list_bookings (R5) */
  | { ok: false; kind: "booking_changed" | "not_changed" | "slot_conflict"; checkedStatus: string };
export type CancelOutcome = ChangeOutcome;
export type RescheduleOutcome = ChangeOutcome;

/**
 * Executing a cancel or reschedule operation (§ 2.5.6 "Cancel and reschedule"). R3: before
 * any call the booking is re-read with list_bookings and must still be as approved. A
 * transient failure (the designed first-call 503, V-8) is retried with the same key; a
 * real answer (`slot_conflict`) is returned as is; an unclear outcome is settled by
 * reading the booking again.
 */
const executeChange = (
  db: Db,
  clock: Clock,
  tools: ChangeTools,
  op: OperationRecord,
  rules: {
    unchanged: (b: BookingRecord) => boolean;
    happened: (b: BookingRecord) => boolean;
    call: () => ToolResult<unknown>;
    answers?: string[];
  },
): ChangeOutcome => {
  const repo = operationRepo(db);
  const now = () => clock.now().getTime();
  const bookingId = op.booking_id!;
  const current = () => {
    const listed = tools.list();
    return listed.ok ? listed.data.bookings.find((b) => b.id === bookingId) : undefined;
  };
  const succeed = (): ChangeOutcome => {
    repo.finish(op.id, "succeeded", { bookingId }, now());
    return { ok: true };
  };

  const before = current();
  if (op.attempts > 0 && before && rules.happened(before)) return succeed(); // restart after the call went through
  if (!before || !rules.unchanged(before)) {
    const checkedStatus = before?.status ?? "not_found";
    repo.finish(op.id, "failed", { error: "booking_changed", checkedStatus }, now());
    return { ok: false, kind: "booking_changed", checkedStatus };
  }

  let error = "unknown";
  for (let attempt = 1; attempt <= MAX_BOOK_ATTEMPTS; attempt += 1) {
    repo.recordAttempt(op.id, now());
    const result = rules.call();
    if (result.ok) return succeed();
    error = result.error;
    if (rules.answers?.includes(result.error)) {
      repo.finish(op.id, "failed", { error, checkedStatus: before.status }, now());
      return { ok: false, kind: "slot_conflict", checkedStatus: before.status };
    }
    if (!result.transient || attempt === MAX_BOOK_ATTEMPTS) break;
    waitBeforeRetry(clock, tools, attempt);
  }
  // outcome unclear: the booking itself says whether it happened
  const after = current();
  if (after && rules.happened(after)) return succeed();
  const checkedStatus = after?.status ?? "unknown";
  repo.finish(op.id, "failed", { error, checkedStatus }, now());
  return { ok: false, kind: "not_changed", checkedStatus };
};

export const executeCancel = (
  db: Db,
  clock: Clock,
  tools: CancelTools,
  op: OperationRecord,
  approved: { providerId: string; slot: string },
): CancelOutcome =>
  executeChange(db, clock, tools, op, {
    unchanged: (b) =>
      b.status === "booked" && b.providerId === approved.providerId && b.slot === approved.slot,
    happened: (b) => b.status === "cancelled",
    call: () => tools.cancel({ bookingId: op.booking_id!, idempotencyKey: op.idempotency_key }),
  });

/** V-9: the booking keeps its provider and price; only the slot moves. */
export const executeReschedule = (
  db: Db,
  clock: Clock,
  tools: RescheduleTools,
  op: OperationRecord,
  approved: { providerId: string; price: number },
): RescheduleOutcome => {
  const { newSlot } = JSON.parse(op.request) as { newSlot: string };
  return executeChange(db, clock, tools, op, {
    unchanged: (b) =>
      b.status === "booked" && b.providerId === approved.providerId && b.price === approved.price,
    happened: (b) => b.status === "booked" && b.slot === newSlot,
    call: () => tools.reschedule({ bookingId: op.booking_id!, newSlot, idempotencyKey: op.idempotency_key }),
    answers: ["slot_conflict"],
  });
};
