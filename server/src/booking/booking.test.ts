import { describe, expect, it } from "vitest";
import { createClock } from "../shared/clock.js";
import { createTestDb } from "../shared/test-db.js";
import { seedDemoUsers } from "../auth/index.js";
import { approvalRepo } from "../approval/index.js";
import {
  createMockSettings,
  createToolGateway,
  DEFAULT_SEED,
  seedMockWorld,
  slotWindow,
} from "../tools/index.js";
import { freeSlots } from "../tools/mock-world.js";
import { authorizeWrite, operationRepo, startBookOperation } from "./index.js";
import { startTrace } from "../tracing/index.js";

// The two gates (§ 2.5.5, R1). Gate 1: an operation is created only from an approved,
// matching approval, which it uses up. Gate 2: the gateway executes `book` only for a
// persisted in-flight operation whose approval is used and whose request matches.

const ALICE = "u-demo-alice";

const world = () => {
  const testDb = createTestDb();
  const db = testDb.db;
  const clock = createClock({ now: new Date("2026-11-02T03:45:00Z") });
  seedDemoUsers(db, clock.now().getTime());
  seedMockWorld(db, { seed: DEFAULT_SEED, clock });
  const gateway = createToolGateway({
    db,
    clock,
    settings: createMockSettings(),
    forced: { take: (tool) => (tool === "book" ? { outcome: "ok" } : undefined) },
    seed: DEFAULT_SEED,
    userId: ALICE,
    authorizeWrite: authorizeWrite(db, ALICE),
  });
  // a held slot and an approval for it, as the workflow would leave them
  db.prepare(
    `INSERT INTO conversation (id, user_id, title, created_at, updated_at) VALUES ('c1', ?, 't', 1, 1)`,
  ).run(ALICE);
  db.prepare(
    `INSERT INTO workflow (id, conversation_id, user_id, intent, phase, facts, version, created_at, updated_at) VALUES ('w1', 'c1', ?, 'book', 'awaiting_approval', '{}', 1, 1, 1)`,
  ).run(ALICE);
  const provider = db.prepare(`SELECT id FROM mock_provider WHERE service = 'plumber' LIMIT 1`).get() as {
    id: string;
  };
  const days = slotWindow(clock);
  const slot = freeSlots(db, { seed: DEFAULT_SEED, clock }, provider.id, days[1]!, days[13]!)[0]!;
  const hold = gateway.holdSlot({ providerId: provider.id, slot });
  if (!hold.ok) throw new Error(hold.error);
  const approval = approvalRepo(db).createPending(
    {
      user_id: ALICE,
      conversation_id: "c1",
      workflow_id: "w1",
      action: "book",
      provider_id: provider.id,
      slot,
      price: hold.data.quotedPrice,
      hold_id: hold.data.holdId,
    },
    clock.now().getTime(),
  );
  const approve = () => approvalRepo(db).decide(approval.id, "approved", "button", clock.now().getTime());
  const request = { providerId: provider.id, slot, price: hold.data.quotedPrice, holdId: hold.data.holdId };
  return {
    testDb,
    db,
    clock,
    gateway,
    approval,
    approve,
    request,
    bookings: () =>
      (db.prepare(`SELECT COUNT(*) AS c FROM mock_booking WHERE user_id = ?`).get(ALICE) as { c: number }).c,
  };
};

describe("Gate 1 — creating the operation", () => {
  it("an approved, matching approval becomes used and one in-flight operation with key '<op id>:1'", () => {
    const w = world();
    w.approve();
    const op = startBookOperation(w.db, w.clock, w.approval.id, w.request);
    expect(op.ok).toBe(true);
    if (!op.ok) return;
    expect(op.operation).toMatchObject({
      status: "in_flight",
      kind: "book",
      idempotency_key: `${op.operation.id}:1`,
    });
    expect(approvalRepo(w.db).getById(w.approval.id)).toMatchObject({ status: "used" });
    w.testDb.close();
  });

  it("refuses a pending (not approved) approval and a request that differs from what was approved", () => {
    const w = world();
    expect(startBookOperation(w.db, w.clock, w.approval.id, w.request)).toMatchObject({ ok: false });
    w.approve();
    expect(
      startBookOperation(w.db, w.clock, w.approval.id, { ...w.request, price: w.request.price + 1 }),
    ).toMatchObject({ ok: false });
    expect(operationRepo(w.db).forApproval(w.approval.id)).toBeUndefined();
    w.testDb.close();
  });

  it("a second operation for the same approval is refused by the database", () => {
    const w = world();
    w.approve();
    const first = startBookOperation(w.db, w.clock, w.approval.id, w.request);
    if (!first.ok) throw new Error("first refused");
    w.db.prepare(`UPDATE approval SET status = 'approved' WHERE id = ?`).run(w.approval.id); // pretend Gate 1 would pass again
    expect(() =>
      w.db
        .prepare(
          `INSERT INTO operation (id, kind, user_id, conversation_id, workflow_id, approval_id, idempotency_key, request, status, created_at, updated_at) VALUES ('op2', 'book', ?, 'c1', 'w1', ?, 'op2:1', '{}', 'in_flight', 1, 1)`,
        )
        .run(ALICE, w.approval.id),
    ).toThrow(/UNIQUE/);
    w.testDb.close();
  });
});

describe("Gate 2 — the gateway executes book only for a persisted operation", () => {
  it("refuses book with no operation behind the key", () => {
    const w = world();
    expect(w.gateway.book({ holdId: w.request.holdId, idempotencyKey: "made-up:1" })).toMatchObject({
      ok: false,
      error: "UNAUTHORIZED_WRITE",
    });
    expect(w.bookings()).toBe(2); // only alice's two seeded bookings
    w.testDb.close();
  });

  it("refuses book whose request doesn't match the operation", () => {
    const w = world();
    w.approve();
    const op = startBookOperation(w.db, w.clock, w.approval.id, w.request);
    if (!op.ok) throw new Error("refused");
    expect(
      w.gateway.book({ holdId: "another-hold", idempotencyKey: op.operation.idempotency_key }),
    ).toMatchObject({ ok: false, error: "UNAUTHORIZED_WRITE" });
    w.testDb.close();
  });

  it("refuses book for an operation whose approval was never used", () => {
    const w = world();
    w.approve(); // approved, but no Gate 1: the operation row is forged
    w.db
      .prepare(
        `INSERT INTO operation (id, kind, user_id, conversation_id, workflow_id, approval_id, idempotency_key, request, status, created_at, updated_at) VALUES ('forged', 'book', ?, 'c1', 'w1', ?, 'forged:1', ?, 'in_flight', 1, 1)`,
      )
      .run(ALICE, w.approval.id, JSON.stringify({ holdId: w.request.holdId }));
    expect(w.gateway.book({ holdId: w.request.holdId, idempotencyKey: "forged:1" })).toMatchObject({
      ok: false,
      error: "UNAUTHORIZED_WRITE",
    });
    expect(w.bookings()).toBe(2);
    w.testDb.close();
  });

  it("executes book for the persisted operation, exactly as approved", () => {
    const w = world();
    w.approve();
    const op = startBookOperation(w.db, w.clock, w.approval.id, w.request);
    if (!op.ok) throw new Error("refused");
    expect(
      w.gateway.book({ holdId: w.request.holdId, idempotencyKey: op.operation.idempotency_key }),
    ).toMatchObject({ ok: true });
    expect(w.bookings()).toBe(3);
    w.testDb.close();
  });

  it("without a write authorizer the gateway refuses every write (fail closed)", () => {
    const w = world();
    const bare = createToolGateway({
      db: w.db,
      clock: w.clock,
      settings: createMockSettings(),
      forced: { take: () => undefined },
      userId: ALICE,
      trace: startTrace(w.db, w.clock, "run-bare"),
    });
    w.approve();
    const op = startBookOperation(w.db, w.clock, w.approval.id, w.request);
    if (!op.ok) throw new Error("refused");
    expect(
      bare.book({ holdId: w.request.holdId, idempotencyKey: op.operation.idempotency_key }),
    ).toMatchObject({ ok: false, error: "UNAUTHORIZED_WRITE" });
    w.testDb.close();
  });
});
