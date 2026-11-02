import { describe, expect, it } from "vitest";
import { createClock } from "../shared/clock.js";
import { createTestDb } from "../shared/test-db.js";
import { seedDemoUsers } from "../auth/index.js";
import { approvalRepo } from "../approval/index.js";
import { DEFAULT_SEED, seedMockWorld } from "../tools/index.js";
import { authorizeWrite, startCancelOperation } from "./index.js";

// Cancel through the two gates (R1, R3): Gate 1 turns an approved cancel approval into
// one in-flight operation for that booking; Gate 2 lets `cancel` run only for it.

const ALICE = "u-demo-alice";
const BOOKING = "mb-demo-ac"; // alice's seeded upcoming booking

const world = () => {
  const testDb = createTestDb();
  const db = testDb.db;
  const clock = createClock({ now: new Date("2026-11-02T03:45:00Z") });
  seedDemoUsers(db, clock.now().getTime());
  seedMockWorld(db, { seed: DEFAULT_SEED, clock });
  const booking = db
    .prepare(`SELECT provider_id, slot, price FROM mock_booking WHERE id = ?`)
    .get(BOOKING) as {
    provider_id: string;
    slot: string;
    price: number;
  };
  const approvedCancel = (conversation: string) => {
    db.prepare(
      `INSERT INTO conversation (id, user_id, title, created_at, updated_at) VALUES (?, ?, 't', 1, 1)`,
    ).run(conversation, ALICE);
    db.prepare(
      `INSERT INTO workflow (id, conversation_id, user_id, intent, phase, facts, version, created_at, updated_at) VALUES (?, ?, ?, 'cancel', 'awaiting_approval', '{}', 1, 1, 1)`,
    ).run(`w-${conversation}`, conversation, ALICE);
    const approval = approvalRepo(db).createPending(
      {
        user_id: ALICE,
        conversation_id: conversation,
        workflow_id: `w-${conversation}`,
        action: "cancel",
        provider_id: booking.provider_id,
        slot: booking.slot,
        price: booking.price,
        booking_id: BOOKING,
      },
      clock.now().getTime(),
    );
    approvalRepo(db).decide(approval.id, "approved", "button", clock.now().getTime());
    return approval.id;
  };
  return { testDb, db, clock, approvedCancel };
};

describe("cancel gates (R1, R3)", () => {
  it("Gate 1: an approved cancel becomes one in-flight cancel operation for that booking and uses the approval", () => {
    const w = world();
    const approvalId = w.approvedCancel("c1");
    const started = startCancelOperation(w.db, w.clock, approvalId, { bookingId: BOOKING });
    expect(started).toMatchObject({
      ok: true,
      operation: { kind: "cancel", booking_id: BOOKING, status: "in_flight" },
    });
    expect(approvalRepo(w.db).getById(approvalId)?.status).toBe("used");
    w.testDb.close();
  });

  it("Gate 1 refuses a request for a different booking than the one approved", () => {
    const w = world();
    const approvalId = w.approvedCancel("c1");
    expect(
      startCancelOperation(w.db, w.clock, approvalId, { bookingId: "mb-demo-electrician" }),
    ).toMatchObject({ ok: false });
    expect(approvalRepo(w.db).getById(approvalId)?.status).toBe("approved");
    w.testDb.close();
  });

  it("two conversations can't both have a change in flight for the same booking — the database refuses the second", () => {
    const w = world();
    const first = startCancelOperation(w.db, w.clock, w.approvedCancel("c1"), { bookingId: BOOKING });
    const secondApproval = w.approvedCancel("c2");
    const second = startCancelOperation(w.db, w.clock, secondApproval, { bookingId: BOOKING });
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, reason: expect.stringMatching(/in progress/) });
    expect(approvalRepo(w.db).getById(secondApproval)?.status).toBe("approved"); // rolled back, not used
    w.testDb.close();
  });

  it("Gate 2: cancel runs only for this user's in-flight cancel operation on that exact booking", () => {
    const w = world();
    const started = startCancelOperation(w.db, w.clock, w.approvedCancel("c1"), { bookingId: BOOKING });
    if (!started.ok) throw new Error(started.reason);
    const key = started.operation.idempotency_key;
    expect(authorizeWrite(w.db, ALICE)("cancel", { bookingId: BOOKING, idempotencyKey: key })).toBe(true);
    expect(
      authorizeWrite(w.db, ALICE)("cancel", { bookingId: "mb-demo-electrician", idempotencyKey: key }),
    ).toBe(false);
    expect(authorizeWrite(w.db, "u-demo-bob")("cancel", { bookingId: BOOKING, idempotencyKey: key })).toBe(
      false,
    );
    expect(
      authorizeWrite(w.db, ALICE)("cancel", { bookingId: BOOKING, idempotencyKey: "no-such-op:1" }),
    ).toBe(false);
    expect(authorizeWrite(w.db, ALICE)("book", { holdId: "h", idempotencyKey: key })).toBe(false); // a cancel op never books
    w.testDb.close();
  });
});
