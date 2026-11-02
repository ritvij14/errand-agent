import type { Db } from "../shared/db.js";

// Operation records (§ 2.5.6): one row per approved action, saved before the tool is
// called. There is no local copy of bookings — the provider side is the only record.

export type OperationRecord = {
  id: string;
  kind: "book" | "cancel" | "reschedule";
  user_id: string;
  conversation_id: string;
  workflow_id: string;
  approval_id: string;
  idempotency_key: string;
  hold_seq: number;
  request: string; // JSON: exactly what is sent
  booking_id: string | null;
  status: "in_flight" | "succeeded" | "failed";
  attempts: number;
  result: string | null;
  created_at: number;
  updated_at: number;
};

export const operationRepo = (db: Db) => ({
  insert: (
    op: Pick<
      OperationRecord,
      | "id"
      | "kind"
      | "user_id"
      | "conversation_id"
      | "workflow_id"
      | "approval_id"
      | "idempotency_key"
      | "request"
    >,
    now: number,
  ): OperationRecord => {
    db.prepare(
      `INSERT INTO operation (id, kind, user_id, conversation_id, workflow_id, approval_id, idempotency_key, request, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'in_flight', ?, ?)`,
    ).run(
      op.id,
      op.kind,
      op.user_id,
      op.conversation_id,
      op.workflow_id,
      op.approval_id,
      op.idempotency_key,
      op.request,
      now,
      now,
    );
    return db.prepare(`SELECT * FROM operation WHERE id = ?`).get(op.id) as OperationRecord;
  },

  forApproval: (approvalId: string): OperationRecord | undefined =>
    db.prepare(`SELECT * FROM operation WHERE approval_id = ?`).get(approvalId) as
      OperationRecord | undefined,

  byKey: (key: string): OperationRecord | undefined =>
    db.prepare(`SELECT * FROM operation WHERE idempotency_key = ?`).get(key) as OperationRecord | undefined,

  /** Every operation left in flight — at server start these are what a stop interrupted (§ 2.5.6). */
  allInFlight: (): OperationRecord[] =>
    db
      .prepare(`SELECT * FROM operation WHERE status = 'in_flight' ORDER BY created_at`)
      .all() as OperationRecord[],

  inFlightFor: (workflowId: string): OperationRecord | undefined =>
    db.prepare(`SELECT * FROM operation WHERE workflow_id = ? AND status = 'in_flight'`).get(workflowId) as
      OperationRecord | undefined,

  recordAttempt: (id: string, now: number): void => {
    db.prepare(`UPDATE operation SET attempts = attempts + 1, updated_at = ? WHERE id = ?`).run(now, id);
  },

  finish: (
    id: string,
    status: "succeeded" | "failed",
    result: Record<string, unknown>,
    now: number,
  ): void => {
    db.prepare(
      `UPDATE operation SET status = ?, result = ?, updated_at = ? WHERE id = ? AND status = 'in_flight'`,
    ).run(status, JSON.stringify(result), now, id);
  },

  /**
   * A new hold gets a new key (`<op id>:<n+1>`) — the provider remembers the old key's
   * final `hold_expired`. One statement, so the next key's state and the previous key's
   * terminal outcome are committed together (R7).
   */
  nextKey: (id: string, holdId: string, previousOutcome: string, now: number): OperationRecord => {
    db.prepare(
      `UPDATE operation SET hold_seq = hold_seq + 1, idempotency_key = id || ':' || (hold_seq + 1), request = ?, attempts = 0,
         result = json_object('previousKey', idempotency_key, 'previousOutcome', ?), updated_at = ?
       WHERE id = ? AND status = 'in_flight'`,
    ).run(JSON.stringify({ holdId }), previousOutcome, now, id);
    return db.prepare(`SELECT * FROM operation WHERE id = ?`).get(id) as OperationRecord;
  },
});
