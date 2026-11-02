import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { demoForcedQueue } from "./tools/index.js";
import { DEMO_USERS } from "./shared/demo-users.js";
import { createClock } from "./shared/clock.js";
import { openAppDatabase, resetDatabase } from "./setup.js";
import type { Db } from "./shared/db.js";

describe("dev-only forced-outcome knob (2.5.4, R12)", () => {
  it("forces nothing when DEMO_FORCE is not set", () => {
    const forced = demoForcedQueue(undefined);
    expect(forced.take("book", 1)).toBeUndefined();
    expect(forced.take("hold_slot", 1)).toBeUndefined();
  });

  it("forces the next call of the named tool once, then draws normally again", () => {
    const forced = demoForcedQueue("book=timeout_booked");
    expect(forced.take("hold_slot", 1)).toBeUndefined();
    expect(forced.take("book", 1)).toEqual({ outcome: "timeout_booked" });
    expect(forced.take("book", 2)).toBeUndefined();
  });

  it("queues several tools from a comma-separated list", () => {
    const forced = demoForcedQueue("hold_slot=price_changed, book=timeout");
    expect(forced.take("book", 1)).toEqual({ outcome: "timeout" });
    expect(forced.take("hold_slot", 1)).toEqual({ outcome: "price_changed" });
  });
});

describe("npm run reset", () => {
  let db: Db | undefined;
  afterEach(() => db?.close());

  it("wipes everything and leaves a seeded world plus the demo users", () => {
    const path = join(mkdtempSync(join(tmpdir(), "errand-reset-")), "errand.db");
    const clock = createClock();
    const before = openAppDatabase(path, clock);
    before
      .prepare(`INSERT INTO user (id, username, password_hash, created_at) VALUES ('u-x', 'mallory', 'h', 0)`)
      .run();
    before.prepare(`DELETE FROM mock_booking`).run();
    before.close();

    resetDatabase(path, clock);

    db = openAppDatabase(path, clock);
    const users = db.prepare(`SELECT username FROM user ORDER BY username`).all() as { username: string }[];
    expect(users.map((u) => u.username)).toEqual(DEMO_USERS.map((u) => u.username).sort());
    expect((db.prepare(`SELECT COUNT(*) AS c FROM mock_provider`).get() as { c: number }).c).toBeGreaterThan(
      0,
    );
    expect((db.prepare(`SELECT COUNT(*) AS c FROM mock_booking`).get() as { c: number }).c).toBeGreaterThan(
      0,
    );
  });
});
