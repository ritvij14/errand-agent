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
});
