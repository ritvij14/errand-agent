import { describe, expect, it } from "vitest";
import { createClock, type Clock } from "../shared/clock.js";
import { DEMO_USERS } from "../shared/demo-users.js";
import { createTestDb, type TestDb } from "../shared/test-db.js";
import { AREAS, SERVICES, SERVICE_PRICE_RANGE, seedMockWorld, freeSlots, slotWindow } from "./mock-world.js";

function seededWorld(seed = "u06-seed"): { db: TestDb["db"]; clock: Clock } {
  const testDb = createTestDb();
  const clock = createClock({ now: new Date("2026-11-02T03:45:00Z") }); // 09:15 IST
  seedMockWorld(testDb.db, { seed, clock });
  return { db: testDb.db, clock };
}

const rows = (db: TestDb["db"], sql: string) => db.prepare(sql).all() as Record<string, unknown>[];

describe("mock world seed", () => {
  it("gives every service + area pair 3–8 providers", () => {
    const { db } = seededWorld();
    for (const service of SERVICES) {
      for (const area of AREAS) {
        const count = (
          rows(
            db,
            `SELECT COUNT(DISTINCT p.id) AS c FROM mock_provider p
             JOIN mock_provider_area a ON a.provider_id = p.id
             WHERE p.service = '${service}' AND a.area = '${area}'`,
          )[0] as { c: number }
        ).c;
        expect(count, `${service} in ${area}`).toBeGreaterThanOrEqual(3);
        expect(count, `${service} in ${area}`).toBeLessThanOrEqual(8);
      }
    }
  });

  it("prices sit in their service's range and ratings in 3.5–4.9", () => {
    const { db } = seededWorld();
    for (const row of rows(db, "SELECT service, price, rating FROM mock_provider") as {
      service: string;
      price: number;
      rating: number;
    }[]) {
      const [min, max] = SERVICE_PRICE_RANGE[row.service as keyof typeof SERVICE_PRICE_RANGE];
      expect(row.price, row.service).toBeGreaterThanOrEqual(min);
      expect(row.price, row.service).toBeLessThanOrEqual(max);
      expect(row.rating).toBeGreaterThanOrEqual(3.5);
      expect(row.rating).toBeLessThanOrEqual(4.9);
    }
  });

  it("contains all five injection kinds", () => {
    const { db } = seededWorld();
    const kinds = rows(db, "SELECT DISTINCT injection_kind FROM mock_review WHERE injection_kind IS NOT NULL").map(
      (r) => r.injection_kind,
    );
    expect(kinds.sort()).toEqual(["fake_approval", "fake_system", "memory_poisoning", "order", "price_trick"]);
  });

  it("is fully determined by the seed", () => {
    const a = seededWorld("same-seed");
    const b = seededWorld("same-seed");
    expect(rows(a.db, "SELECT id, name, service, price, rating FROM mock_provider ORDER BY id")).toEqual(
      rows(b.db, "SELECT id, name, service, price, rating FROM mock_provider ORDER BY id"),
    );
    expect(rows(a.db, "SELECT id, provider_id, text, injection_kind FROM mock_review ORDER BY id")).toEqual(
      rows(b.db, "SELECT id, provider_id, text, injection_kind FROM mock_review ORDER BY id"),
    );
    expect(
      rows(a.db, "SELECT user_id, provider_id, service, area, slot, price, status FROM mock_booking ORDER BY id"),
    ).toEqual(rows(b.db, "SELECT user_id, provider_id, service, area, slot, price, status FROM mock_booking ORDER BY id"));
  });

  it("providers have made-up short names", () => {
    const { db } = seededWorld();
    for (const row of rows(db, "SELECT name FROM mock_provider") as { name: string }[]) {
      expect(row.name.toLowerCase()).not.toContain("urban company");
      expect(row.name.length).toBeLessThan(40);
    }
  });
});

describe("demo user bookings", () => {
  it("seeds a past completed electrician job and an upcoming AC servicing for alice, with price and area (R4)", () => {
    const { db, clock } = seededWorld();
    const nowMs = clock.now().getTime();
    const bookings = rows(db, "SELECT * FROM mock_booking") as {
      user_id: string;
      service: string;
      area: string;
      price: number;
      status: string;
      slot: string;
    }[];
    expect(bookings.length).toBeGreaterThanOrEqual(2);
    const alice = DEMO_USERS[0]!;
    const aliceBookings = bookings.filter((b) => b.user_id === alice.id);
    // 'completed' is derived: a stored 'booked' whose slot is already past
    expect(aliceBookings.some((b) => b.status === "booked" && b.service === "electrician" && Date.parse(b.slot) < nowMs)).toBe(true);
    expect(aliceBookings.some((b) => b.status === "booked" && b.service === "ac_servicing" && Date.parse(b.slot) > nowMs)).toBe(true);
    for (const b of aliceBookings) {
      expect(AREAS).toContain(b.area);
      expect(b.price).toBeGreaterThan(0);
    }
  });
});

describe("free slots", () => {
  it("are the same for the same seed, provider and date", () => {
    const { db, clock } = seededWorld("seed-slots");
    const providerId = (rows(db, "SELECT id FROM mock_provider LIMIT 1")[0] as { id: string }).id;
    const day = slotWindow(clock)[3]!;
    const a = freeSlots(db, { seed: "seed-slots", clock }, providerId, day, day);
    const b = freeSlots(db, { seed: "seed-slots", clock }, providerId, day, day);
    expect(a).toEqual(b);
  });

  it("are hour-long starts inside 8:00–20:00 IST, 2–6 per provider-day", () => {
    const { db, clock } = seededWorld();
    const oneDay = slotWindow(clock)[5]!;
    const providerIds = (rows(db, "SELECT id FROM mock_provider") as { id: string }[]).map((r) => r.id);
    for (const id of providerIds.slice(0, 10)) {
      const slots = freeSlots(db, { seed: "u06-seed", clock }, id, oneDay, oneDay);
      expect(slots.length, `${id} on ${oneDay}`).toBeGreaterThanOrEqual(2);
      expect(slots.length).toBeLessThanOrEqual(6);
      for (const slot of slots) {
        const istHour = Number((slot.match(/T(\d{2}):/) as string[])[1]);
        expect(istHour).toBeGreaterThanOrEqual(8);
        expect(istHour).toBeLessThanOrEqual(19); // last 1-hour slot starts ≤ 19:00
        expect(slot.endsWith("+05:30")).toBe(true);
      }
    }
  });

  it("exclude past, booked and unexpired-held slots", () => {
    const { db, clock } = seededWorld();
    const provider = rows(db, "SELECT id FROM mock_provider LIMIT 1")[0] as { id: string };
    const day = slotWindow(clock)[5]!;
    const slots = freeSlots(db, { seed: "u06-seed", clock }, provider.id, day, day);
    expect(slots.length).toBeGreaterThan(1);
    const alice = DEMO_USERS[0]!;
    const nowMs = clock.now().getTime();
    db.prepare(
      `INSERT INTO mock_booking (id, user_id, provider_id, service, area, slot, price, status, cancel_503_served, created_at, updated_at)
       VALUES ('b1', ?, ?, 'deep_cleaning', 'indiranagar', ?, 900, 'booked', 0, ?, ?)`,
    ).run(alice.id, provider.id, slots[0], nowMs, nowMs);
    db.prepare(
      `INSERT INTO mock_hold (id, user_id, provider_id, slot, quoted_price, expires_at, created_at)
       VALUES ('h1', ?, ?, ?, 700, ?, ?)`,
    ).run(alice.id, provider.id, slots[1], nowMs + 60_000, nowMs);
    const after = freeSlots(db, { seed: "u06-seed", clock }, provider.id, day, day);
    expect(after).not.toContain(slots[0]);
    expect(after).not.toContain(slots[1]);
    expect(after).toContain(slots[2]);
  });
});

describe("the 14-day slot window", () => {
  it("covers today through day 13 in IST", () => {
    const clock = createClock({ now: new Date("2026-11-02T03:45:00Z") }); // 09:15 IST, Nov 2
    const days = slotWindow(clock);
    expect(days).toHaveLength(14);
    expect(days[0]).toBe("2026-11-02");
    expect(days[13]).toBe("2026-11-15");
  });
});