import { describe, expect, it } from "vitest";
import { createClock } from "../shared/clock.js";
import { createTestDb } from "../shared/test-db.js";
import { seedMockWorld, freeSlots, slotWindow } from "./mock-world.js";
import { listBookings } from "./read-tools.js";
import type { Db } from "../shared/db.js";
import { createMockSettings, DEFAULT_SEED, type MockSettings } from "./settings.js";
import { holdSlot, book, cancel, reschedule, type ForcedQueue, type WriteOpts } from "./write-tools.js";

function world(o?: { settings?: Partial<MockSettings>; forced?: ForcedQueue }) {
  const testDb = createTestDb();
  const clock = createClock({ now: new Date("2026-11-02T03:45:00Z") });
  const forced: ForcedQueue = o?.forced ?? { take: () => undefined };
  const settings = { ...createMockSettings(), ...o?.settings };
  seedMockWorld(testDb.db, { seed: DEFAULT_SEED, clock });
  return { testDb, db: testDb.db as Db, clock, settings, opts: { seed: DEFAULT_SEED, clock, settings, forced } as WriteOpts };
}

// Books a fresh booking for u-tester (forced ok) and returns its identity.
function makeBooking(db: Db, opts: WriteOpts): { bookingId: string; slot: string; price: number; providerId: string } {
  const provider = db.prepare(`SELECT id, price FROM mock_provider WHERE service = 'carpentry' LIMIT 1`).get() as {
    id: string;
    price: number;
  };
  const days = slotWindow(opts.clock);
  const slot = freeSlots(db, { seed: opts.seed, clock: opts.clock }, provider.id, days[3]!, days[13]!)[0]!;
  const hold = holdSlot(db, opts, "u-tester", { providerId: provider.id, slot });
  if (!hold.ok) throw new Error("hold failed in makeBooking");
  const result = book(db, { ...opts, forced: { take: (t) => (t === "book" ? { outcome: "ok" } : undefined) } }, "u-tester", {
    holdId: hold.data.holdId,
    idempotencyKey: `op-cancel:1`,
  });
  if (!result.ok) throw new Error(`book failed in makeBooking: ${result.error}`);
  void slot;
  return { bookingId: result.data.bookingId, slot: hold.data.slot, price: hold.data.quotedPrice, providerId: provider.id };
}

describe("cancel", () => {
  it("first call per booking fails with a transient 503 (V-8)", () => {
    const { db, opts } = world();
    const { bookingId } = makeBooking(db, opts);
    const result = cancel(db, opts, "u-tester", { bookingId, idempotencyKey: "op-c:1" });
    expect(result).toMatchObject({ ok: false, error: "glitch", transient: true });
  });

  it("retry with the same key cancels, recorded once, and the replay says cancelled again", () => {
    const { db, opts } = world();
    const { bookingId } = makeBooking(db, opts);
    expect(cancel(db, opts, "u-tester", { bookingId, idempotencyKey: "op-c:1" })).toMatchObject({ ok: false, transient: true });
    const retry = cancel(db, opts, "u-tester", { bookingId, idempotencyKey: "op-c:1" });
    expect(retry).toMatchObject({ ok: true, data: { bookingId } });
    const replay = cancel(db, opts, "u-tester", { bookingId, idempotencyKey: "op-c:1" });
    expect(replay).toEqual(retry);
    const list = listBookings(db, opts, "u-tester");
    if (!list.ok) throw new Error("list failed");
    const status = list.data.bookings.find((b) => b.id === bookingId);
    expect(status?.status).toBe("cancelled");
  });

  it("another user's Booking is not_found (user isolation at the tool, V-7)", () => {
    const { db, opts } = world();
    const { bookingId } = makeBooking(db, opts);
    expect(cancel(db, opts, "u-intruder", { bookingId, idempotencyKey: "op-x:1" })).toMatchObject({
      ok: false,
      error: "not_found",
      transient: false,
    });
  });

  it("an unknown booking is not_found", () => {
    const { db, opts } = world();
    expect(cancel(db, opts, "u-tester", { bookingId: "mb-none", idempotencyKey: "op-y:1" })).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });
});

describe("reschedule", () => {
  it("moves the booking to a free slot, keeps the price, and frees the old slot", () => {
    const { db, opts } = world();
    const { bookingId, slot: oldSlot, price, providerId } = makeBooking(db, opts);
    const days = slotWindow(opts.clock);
    const newSlot = freeSlots(db, { seed: opts.seed, clock: opts.clock }, providerId, days[9]!, days[13]!)[0]!;
    const result = reschedule(db, opts, "u-tester", { bookingId, newSlot, idempotencyKey: "op-r:1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.booking.slot).toBe(newSlot);
    expect(result.data.booking.price).toBe(price);
    const list = listBookings(db, opts, "u-tester");
    if (!list.ok) throw new Error("list failed");
    const moved = list.data.bookings.find((b) => b.id === bookingId);
    expect(moved?.slot).toBe(newSlot);
    const freedBack = freeSlots(db, { seed: opts.seed, clock: opts.clock }, providerId, oldSlot.slice(0, 10), oldSlot.slice(0, 10));
    expect(freedBack).toContain(oldSlot);
  });

  it("slot_conflict on a seeded conflict slot: remembered for the key, booking unchanged (prob 1)", () => {
    const { db, opts } = world({ settings: { slotConflictProb: 1 } });
    const { bookingId, providerId } = makeBooking(db, opts);
    const days = slotWindow(opts.clock);
    const newSlot = freeSlots(db, { seed: opts.seed, clock: opts.clock }, providerId, days[9]!, days[13]!)[0]!;
    const first = reschedule(db, opts, "u-tester", { bookingId, newSlot, idempotencyKey: "op-r:1" });
    expect(first).toMatchObject({ ok: false, error: "slot_conflict", transient: false });
    const replay = reschedule(db, opts, "u-tester", { bookingId, newSlot, idempotencyKey: "op-r:1" });
    expect(replay).toEqual(first);
    const movedBooking = listBookings(db, opts, "u-tester");
    if (!movedBooking.ok) throw new Error("list failed");
    expect(movedBooking.data.bookings.every((b) => b.id !== bookingId || b.slot !== newSlot)).toBe(true);
  });

  it("slot_conflict on a slot that is not free", () => {
    const { db, opts } = world();
    const { bookingId, providerId } = makeBooking(db, opts);
    // the booked-by-someone-else slot: book another free slot first, then use it as target
    const days = slotWindow(opts.clock);
    const busySlot = freeSlots(db, { seed: opts.seed, clock: opts.clock }, providerId, days[9]!, days[13]!)[0]!;
    const hold = holdSlot(db, opts, "u-other", { providerId, slot: busySlot });
    if (!hold.ok) throw new Error("hold failed");
    const result = reschedule(db, opts, "u-tester", { bookingId, newSlot: busySlot, idempotencyKey: "op-r2:1" });
    expect(result).toMatchObject({ ok: false, error: "slot_conflict", transient: false });
  });

  it("another user's booking is not_found", () => {
    const { db, opts } = world();
    const { bookingId } = makeBooking(db, opts);
    expect(reschedule(db, opts, "u-intruder", { bookingId, newSlot: "2026-11-09T14:00:00+05:30", idempotencyKey: "op-z:1" })).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });
});

describe("cancel and reschedule atomicity (R7)", () => {
  it("a fault between the cancel write and the idempotency write leaves the booking booked", () => {
    const { db, opts } = world();
    const { bookingId } = makeBooking(db, opts);
    cancel(db, opts, "u-tester", { bookingId, idempotencyKey: "op-c:1" }); // 503
    expect(() => cancel(db, opts, "u-tester", { bookingId, idempotencyKey: "op-c:1", testFaultAfterWrite: true })).toThrow();
    const list = listBookings(db, opts, "u-tester");
    if (!list.ok) throw new Error("list failed");
    expect(list.data.bookings.find((b) => b.id === bookingId)?.status).toBe("booked");
    expect((db.prepare("SELECT COUNT(*) c FROM mock_idempotency WHERE key='op-c:1'").get() as { c: number }).c).toBe(0);
  });
});