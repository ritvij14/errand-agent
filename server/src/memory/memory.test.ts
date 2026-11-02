import { describe, expect, it } from "vitest";
import { createClock } from "../shared/clock.js";
import { createTestDb } from "../shared/test-db.js";
import * as memory from "./index.js";

// The memory store (MH-6, 2.5.8): stated facts only from explicit lasting statements;
// forget keeps the row as a hidden marker; a user's rows are only theirs.

const t = () => {
  const testDb = createTestDb();
  const clock = createClock({ now: new Date("2026-11-02T03:45:00Z") });
  return { ...testDb, clock, now: clock.now().getTime() };
};

describe("the memory store", () => {
  it("saves a stated fact; the same key is corrected in place, not duplicated", () => {
    const db = t();
    const first = memory.saveStated(db.db, db.clock, "u1", "area", "hsr_layout");
    const second = memory.saveStated(db.db, db.clock, "u1", "area", "koramangala");
    expect(first).toMatchObject({ key: "area", value: "hsr_layout", source: "stated", status: "active" });
    expect(second!.id).toBe(first!.id);
    expect(second).toMatchObject({ value: "koramangala" });
    const rows = db.db.prepare(`SELECT id FROM memory_fact`).all();
    expect(rows).toHaveLength(1);
    db.close();
  });

  it("view lists active and awaiting facts, labelled; other users' facts stay theirs", () => {
    const db = t();
    memory.saveStated(db.db, db.clock, "u1", "area", "hsr_layout");
    memory.saveStated(db.db, db.clock, "u2", "area", "whitefield");
    expect(memory.view(db.db, "u1").map((f) => f.value)).toEqual(["hsr_layout"]);
    expect(memory.state(db.db, "u2", "area")?.value).toBe("whitefield");
    expect(memory.state(db.db, "u1", "earliest_time")).toBeUndefined();
    db.close();
  });

  it("forget hides the value but the row stays as a marker; stating again reactivates it", () => {
    const db = t();
    const fact = memory.saveStated(db.db, db.clock, "u1", "area", "hsr_layout")!;
    expect(memory.forget(db.db, db.clock, "u1", "area")).toMatchObject({ ok: true });
    expect(memory.state(db.db, "u1", "area")).toBeUndefined();
    const row = db.db.prepare(`SELECT * FROM memory_fact WHERE id = ?`).get(fact.id) as {
      status: string;
      value: string;
    };
    expect(row).toMatchObject({ status: "forgotten", value: "hsr_layout" });
    const again = memory.saveStated(db.db, db.clock, "u1", "area", "indiranagar");
    expect(again!.id).toBe(fact.id); // re-stating their choice reuses the row
    expect(again).toMatchObject({ status: "active", value: "indiranagar" });
    db.close();
  });

  it("blocksByForget: a value the user forgot is reported as blocked for inference (U33 uses this)", () => {
    const db = t();
    memory.saveStated(db.db, db.clock, "u1", "area", "hsr_layout");
    memory.forget(db.db, db.clock, "u1", "area");
    expect(memory.blockedByForget(db.db, "u1", "area", "hsr_layout")).toBe(true);
    expect(memory.blockedByForget(db.db, "u1", "area", "koramangala")).toBe(false);
    db.close();
  });

  it("forgetting what isn't there is a no-op, reported", () => {
    const db = t();
    expect(memory.forget(db.db, db.clock, "u1", "area")).toMatchObject({ ok: false });
    db.close();
  });
});
