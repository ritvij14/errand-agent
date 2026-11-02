import { randomUUID } from "node:crypto";
import type { Db } from "../shared/db.js";
import { randomDraw } from "../shared/random.js";
import type { MockSettings } from "./settings.js";
import type { ToolOpts, ToolResult } from "./read-tools.js";
import { freeSlots } from "./slots.js";

// The five write tools of the brief's contract (2.5.4): hold_slot, book,
// get_booking_status (here) — cancel and reschedule (U09). Every outcome is
// seed-drawn (seed | tool | key/inputs | attempt); a **forced queue** (evals:
// NFR-4, demo knob U37) is drawn first when present.

export type WriteOpts = ToolOpts & {
  settings: MockSettings;
  forced: ForcedQueue;
};

export type ForcedQueue = { take: (tool: string, nth: number) => { outcome: string } | undefined };

export const holdSlot = (
  db: Db,
  opts: WriteOpts,
  userId: string,
  args: { providerId: string; slot: string },
): ToolResult<{ holdId: string; slot: string; quotedPrice: number; expiresAt: number }> => {
  const { settings } = opts;
  const forced = forcedOutcome(opts, "hold_slot"); // "price_changed" | "slot_unavailable"
  const slotMs = Date.parse(args.slot);
  if (forced === "slot_unavailable" || Number.isNaN(slotMs) || slotMs <= opts.clock.now().getTime()) {
    return { ok: false, error: "slot_unavailable", transient: false };
  }
  if (!isFree(db, opts, args.providerId, args.slot)) {
    return { ok: false, error: "slot_unavailable", transient: false };
  }
  const provider = db.prepare(`SELECT price FROM mock_provider WHERE id = ?`).get(args.providerId) as
    { price: number } | undefined;
  if (!provider) return { ok: false, error: "not_found", transient: false };
  const attempt = nextAttempt(db, "hold_slot", `${args.providerId}|${args.slot}`);
  let quotedPrice = provider.price;
  if (forced === "price_changed") {
    quotedPrice = Math.round(provider.price * 1.1); // a visible change, inside the ±15% band
  } else if (
    randomDraw({ seed: opts.seed, tool: "hold_quote", inputs: [args.providerId, args.slot], attempt }) <
    settings.priceDiffProb
  ) {
    const drift = randomDraw({
      seed: opts.seed,
      tool: "hold_drift",
      inputs: [args.providerId, args.slot],
      attempt,
    });
    quotedPrice = Math.max(1, Math.round(provider.price * (1 + (drift * 2 - 1) * settings.priceDiffMax)));
  }
  const holdId = randomUUID();
  db.prepare(
    `INSERT INTO mock_hold (id, user_id, provider_id, slot, quoted_price, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    holdId,
    userId,
    args.providerId,
    args.slot,
    quotedPrice,
    opts.clock.now().getTime() + settings.holdExpiryMs,
    opts.clock.now().getTime(),
  );
  return {
    ok: true,
    data: {
      holdId,
      slot: args.slot,
      quotedPrice,
      expiresAt: opts.clock.now().getTime() + settings.holdExpiryMs,
    },
  };
};

export const book = (
  db: Db,
  opts: WriteOpts,
  userId: string,
  args: { holdId: string; idempotencyKey: string; testFaultAfterBookingWrite?: boolean },
): ToolResult<{ bookingId: string }> => {
  const { settings } = opts;
  // idempotency replay: the provider remembers each key's final result (but never
  // timeouts — those left nothing behind and stay retriable)
  const remembered = db
    .prepare(`SELECT final_result, booking_id FROM mock_idempotency WHERE key = ? AND tool = 'book'`)
    .get(args.idempotencyKey) as { final_result: string; booking_id: string | null } | undefined;
  if (remembered) {
    const parsed = JSON.parse(remembered.final_result) as { kind: string; bookingId?: string };
    if (parsed.kind === "booked") return { ok: true, data: { bookingId: parsed.bookingId! } };
    return { ok: false, error: parsed.kind, transient: false };
  }

  const hold = db.prepare(`SELECT * FROM mock_hold WHERE id = ?`).get(args.holdId) as
    | { user_id: string; provider_id: string; slot: string; quoted_price: number; expires_at: number }
    | undefined;
  const forced = hold ? forcedOutcome(opts, "book") : undefined; // "hold_expired" ages the hold out now
  if (forced === "hold_expired" && hold)
    db.prepare(`UPDATE mock_hold SET expires_at = ? WHERE id = ?`).run(
      opts.clock.now().getTime(),
      args.holdId,
    );
  if (
    !hold ||
    hold.user_id !== userId ||
    hold.expires_at <= opts.clock.now().getTime() ||
    forced === "hold_expired"
  ) {
    const expiry = rememberedFinal(db, opts, "book", userId, args.idempotencyKey, "hold_expired");
    return { ok: false, error: "hold_expired", transient: false, ...expiry };
  }

  const attempt = nextAttempt(db, "book", args.idempotencyKey);
  const outcome = forced ?? drawBookOutcome(opts, args.idempotencyKey, attempt);
  if (outcome === "timeout" || outcome === "timeout_booked") {
    opts.clock.advanceMs(settings.timeoutPauseMs); // the pause is on the clock (settings table)
  }
  if (outcome === "ok" || outcome === "timeout_booked") {
    const bookingId = randomUUID();
    const provider = db.prepare(`SELECT service FROM mock_provider WHERE id = ?`).get(hold.provider_id) as
      { service: string } | undefined;
    if (!provider) throw new Error(`hold ${args.holdId} points at a missing provider`);
    const area = (
      db
        .prepare(`SELECT area FROM mock_provider_area WHERE provider_id = ? ORDER BY area LIMIT 1`)
        .get(hold.provider_id) as { area: string }
    ).area; // reading (R4): the booking's area is the provider's primary (first) area
    db.transaction(() => {
      db.prepare(
        `INSERT INTO mock_booking (id, user_id, provider_id, service, area, slot, price, status, cancel_503_served, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'booked', 0, ?, ?)`,
      ).run(
        bookingId,
        userId,
        hold.provider_id,
        provider.service,
        area,
        hold.slot,
        hold.quoted_price,
        opts.clock.now().getTime(),
        opts.clock.now().getTime(),
      );
      if (args.testFaultAfterBookingWrite) throw new Error("simulated crash after booking write (R7 test)");
      db.prepare(
        `INSERT INTO mock_idempotency (key, user_id, tool, final_result, booking_id, created_at) VALUES (?, ?, 'book', ?, ?, ?)`,
      ).run(
        args.idempotencyKey,
        userId,
        JSON.stringify({ kind: "booked", bookingId }),
        bookingId,
        opts.clock.now().getTime(),
      );
    })();
    // the hold is consumed either way; a plain timeout still returns after the pause
    if (outcome === "timeout_booked") return { ok: false, error: "timeout", transient: true };
    db.prepare(`DELETE FROM mock_hold WHERE id = ?`).run(args.holdId);
    return { ok: true, data: { bookingId } };
  }
  if (outcome === "timeout") {
    return { ok: false, error: "timeout", transient: true };
  }
  if (outcome === "slot_taken") {
    db.transaction(() => {
      // someone else grabs the slot: it becomes booked for a non-agent user (I-1 is
      // scoped to agent-created bookings, per R10)
      const provider = db.prepare(`SELECT service FROM mock_provider WHERE id = ?`).get(hold.provider_id) as
        { service: string } | undefined;
      if (!provider) throw new Error(`hold ${args.holdId} points at a missing provider`);
      const area = (
        db
          .prepare(`SELECT area FROM mock_provider_area WHERE provider_id = ? ORDER BY area LIMIT 1`)
          .get(hold.provider_id) as { area: string }
      ).area;
      db.prepare(
        `INSERT INTO mock_booking (id, user_id, provider_id, service, area, slot, price, status, cancel_503_served, created_at, updated_at)
         VALUES (?, 'u-someone-else', ?, ?, ?, ?, ?, 'booked', 0, ?, ?)`,
      ).run(
        randomUUID(),
        hold.provider_id,
        provider.service,
        area,
        hold.slot,
        hold.quoted_price,
        opts.clock.now().getTime(),
        opts.clock.now().getTime(),
      );
      db.prepare(
        `INSERT INTO mock_idempotency (key, user_id, tool, final_result, booking_id, created_at) VALUES (?, ?, 'book', ?, NULL, ?)`,
      ).run(args.idempotencyKey, userId, JSON.stringify({ kind: "slot_taken" }), opts.clock.now().getTime());
    })();
    return { ok: false, error: "slot_taken", transient: false };
  }
  return { ok: false, error: "unknown_outcome", transient: false };
};

export const getBookingStatus = (
  db: Db,
  opts: WriteOpts,
  idempotencyKey: string,
): ToolResult<{ status: string; bookingId?: string }> => {
  void opts;
  const row = db
    .prepare(`SELECT final_result, booking_id FROM mock_idempotency WHERE key = ? AND tool = 'book'`)
    .get(idempotencyKey) as { final_result: string; booking_id: string | null } | undefined;
  if (!row) return { ok: true, data: { status: "not_found" } };
  const parsed = JSON.parse(row.final_result) as { kind: string; bookingId?: string };
  if (parsed.kind === "booked") return { ok: true, data: { status: "booked", bookingId: parsed.bookingId! } };
  return { ok: true, data: { status: "failed", bookingId: parsed.bookingId ?? undefined } };
};

// ——— helpers ———

const drawBookOutcome = (
  opts: WriteOpts,
  key: string,
  attempt: number,
): "ok" | "slot_taken" | "timeout" | "timeout_booked" => {
  const r = randomDraw({ seed: opts.seed, tool: "book", inputs: [key], attempt });
  if (r < opts.settings.okProb) return "ok";
  if (r < opts.settings.okProb + opts.settings.slotTakenProb) return "slot_taken";
  return randomDraw({ seed: opts.seed, tool: "book_timeout_kind", inputs: [key], attempt }) <
    opts.settings.timeoutBookedProb
    ? "timeout_booked"
    : "timeout";
};

const isFree = (db: Db, opts: WriteOpts, providerId: string, slot: string): boolean =>
  freeSlots(
    db,
    { seed: opts.seed, clock: opts.clock },
    providerId,
    slot.slice(0, 10),
    slot.slice(0, 10),
  ).includes(slot);

const nextAttempt = (db: Db, tool: string, callKey: string): number => {
  const row = db
    .prepare(`SELECT attempts FROM mock_attempt WHERE tool = ? AND call_key = ?`)
    .get(tool, callKey) as { attempts: number } | undefined;
  const attempt = row?.attempts ?? 0;
  db.prepare(
    `INSERT INTO mock_attempt (tool, call_key, attempts) VALUES (?, ?, ?)
     ON CONFLICT(tool, call_key) DO UPDATE SET attempts = attempts + 1`,
  ).run(tool, callKey, attempt);
  return attempt;
};

const forcedOutcome = (opts: WriteOpts, tool: string): string | undefined =>
  opts.forced.take(tool, callCount(tool, opts))?.outcome;

const callCounts = new WeakMap<WriteOpts, Map<string, number>>();
const callCount = (tool: string, opts: WriteOpts): number => {
  let counts = callCounts.get(opts);
  if (!counts) {
    counts = new Map();
    callCounts.set(opts, counts);
  }
  const n = counts.get(tool) ?? 0;
  counts.set(tool, n + 1);
  return n;
};

const rememberedFinal = (
  db: Db,
  opts: WriteOpts,
  tool: string,
  userId: string,
  key: string,
  finalKind: string,
): { nothing?: true } => {
  void opts;
  db.prepare(
    `INSERT INTO mock_idempotency (key, user_id, tool, final_result, booking_id, created_at) VALUES (?, ?, ?, ?, NULL, ?)`,
  ).run(key, userId, tool, JSON.stringify({ kind: finalKind }), opts.clock.now().getTime());
  return {};
};
// ——— cancel and reschedule (brief rows 7–8, U09) ———

export const cancel = (
  db: Db,
  opts: WriteOpts,
  userId: string,
  args: { bookingId: string; idempotencyKey: string; testFaultAfterWrite?: boolean },
): ToolResult<{ bookingId: string }> => {
  const booking = db.prepare(`SELECT id, user_id FROM mock_booking WHERE id = ?`).get(args.bookingId) as
    { id: string; user_id: string } | undefined;
  if (!booking || booking.user_id !== userId) return { ok: false, error: "not_found", transient: false };

  const remembered = db
    .prepare(`SELECT final_result FROM mock_idempotency WHERE key = ? AND tool = 'cancel'`)
    .get(args.idempotencyKey) as { final_result: string } | undefined;
  if (remembered) return { ok: true, data: { bookingId: args.bookingId } }; // already cancelled for this key

  const served = db
    .prepare(`SELECT cancel_503_served FROM mock_booking WHERE id = ?`)
    .get(args.bookingId) as { cancel_503_served: number };
  if (served.cancel_503_served === 0) {
    db.prepare(`UPDATE mock_booking SET cancel_503_served = 1, updated_at = ? WHERE id = ?`).run(
      opts.clock.now().getTime(),
      args.bookingId,
    );
    return { ok: false, error: "glitch", transient: true }; // the designed first-call 503 (V-8)
  }
  db.transaction(() => {
    db.prepare(`UPDATE mock_booking SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(
      opts.clock.now().getTime(),
      args.bookingId,
    );
    if (args.testFaultAfterWrite) throw new Error("simulated crash after cancel write (R7 test)");
    db.prepare(
      `INSERT INTO mock_idempotency (key, user_id, tool, final_result, booking_id, created_at) VALUES (?, ?, 'cancel', ?, ?, ?)`,
    ).run(
      args.idempotencyKey,
      userId,
      JSON.stringify({ kind: "cancelled" }),
      args.bookingId,
      opts.clock.now().getTime(),
    );
  })();
  return { ok: true, data: { bookingId: args.bookingId } };
};

export const reschedule = (
  db: Db,
  opts: WriteOpts,
  userId: string,
  args: { bookingId: string; newSlot: string; idempotencyKey: string; testFaultAfterWrite?: boolean },
): ToolResult<{ booking: { id: string; slot: string; price: number; status: string } }> => {
  const booking = db.prepare(`SELECT * FROM mock_booking WHERE id = ?`).get(args.bookingId) as
    (BookedRow & { user_id: string }) | undefined;
  if (!booking || booking.user_id !== userId) return { ok: false, error: "not_found", transient: false };

  const remembered = db
    .prepare(`SELECT final_result FROM mock_idempotency WHERE key = ? AND tool = 'reschedule'`)
    .get(args.idempotencyKey) as { final_result: string } | undefined;
  if (remembered) {
    const parsed = JSON.parse(remembered.final_result) as { kind: string };
    if (parsed.kind === "rescheduled") return shape(booking);
    return { ok: false, error: "slot_conflict", transient: false };
  }

  // free-slot check with the same seed math searches use (V-3); then the seeded
  // slot_conflict probability (~10%) on top
  const isFree = freeSlots(
    db,
    { seed: opts.seed, clock: opts.clock },
    booking.provider_id,
    args.newSlot.slice(0, 10),
    args.newSlot.slice(0, 10),
  ).includes(args.newSlot);
  const attempt = nextAttempt(db, "reschedule", args.idempotencyKey);
  const conflict =
    !isFree ||
    randomDraw({
      seed: opts.seed,
      tool: "reschedule_conflict",
      inputs: [booking.provider_id, args.newSlot],
      attempt,
    }) < opts.settings.slotConflictProb;
  if (conflict) {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO mock_idempotency (key, user_id, tool, final_result, booking_id, created_at) VALUES (?, ?, 'reschedule', ?, ?, ?)`,
      ).run(
        args.idempotencyKey,
        userId,
        JSON.stringify({ kind: "slot_conflict" }),
        args.bookingId,
        opts.clock.now().getTime(),
      );
    })();
    return { ok: false, error: "slot_conflict", transient: false };
  }

  db.transaction(() => {
    db.prepare(`UPDATE mock_booking SET slot = ?, updated_at = ? WHERE id = ?`).run(
      args.newSlot,
      opts.clock.now().getTime(),
      args.bookingId,
    );
    if (args.testFaultAfterWrite) throw new Error("simulated crash after reschedule write (R7 test)");
    db.prepare(
      `INSERT INTO mock_idempotency (key, user_id, tool, final_result, booking_id, created_at) VALUES (?, ?, 'reschedule', ?, ?, ?)`,
    ).run(
      args.idempotencyKey,
      userId,
      JSON.stringify({ kind: "rescheduled" }),
      args.bookingId,
      opts.clock.now().getTime(),
    );
  })();
  const fresh = db.prepare(`SELECT * FROM mock_booking WHERE id = ?`).get(args.bookingId) as BookedRow;
  return shape(fresh);
};

type BookedRow = {
  id: string;
  user_id: string;
  provider_id: string;
  service: string;
  area: string;
  slot: string;
  price: number;
  status: string;
};

const shape = (
  b: BookedRow,
): ToolResult<{ booking: { id: string; slot: string; price: number; status: string } }> => ({
  ok: true,
  data: { booking: { id: b.id, slot: b.slot, price: b.price, status: b.status } },
});
