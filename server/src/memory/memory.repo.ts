import { randomUUID } from "node:crypto";
import type { Db } from "../shared/db.js";
import type { Clock } from "../shared/clock.js";

// Memory facts (MH-6, 2.5.8). Stated facts come only from explicit lasting statements
// ("I live in HSR", "never before 10"); a one-off request detail never lands here. Only
// this module touches `memory_fact`; chat and the panel (U34) both go through it.

export type MemoryFactRecord = {
  id: string;
  key: string;
  service: string | null;
  value: string;
  source: "stated" | "inferred";
  status: "active" | "awaiting_confirmation" | "forgotten";
  /** why the fact was inferred, naming the bookings (2.5.8) */
  evidence?: string | null;
};

const decode = (row: Record<string, unknown>): MemoryFactRecord => ({
  id: row.id as string,
  key: row.key as string,
  service: (row.service as string | null) ?? null,
  value: row.value as string,
  source: row.source as MemoryFactRecord["source"],
  status: row.status as MemoryFactRecord["status"],
  evidence: (row.evidence as string | null) ?? null,
});

// `service` only narrows `preferred_provider`; other keys are one per user.
const findAny = (
  db: Db,
  userId: string,
  key: string,
  service: string | null,
): MemoryFactRecord | undefined => {
  const row = db
    .prepare(
      `SELECT * FROM memory_fact WHERE user_id = ? AND key = ? AND (key <> 'preferred_provider' OR ? IS NULL OR service = ?) ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(userId, key, service ?? null, service ?? null) as Record<string, unknown> | undefined;
  return row ? decode(row) : undefined;
};

/** The user's active fact for a key (never an awaiting or forgotten one). */
export const state = (
  db: Db,
  userId: string,
  key: string,
  service?: string,
): MemoryFactRecord | undefined => {
  const row = db
    .prepare(
      `SELECT * FROM memory_fact WHERE user_id = ? AND key = ? AND (key <> 'preferred_provider' OR ? IS NULL OR service = ?) AND status = 'active' LIMIT 1`,
    )
    .get(userId, key, service ?? null, service ?? null) as Record<string, unknown> | undefined;
  return row ? decode(row) : undefined;
};

/** Everything the user can see: active and awaiting records. */
export const view = (db: Db, userId: string): MemoryFactRecord[] =>
  (
    db
      .prepare(
        `SELECT * FROM memory_fact WHERE user_id = ? AND status IN ('active','awaiting_confirmation') ORDER BY key, updated_at`,
      )
      .all(userId) as Record<string, unknown>[]
  ).map(decode);

/**
 * A stated fact: save, or correct in place when one exists (even a forgotten one —
 * the user stating it again is their choice, 2.5.8).
 */
export const saveStated = (
  db: Db,
  clock: Clock,
  userId: string,
  key: string,
  value: string,
  service: string | null = null,
  trace?: (event: "stated" | "corrected", record: MemoryFactRecord) => void,
): MemoryFactRecord | undefined => {
  const now = clock.now().getTime();
  const existing = findAny(db, userId, key, service);
  const id = existing?.id ?? `mf-${randomUUID()}`;
  const corrected = (existing?.status ?? "") === "active" && existing?.value !== value;
  db.prepare(
    `INSERT INTO memory_fact (id, user_id, key, service, value, source, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'stated', 'active', ?, ?)
       ON CONFLICT(id) DO UPDATE SET value = excluded.value, status = 'active', updated_at = excluded.updated_at, forgotten_at = NULL`,
  ).run(id, userId, key, service, value, now, now);
  const row = db.prepare(`SELECT * FROM memory_fact WHERE id = ?`).get(id) as Record<string, unknown>;
  const record = decode(row);
  trace?.(corrected ? "corrected" : "stated", record);
  return record;
};

export const forget = (
  db: Db,
  clock: Clock,
  userId: string,
  key: string,
  service?: string,
  trace?: (record: MemoryFactRecord) => void,
): { ok: boolean } => {
  const existing = state(db, userId, key, service);
  if (!existing) return { ok: false };
  const now = clock.now().getTime();
  db.prepare(
    `UPDATE memory_fact SET status = 'forgotten', forgotten_at = ?, updated_at = ? WHERE id = ?`,
  ).run(now, now, existing.id);
  const row = db.prepare(`SELECT * FROM memory_fact WHERE id = ?`).get(existing.id) as Record<
    string,
    unknown
  >;
  trace?.(decode(row));
  return { ok: true };
};

/** The forgotten marker: this exact key+value must never be inferred again (2.5.8). */
export const blockedByForget = (db: Db, userId: string, key: string, value: string): boolean => {
  const row = db
    .prepare(
      `SELECT id FROM memory_fact WHERE user_id = ? AND key = ? AND value = ? AND status = 'forgotten' LIMIT 1`,
    )
    .get(userId, key, value);
  return row !== undefined;
};

/**
 * An inferred fact (U33): the same value seen in 2 completed bookings (or "same as last
 * time"). Created as `awaiting_confirmation` with evidence naming the bookings, never
 * used before the user confirms; a forgotten value is never inferred again; an already
 * active fact for the key makes the proposal pointless.
 */
export const inferCandidate = (
  db: Db,
  clock: Clock,
  userId: string,
  key: string,
  value: string,
  service: string | null,
  evidence: string,
  trace?: (event: "inferred" | "blocked-by-forget", record: { key: string; value: string }) => void,
): {
  created: boolean;
  note?: "blocked" | "already-awaiting" | "already-active";
  fact?: MemoryFactRecord;
} => {
  const active = state(db, userId, key, service ?? undefined);
  if (active) return { created: false, note: "already-active" };
  if (blockedByForget(db, userId, key, value)) {
    trace?.("blocked-by-forget", { key, value });
    return { created: false, note: "blocked" };
  }
  const existing = db
    .prepare(
      `SELECT * FROM memory_fact WHERE user_id = ? AND key = ? AND value = ? AND status = 'awaiting_confirmation' LIMIT 1`,
    )
    .get(userId, key, value) as Record<string, unknown> | undefined;
  if (existing) return { created: false, note: "already-awaiting", fact: decode(existing) };
  const now = clock.now().getTime();
  const id = `mf-${randomUUID()}`;
  db.prepare(
    `INSERT INTO memory_fact (id, user_id, key, service, value, source, status, evidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'inferred', 'awaiting_confirmation', ?, ?, ?)`,
  ).run(id, userId, key, service, value, evidence, now, now);
  const row = db.prepare(`SELECT * FROM memory_fact WHERE id = ?`).get(id) as Record<string, unknown>;
  const fact = decode(row);
  trace?.("inferred", { key, value });
  return { created: true, fact };
};

/** The user says yes (2.5.8): the fact becomes active; `source` stays honest. */
export const confirm = (
  db: Db,
  clock: Clock,
  userId: string,
  factId: string,
  trace?: (record: MemoryFactRecord) => void,
): MemoryFactRecord | undefined => {
  const now = clock.now().getTime();
  db.prepare(
    `UPDATE memory_fact SET status = 'active', confirmed_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'awaiting_confirmation'`,
  ).run(now, now, factId, userId);
  const row = db.prepare(`SELECT * FROM memory_fact WHERE id = ?`).get(factId) as
    Record<string, unknown> | undefined;
  if (!row) return undefined;
  const record = decode(row);
  trace?.(record);
  return record;
};

/** The user says no: the fact is forgotten — and its value can never be inferred again. */
export const reject = (
  db: Db,
  clock: Clock,
  userId: string,
  factId: string,
  trace?: (record: MemoryFactRecord) => void,
): MemoryFactRecord | undefined => {
  const now = clock.now().getTime();
  db.prepare(
    `UPDATE memory_fact SET status = 'forgotten', forgotten_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'awaiting_confirmation'`,
  ).run(now, now, factId, userId);
  const row = db.prepare(`SELECT * FROM memory_fact WHERE id = ?`).get(factId) as
    Record<string, unknown> | undefined;
  if (!row) return undefined;
  const record = decode(row);
  trace?.(record);
  return record;
};
