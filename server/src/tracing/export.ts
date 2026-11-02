import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../shared/db.js";
import { readTrace } from "./tracing.js";

// Deliverable 5 (2.5.9): one run's trace, exported to a raw JSON file — the full event
// list exactly as stored, nothing added and nothing dropped.

export type ExportedTrace = {
  run: {
    id: string;
    conversationId: string;
    trigger: string;
    startedAt: number;
    endedAt: number | null;
    outcome: string | null;
    modelCalls: number;
    toolCalls: number;
  };
  events: {
    seq: number;
    type: string;
    clockAt: number;
    durationMs: number | null;
    data: Record<string, unknown>;
  }[];
};

/** The run row + its ordered events; undefined when the run doesn't exist. */
export const exportTrace = (db: Db, runId: string): ExportedTrace | undefined => {
  const run = db
    .prepare(
      `SELECT id, conversation_id, trigger, started_at, ended_at, outcome, model_calls, tool_calls FROM run WHERE id = ?`,
    )
    .get(runId) as
    | {
        id: string;
        conversation_id: string;
        trigger: string;
        started_at: number;
        ended_at: number | null;
        outcome: string | null;
        model_calls: number;
        tool_calls: number;
      }
    | undefined;
  if (!run) return undefined;
  const events = readTrace(db, runId).map((e) => ({
    seq: e.seq,
    type: e.type,
    clockAt: e.clockAt,
    durationMs: e.durationMs,
    data: e.data,
  }));
  return {
    run: {
      id: run.id,
      conversationId: run.conversation_id,
      trigger: run.trigger,
      startedAt: run.started_at,
      endedAt: run.ended_at,
      outcome: run.outcome,
      modelCalls: run.model_calls,
      toolCalls: run.tool_calls,
    },
    events,
  };
};

/** Deliverable 5: `traces/<run id>.json`. Returns the written path. */
export const writeTraceFile = (dir: string, runId: string, exported: ExportedTrace): string => {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${runId}.json`);
  writeFileSync(path, `${JSON.stringify(exported, null, 2)}\n`);
  return path;
};
