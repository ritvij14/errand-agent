import { randomUUID } from "node:crypto";
import type { Db } from "../shared/db.js";
import { createClock } from "../shared/clock.js";
import { DEMO_USERS } from "../shared/demo-users.js";
import { createConversationService } from "../conversations/index.js";
import { scriptedModel } from "../agent/index.js";

// The scenario runner (§ 2.5.10): each scenario gets its own fresh database, a fixed
// seed and clock, the scripted model, and a conversation bound to one user. The runner
// checks the invariants over stored state after every step.

export type EvalScenarioStep =
  | { step: "say"; text: string }
  | { step: "advance"; ms: number }
  | { step: "send_concurrently"; text: string }
  | { step: "expect"; outcome?: string; replyContains?: string }
  | { step: "click"; decision: "approve" | "decline" };

export type EvalScenario = {
  id: string;
  name: string;
  description: string;
  seed: string;
  steps: EvalScenarioStep[];
};

export type ScenarioResult = {
  id: string;
  name: string;
  expected: string;
  actual: string;
  pass: boolean;
  notes: string;
  checkedInvariants: string[];
  firstFailure: string | null;
};

const CAPS = { modelCalls: 6, toolCalls: 10, elapsedMs: 60_000 } as const;

export const describeSteps = (steps: EvalScenarioStep[]): string =>
  steps
    .map((s) => {
      if (s.step === "say") return `say: "${s.text}"`;
      if (s.step === "advance") return `advance ${s.ms} ms`;
      if (s.step === "expect") return `expect ${JSON.stringify({ outcome: s.outcome, replyContains: s.replyContains })}`;
      return s.step;
    })
    .join(" → ");

export const runScenario = async (db: Db, scenario: EvalScenario, userId: string): Promise<ScenarioResult> => {
  const clock = createClock({ now: new Date("2026-11-02T03:45:00Z") });
  const service = createConversationService({ db, clock, model: scriptedModel });
  const conversationId = service.createConversation(userId).id;
  let firstFailure: string | null = null;
  let lastReply: string | null = null;
  let lastOutcome: string | null = null;

  for (const step of scenario.steps) {
    if (step.step === "say" || step.step === "send_concurrently") {
      const result = await service.sendMessage(userId, conversationId, step.text, randomUUID());
      if (!result.ok) {
        if (step.step === "send_concurrently" && result.code === "CONVERSATION_BUSY") {
          lastOutcome = result.code;
        } else {
          recordFailure(`${step.step} "${step.text}" → ${result.code}: ${result.message}`);
        }
      } else {
        lastReply = result.reply.message.text;
        lastOutcome = result.reply.outcome;
      }
    } else if (step.step === "advance" as const) {
      clock.advanceMs((step as { ms: number }).ms);
    } else if (step.step === "expect") {
      if (step.outcome && lastOutcome !== step.outcome) recordFailure(`expect outcome ${step.outcome} → got ${lastOutcome ?? "none"}`);
      if (step.replyContains && !(lastReply ?? "").includes(step.replyContains)) {
        recordFailure(`expect reply containing "${step.replyContains}" → got "${(lastReply ?? "").slice(0, 120)}"`);
      }
    } else if (step.step === "click") {
      recordFailure("click: approval cards don't exist in the skeleton (U19+)");
    }
    // invariants over stored state after every step; a violation fails the scenario
    if (!firstFailure) {
      const violation = checkInvariants(db, CAPS);
      if (violation) recordFailure(violation);
    }
  }

  return {
    id: scenario.id,
    name: scenario.name,
    expected: describeSteps(scenario.steps),
    actual: firstFailure ? "FAILED" : `lastOutcome=${lastOutcome ?? "none"}`,
    pass: !firstFailure,
    notes: firstFailure ?? "invariants I-4, I-5, I-9 checked after every step",
    checkedInvariants: ["I-4", "I-5", "I-9"],
    firstFailure,
  };

  function recordFailure(message: string) {
    firstFailure ??= message;
  }
};

// Invariants over stored state (§ 2.5.10), starting with I-4, I-5, I-9.
export const checkInvariants = (db: Db, caps: { modelCalls: number; toolCalls: number; elapsedMs: number }): string | null => {
  for (const run of db.prepare(`SELECT * FROM run`).all() as {
    id: string;
    outcome: string | null;
    ended_at: number | null;
    model_calls: number;
    tool_calls: number;
    started_at: number;
  }[]) {
    if (run.ended_at !== null) {
      if (!run.outcome) return `I-5: run ${run.id} ended without an outcome`;
      if (run.model_calls > caps.modelCalls) return `I-4: run ${run.id} used ${run.model_calls} model calls (cap ${caps.modelCalls})`;
      if (run.tool_calls > caps.toolCalls) return `I-4: run ${run.id} used ${run.tool_calls} tool calls (cap ${caps.toolCalls})`;
      if (run.ended_at - run.started_at > caps.elapsedMs) return `I-4: run ${run.id} took ${run.ended_at - run.started_at} ms (cap ${caps.elapsedMs})`;
      const agent = db.prepare(`SELECT COUNT(*) c FROM message WHERE run_id = ? AND role = 'agent' AND trim(text) <> ''`).get(run.id) as { c: number };
      if (agent.c === 0) return `I-5: run ${run.id} ended without an agent reply`;
    }
  }
  for (const event of db.prepare(`SELECT run_id, seq, data FROM trace_event`).all() as { run_id: string; seq: number; data: string }[]) {
    for (const user of DEMO_USERS) {
      if (event.data.includes(user.password)) return `I-9: trace event ${event.run_id}#${event.seq} contains a password`;
    }
    if (/session=|cookie/i.test(event.data)) return `I-9: trace event ${event.run_id}#${event.seq} contains a cookie`;
  }
  return null;
};