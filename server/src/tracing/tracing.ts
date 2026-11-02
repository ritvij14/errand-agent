import type { Db } from "../shared/db.js";
import type { Clock } from "../shared/clock.js";

// Traces (MH-7, § 2.5.9): one ordered event list per run. Each event type has an
// allow-list — the trace code itself drops any other field, so a password, token or
// cookie can never slip in by construction.

export const TRACE_EVENT_FIELDS: Record<string, string[]> = {
  run_started: ["trigger", "conversationId", "userId", "phase"],
  model_call: ["job", "input", "output", "durationMs", "tokens", "cost", "notAvailable"],
  state_transition: ["fromPhase", "toPhase", "reason"],
  fact_changed: ["key", "oldValue", "newValue", "source", "isCorrection"],
  tool_call: [
    "tool",
    "args",
    "attempt",
    "idempotencyKey",
    "ok",
    "errorCode",
    "transient",
    "result",
    "durationMs",
    "suspectedInjection",
  ],
  approval_event: ["event", "via", "action", "providerId", "slot", "price", "voidReason", "approvalId"],
  operation_event: ["event", "kind", "key", "result"],
  memory_event: ["event", "key", "value", "service"],
  limit_hit: ["cap", "modelCalls", "toolCalls", "elapsedMs"],
  error: ["code", "internalDetails"],
  run_ended: ["outcome", "modelCalls", "toolCalls", "durationMs"],
};

export type TraceEvent = {
  seq: number;
  type: string;
  clockAt: number;
  durationMs: number | null;
  data: Record<string, unknown>;
};

export type Trace = { record: (type: string, data: Record<string, unknown>, durationMs?: number) => void };

export const startTrace = (db: Db, clock: Clock, runId: string): Trace => {
  let seq = 0;
  const insert = db.prepare(
    `INSERT INTO trace_event (run_id, seq, type, clock_at, duration_ms, data) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  return {
    record: (type, data, durationMs) => {
      const allowed = TRACE_EVENT_FIELDS[type];
      if (!allowed) throw new Error(`unknown trace event type: ${type}`);
      const filtered: Record<string, unknown> = {};
      for (const key of allowed) {
        if (key in data) filtered[key] = data[key];
      }
      if (type === "model_call") {
        if (!("tokens" in data)) filtered.tokens = null;
        if (!("cost" in data)) filtered.cost = null;
        filtered.notAvailable = "scripted model";
      }
      seq += 1;
      insert.run(runId, seq, type, clock.now().getTime(), durationMs ?? null, JSON.stringify(filtered));
    },
  };
};

export const readTrace = (db: Db, runId: string): TraceEvent[] =>
  (
    db
      .prepare(`SELECT seq, type, clock_at, duration_ms, data FROM trace_event WHERE run_id = ? ORDER BY seq`)
      .all(runId) as {
      seq: number;
      type: string;
      clock_at: number;
      duration_ms: number | null;
      data: string;
    }[]
  ).map((row) => ({
    seq: row.seq,
    type: row.type,
    clockAt: row.clock_at,
    durationMs: row.duration_ms,
    data: JSON.parse(row.data) as Record<string, unknown>,
  }));
