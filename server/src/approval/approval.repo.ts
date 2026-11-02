import { randomUUID } from "node:crypto";
import type { Db } from "../shared/db.js";

// Approval records (§ 2.5.5). Created by code from saved state — never from model
// output or tool arguments — so the card shows exactly what will be checked.

export type ApprovalRecord = {
  id: string;
  user_id: string;
  conversation_id: string;
  workflow_id: string;
  action: "book" | "cancel" | "reschedule";
  provider_id: string;
  slot: string;
  price: number;
  booking_id: string | null;
  hold_id: string | null;
  status: "pending" | "approved" | "used" | "declined" | "voided";
  decided_via: "button" | "typed" | null;
  void_reason: string | null;
  created_at: number;
  decided_at: number | null;
  used_at: number | null;
};

export type NewApproval = Pick<
  ApprovalRecord,
  "user_id" | "conversation_id" | "workflow_id" | "action" | "provider_id" | "slot" | "price"
> & {
  hold_id?: string;
  booking_id?: string;
};

export const approvalRepo = (db: Db) => ({
  createPending: (input: NewApproval, now: number): ApprovalRecord => {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO approval (id, user_id, conversation_id, workflow_id, action, provider_id, slot, price, booking_id, hold_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(
      id,
      input.user_id,
      input.conversation_id,
      input.workflow_id,
      input.action,
      input.provider_id,
      input.slot,
      input.price,
      input.booking_id ?? null,
      input.hold_id ?? null,
      now,
    );
    return db.prepare(`SELECT * FROM approval WHERE id = ?`).get(id) as ApprovalRecord;
  },

  getById: (id: string): ApprovalRecord | undefined =>
    db.prepare(`SELECT * FROM approval WHERE id = ?`).get(id) as ApprovalRecord | undefined,

  /** The one waiting (pending or approved) approval of a workflow, if any. */
  getOpen: (workflowId: string): ApprovalRecord | undefined =>
    db.prepare(`SELECT * FROM approval WHERE workflow_id = ? AND status IN ('pending','approved')`).get(workflowId) as
      | ApprovalRecord
      | undefined,

  /** pending → approved / declined; false when it was no longer pending. */
  decide: (id: string, status: "approved" | "declined", via: "button" | "typed", now: number): boolean =>
    db
      .prepare(`UPDATE approval SET status = ?, decided_via = ?, decided_at = ? WHERE id = ? AND status = 'pending'`)
      .run(status, via, now, id).changes === 1,

  /** pending / approved → voided, with the reason (§ 2.5.5 life step 4). */
  voidOpen: (id: string, reason: string, now: number): boolean =>
    db
      .prepare(`UPDATE approval SET status = 'voided', void_reason = ?, decided_at = ? WHERE id = ? AND status IN ('pending','approved')`)
      .run(reason, now, id).changes === 1,

  /** approved → used (§ 2.5.5 life step 5): single use; false if it wasn't approved. */
  markUsed: (id: string, now: number): boolean =>
    db.prepare(`UPDATE approval SET status = 'used', used_at = ? WHERE id = ? AND status = 'approved'`).run(now, id).changes === 1,
});

/** A pending approval older than the hold's lifetime is stale (§ 2.5.5 life step 6). */
export const APPROVAL_MAX_AGE_MS = 10 * 60 * 1000;
