import { describe, expect, it } from "vitest";
import { createClock } from "../shared/clock.js";
import { createTestDb, type TestDb } from "../shared/test-db.js";
import { seedMockWorld, freeSlots, slotWindow } from "./mock-world.js";
import { listBookings } from "./read-tools.js";
import type { Db } from "../shared/db.js";
import { createMockSettings, DEFAULT_SEED, type MockSettings } from "./settings.js";
import { holdSlot, book, getBookingStatus, type ForcedQueue, type WriteOpts } from "./write-tools.js";

function world(o?: { seed?: string; settings?: Partial<MockSettings>; forced?: ForcedQueue }) {
  const testDb = createTestDb();
  const seed = o?.seed ?? DEFAULT_SEED;
  const clock = createClock({ now: new Date("2026-11-02T03:45:00Z") }); // 09:15 IST
  const forced = o?.forced ?? noForced();
  const settings = { ...createMockSettings(), ...o?.settings };
  seedMockWorld(testDb.db, { seed, clock });
  const opts: WriteOpts = { seed, clock, settings, forced };
  return { testDb, db: testDb.db as Db, clock, settings, opts };
}

const noForced = (): ForcedQueue => ({ take: () => undefined });

function firstProvider(db: TestDb["db"], service?: string): { id: string; price: number } {
  return (
    service
      ? (db.prepare("SELECT id, price FROM mock_provider WHERE service = ? LIMIT 1").get(service) as { id: string; price: number })
      : (db.prepare("SELECT id, price FROM mock_provider LIMIT 1").get() as { id: string; price: number })
  );
}

// holds the provider's first seeded free slot after `notBefore` (to keep order stable)
function makeHold(db: Db, opts: WriteOpts, key = "op-1:1"): { holdId: string; slot: string } {
  const provider = firstProvider(db);
  const days = slotWindow(opts.clock);
  const slots = freeSlots(db, { seed: opts.seed, clock: opts.clock }, provider.id, days[2]!, days[13]!)
    .filter((s) => s >= `${days[2]}T00:00`);
  if (slots.length === 0) throw new Error("no free slot found");
  const hold = holdSlot(db, opts, "u-tester", { providerId: provider.id, slot: slots[0]! });
  if (!hold.ok) throw new Error(`hold failed: ${hold.error}`);
  void key;
  return { holdId: hold.data.holdId, slot: hold.data.slot };
}

describe("hold_slot", () => {
  it("holds a free slot for 10 minutes on the clock and quotes the search price", () => {
    const { db, clock, opts } = world();
    const provider = firstProvider(db);
    const slot = freeSlots(db, { seed: opts.seed, clock }, provider.id, "2026-11-06", "2026-11-06")[0]!;
    const result = holdSlot(db, opts, "u-tester", { providerId: provider.id, slot });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Math.abs(result.data.quotedPrice - provider.price)).toBeLessThanOrEqual(Math.round(provider.price * 0.15));
    expect(result.data.expiresAt).toBe(clock.now().getTime() + 10 * 60 * 1000);
  });

  it("with a differing price forced on every hold, quotes stay within ±15% of the search price", () => {
    const { db, opts, settings } = world({ settings: { priceDiffProb: 1 } });
    const provider = firstProvider(db, "electrician");
    const days = slotWindow(opts.clock);
    const slots = freeSlots(db, { seed: opts.seed, clock: opts.clock }, provider.id, days[2]!, days[13]!);
    expect(slots.length).toBeGreaterThanOrEqual(4);
    const quoted = slots.slice(0, 6).map((slot) => {
      const result = holdSlot(db, opts, "u-tester", { providerId: provider.id, slot });
      if (!result.ok) throw new Error(`hold refused for ${slot}`);
      return result.data.quotedPrice;
    });
    for (const q of quoted) {
      expect(q).toBeGreaterThanOrEqual(Math.round(provider.price * (1 - settings.priceDiffMax)));
      expect(q).toBeLessThanOrEqual(Math.round(provider.price * (1 + settings.priceDiffMax)));
    }
    expect(quoted.some((q) => q !== provider.price)).toBe(true); // prob 1 → some differ
    expect(quoted.some((q) => q !== quoted[0])).toBe(true); // not always the same shift
  });

  it("refuses a slot that is booked or already held (slot_unavailable)", () => {
    const { db, clock, opts } = world();
    const provider = firstProvider(db, "ac_servicing");
    const day = slotWindow(clock)[5]!;
    const slots = freeSlots(db, { seed: opts.seed, clock }, provider.id, day, day);
    expect(slots.length).toBeGreaterThanOrEqual(2);
    const bookedSlot = slots[0]!;
    db.prepare(
      `INSERT INTO mock_booking (id, user_id, provider_id, service, area, slot, price, status, cancel_503_served, created_at, updated_at)
       VALUES ('b-x', 'u-someone', ?, 'ac_servicing', 'x', ?, 500, 'booked', 0, ?, ?)`,
    ).run(provider.id, bookedSlot, clock.now().getTime(), clock.now().getTime());
    const heldSlot = slots[1]!;
    db.prepare(
      `INSERT INTO mock_hold (id, user_id, provider_id, slot, quoted_price, expires_at, created_at) VALUES ('h-x', 'u-1', ?, ?, 700, ?, ?)`,
    ).run(provider.id, heldSlot, clock.now().getTime() + 60_000, clock.now().getTime());
    for (const slot of [bookedSlot, heldSlot]) {
      expect(holdSlot(db, opts, "u-tester", { providerId: provider.id, slot })).toMatchObject({
        ok: false,
        error: "slot_unavailable",
        transient: false,
      });
    }
  });

  it("a held slot is free again once it expires", () => {
    const { db, clock, opts } = world({ settings: { priceDiffProb: 0 } });
    const provider = firstProvider(db);
    const days = slotWindow(clock);
    const slot = freeSlots(db, { seed: opts.seed, clock }, provider.id, days[3]!, days[13]!)[0]!;
    expect(holdSlot(db, opts, "u-a", { providerId: provider.id, slot }).ok).toBe(true);
    clock.advanceMs(11 * 60 * 1000);
    expect(holdSlot(db, opts, "u-b", { providerId: provider.id, slot }).ok).toBe(true);
  });
});

describe("book", () => {
  it("books and creates exactly one provider booking when forced ok", () => {
    const { db, opts } = world({ forced: oneTool("book", "ok") });
    const { holdId } = makeHold(db, opts);
    const result = book(db, opts, "u-tester", { holdId, idempotencyKey: "op-1:1" });
    expect(result).toMatchObject({ ok: true, data: { bookingId: expect.any(String) } });
    expect((db.prepare("SELECT COUNT(*) c FROM mock_booking WHERE user_id = 'u-tester'").get() as { c: number }).c).toBe(1);
  });

  it("the same key replays the same final result and never creates a second booking", () => {
    const { db, opts } = world({ forced: oneTool("book", "ok") });
    const { holdId } = makeHold(db, opts);
    const first = book(db, opts, "u-tester", { holdId, idempotencyKey: "op-1:1" });
    const second = book(db, opts, "u-tester", { holdId, idempotencyKey: "op-1:1" });
    expect(first).toMatchObject({ ok: true });
    expect(second).toEqual(first);
    expect((db.prepare("SELECT COUNT(*) c FROM mock_booking WHERE user_id = 'u-tester'").get() as { c: number }).c).toBe(1);
  });

  it("timeout_booked: booking exists on the provider side while the caller saw a timeout", () => {
    const { db, opts } = world({ forced: oneTool("book", "timeout_booked") });
    const { holdId } = makeHold(db, opts);
    const result = book(db, opts, "u-tester", { holdId, idempotencyKey: "op-1:1" });
    expect(result).toMatchObject({ ok: false, error: "timeout", transient: true });
    expect(getBookingStatus(db, opts, "op-1:1")).toEqual({ ok: true, data: { status: "booked", bookingId: expect.any(String) } });
  });

  it("plain timeout creates nothing, pauses the clock, and is retriable (not remembered)", () => {
    const { db, clock, opts } = world({
      forced: { take: (tool, nth) => (tool === "book" && nth === 0 ? { outcome: "timeout" } : undefined) },
      settings: { okProb: 1, timeoutPauseMs: 10_000 },
    });
    const { holdId } = makeHold(db, opts);
    const before = clock.now().getTime();
    const result = book(db, opts, "u-tester", { holdId, idempotencyKey: "op-1:1" });
    expect(result).toMatchObject({ ok: false, error: "timeout", transient: true });
    expect(clock.now().getTime() - before).toBe(10_000); // the pause is on the clock
    expect(getBookingStatus(db, opts, "op-1:1")).toMatchObject({ ok: true, data: { status: "not_found" } });
    expect(book(db, opts, "u-tester", { holdId, idempotencyKey: "op-1:1" })).toMatchObject({ ok: true }); // retry draws ok (okProb 1)
    expect((db.prepare("SELECT COUNT(*) c FROM mock_booking WHERE user_id = 'u-tester'").get() as { c: number }).c).toBe(1);
  });

  it("slot_taken: the slot really goes to someone else and the key is failed forever", () => {
    const { db, opts } = world({ forced: oneTool("book", "slot_taken") });
    const { holdId } = makeHold(db, opts);
    const result = book(db, opts, "u-tester", { holdId, idempotencyKey: "op-1:1" });
    expect(result).toMatchObject({ ok: false, error: "slot_taken", transient: false });
    expect(getBookingStatus(db, opts, "op-1:1")).toMatchObject({ ok: true, data: { status: "failed" } });
    const testerBookings = (db.prepare("SELECT COUNT(*) c FROM mock_booking WHERE user_id='u-tester'").get() as { c: number }).c;
    expect(testerBookings).toBe(0);
    const others = (db.prepare("SELECT COUNT(*) c FROM mock_booking WHERE user_id='u-someone-else'").get() as { c1: number } | { c: number }) as { c: number };
    expect(others.c).toBe(1);
    // replay: same final result remembered
    expect(book(db, opts, "u-tester", { holdId, idempotencyKey: "op-1:1" })).toMatchObject({ ok: false, error: "slot_taken" });
  });

  it("a booking past its hold's expiry → hold_expired, remembered", () => {
    const { db, clock, opts } = world();
    const { holdId } = makeHold(db, opts);
    clock.advanceMs(11 * 60 * 1000);
    const result = book(db, opts, "u-tester", { holdId, idempotencyKey: "op-1:1" });
    expect(result).toMatchObject({ ok: false, error: "hold_expired", transient: false });
    expect(book(db, opts, "u-tester", { holdId, idempotencyKey: "op-1:1" })).toMatchObject({ ok: false, error: "hold_expired" });
  });

  it("a fault between the booking write and the idempotency write leaves neither (R7)", () => {
    const { db, opts } = world({ forced: oneTool("book", "ok") });
    const { holdId } = makeHold(db, opts);
    expect(() => book(db, opts, "u-tester", { holdId, idempotencyKey: "op-1:1", testFaultAfterBookingWrite: true })).toThrow();
    expect((db.prepare("SELECT COUNT(*) c FROM mock_booking WHERE user_id='u-tester'").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) c FROM mock_idempotency WHERE key='op-1:1'").get() as { c: number }).c).toBe(0);
  });
});

describe("draws are reproducible for the same seed and inputs", () => {
  it("two equal worlds give equal outcomes for the same key", () => {
    const a = world();
    const b = world();
    const { holdId: holdA, slot: slotA } = makeHold(a.db, a.opts);
    const { holdId: holdB, slot: slotB } = makeHold(b.db, b.opts);
    expect(slotA).toBe(slotB);
    expect(book(a.db, a.opts, "u-tester", { holdId: holdA, idempotencyKey: "op-9:1" })).toEqual(
      book(b.db, b.opts, "u-tester", { holdId: holdB, idempotencyKey: "op-9:1" }),
    );
  });
});

describe("integration through the tool layer", () => {
  it("a booked booking appears in list_bookings with its price and area", () => {
    const { db, opts } = world({ forced: oneTool("book", "ok") });
    const provider = firstProvider(db, "carpentry");
    const days = slotWindow(opts.clock);
    const slot = freeSlots(db, { seed: opts.seed, clock: opts.clock }, provider.id, days[3]!, days[13]!)[0]!;
    const hold = holdSlot(db, opts, "u-alice", { providerId: provider.id, slot });
    if (!hold.ok) throw new Error("hold failed");
    const result = book(db, opts, "u-alice", { holdId: hold.data.holdId, idempotencyKey: "op-2:1" });
    if (!result.ok) throw new Error(`book failed: ${result.error}`);
    const list = listBookings(db, opts, "u-alice");
    if (!list.ok) throw new Error("list failed");
    const booking = list.data.bookings.find((b) => b.id === result.data.bookingId);
    expect(booking).toMatchObject({ status: "booked", price: expect.any(Number), area: expect.any(String) });
  });
});

const oneTool = (tool: string, outcome: string): ForcedQueue => {
  let taken = false;
  return {
    take: (t) => {
      if (t === tool && !taken) {
        taken = true;
        return { outcome };
      }
      return undefined;
    },
  };
};