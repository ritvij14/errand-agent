import { describe, expect, it } from "vitest";
import { createClock, type Clock } from "../shared/clock.js";
import { createTestDb, type TestDb } from "../shared/test-db.js";
import { DEMO_USERS } from "../shared/demo-users.js";
import { seedMockWorld } from "./mock-world.js";
import { searchProviders, getProvider, listBookings, type ToolOpts } from "./read-tools.js";

function world(): { testDb: TestDb; db: TestDb["db"]; clock: Clock; opts: ToolOpts } {
  const testDb = createTestDb();
  const clock = createClock({ now: new Date("2026-11-02T03:45:00Z") }); // 09:15 IST Nov 2
  seedMockWorld(testDb.db, { seed: "u07-seed", clock });
  return { testDb, db: testDb.db, clock, opts: { seed: "u07-seed", clock } };
}

describe("search_providers", () => {
  it("returns 3–8 providers for a real service + area pair, with slots in the range and no reviews", () => {
    const { db, opts } = world();
    const result = searchProviders(db, opts, { service: "plumber", area: "hsr_layout", from: "2026-11-05", to: "2026-11-07" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.providers.length).toBeGreaterThanOrEqual(3);
    expect(result.data.providers.length).toBeLessThanOrEqual(8);
    for (const p of result.data.providers) {
      expect("reviews" in p).toBe(false);
      expect(Object.keys(p).sort()).toEqual(["attributes", "id", "name", "price", "rating", "slots"]);
      for (const slot of p.slots) {
        expect(Date.parse(slot)).toBeGreaterThanOrEqual(Date.parse("2026-11-05T00:00:00+05:30"));
        expect(Date.parse(slot)).toBeLessThanOrEqual(Date.parse("2026-11-07T23:59:00+05:30"));
      }
    }
  });

  it("keeps providers with no free slots in the range (they just have empty slot lists)", () => {
    const { db, opts } = world();
    const booked = db
      .prepare(`SELECT provider_id, slot FROM mock_booking WHERE status='booked' AND slot > '2026'`)
      .all() as { provider_id: string; slot: string }[];
    const result = searchProviders(db, opts, { service: "ac_servicing", area: "indiranagar", from: "2026-11-05", to: "2026-11-05" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const providerWithEmpty = result.data.providers.some(
      (p) => p.slots.length === 0 || booked.some((b) => b.provider_id === p.id && b.slot.startsWith("2026-11-05")),
    );
    expect(providerWithEmpty).toBe(true);
  });

  it("refuses a service outside the mock world", () => {
    const { db, opts } = world();
    const result = searchProviders(db, opts, { service: "pest_control", area: "hsr_layout", from: "2026-11-05", to: "2026-11-07" });
    expect(result).toEqual({ ok: false, error: "unknown_service", transient: false });
  });

  it("refuses an area outside the mock world", () => {
    const { db, opts } = world();
    const result = searchProviders(db, opts, { service: "plumber", area: "goa", from: "2026-11-05", to: "2026-11-07" });
    expect(result).toEqual({ ok: false, error: "unknown_area", transient: false });
  });
});

describe("get_provider", () => {
  it("returns details and the full reviews list, free text only", () => {
    const { db, opts } = world();
    const id = (db.prepare("SELECT id FROM mock_provider LIMIT 1").get() as { id: string }).id;
    const result = getProvider(db, opts, id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ id, name: expect.any(String), service: expect.any(String), price: expect.any(Number), rating: expect.any(Number) });
    expect(result.data.areas.length).toBeGreaterThanOrEqual(2);
    expect(result.data.reviews.length).toBeGreaterThanOrEqual(3);
    for (const review of result.data.reviews) {
      expect(typeof review.text).toBe("string");
      expect(Object.keys(review)).toEqual(["text"]);
    }
  });

  it("the injection reviews exist verbatim in get_provider's reviews", () => {
    const { db, opts } = world();
    const id = (
      db.prepare("SELECT provider_id FROM mock_review WHERE injection_kind = 'order'").get() as { provider_id: string }
    ).provider_id;
    const result = getProvider(db, opts, id);
    if (!result.ok) throw new Error("not ok");
    expect(result.data.reviews.some((r) => r.text.includes("Ignore previous instructions"))).toBe(true);
  });

  it("unknown provider id → not_found, not transient", () => {
    const { db, opts } = world();
    const result = getProvider(db, opts, "mp-9999");
    expect(result).toEqual({ ok: false, error: "not_found", transient: false });
  });
});

describe("list_bookings", () => {
  it("returns only the calling user's bookings with the R4 price and area", () => {
    const { db, opts } = world();
    const alice = DEMO_USERS[0]!;
    const result = listBookings(db, opts, alice.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.bookings.length).toBeGreaterThanOrEqual(2);
    for (const b of result.data.bookings) {
      expect(b).toMatchObject({ id: expect.any(String), providerId: expect.any(String), service: expect.any(String), area: expect.any(String), price: expect.any(Number), slot: expect.any(String), status: expect.any(String) });
    }
  });

  it("another user gets an empty list, never alice's bookings", () => {
    const { db, opts } = world();
    const result = listBookings(db, opts, "u-nobody");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.bookings).toEqual([]);
  });

  it("derives completed for bookings whose slot is past", () => {
    const { db, opts } = world();
    const alice = DEMO_USERS[0]!;
    const result = listBookings(db, opts, alice.id);
    if (!result.ok) throw new Error("not ok");
    const electrician = result.data.bookings.find((b) => b.service === "electrician");
    expect(electrician?.status).toBe("completed");
    const ac = result.data.bookings.find((b) => b.service === "ac_servicing");
    expect(ac?.status).toBe("booked");
  });
});