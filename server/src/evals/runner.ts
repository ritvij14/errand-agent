import { randomUUID } from "node:crypto";
import type { Db } from "../shared/db.js";
import { createClock } from "../shared/clock.js";
import { DEMO_USERS } from "../shared/demo-users.js";
import { createConversationService } from "../conversations/index.js";
import { scriptedModel } from "../agent/index.js";
import { seedMockWorld, type ForcedQueue } from "../tools/index.js";

// The scenario runner (§ 2.5.10): each scenario gets its own fresh database, a fixed
// seed and clock, the scripted model, and a conversation bound to one user. The runner
// checks the invariants over stored state after every step.

export type EvalScenarioStep =
  | { step: "say"; text: string }
  | { step: "advance"; ms: number }
  /** send this text while the NEXT step's run is still in progress (tests CONVERSATION_BUSY) */
  | { step: "send_concurrently"; text: string }
  /** drop everything held in memory, start a fresh service on the same database, run startup recovery */
  | { step: "restart" }
  /** queue a forced outcome for the next call of a mock tool (NFR-4) */
  | { step: "force"; tool: string; outcome: string }
  /** tap a slot and press Confirm: sends that slot's pickText, as the page does (ADR-007) */
  | { step: "pick"; block?: number; slot?: number }
  | {
      step: "expect";
      outcome?: string;
      replyContains?: string;
      replyNotContains?: string;
      phase?: string;
      /** fact values on the workflow, compared exactly */
      facts?: Record<string, unknown>;
      /** the last reply's option blocks: present, and every provider price at most this */
      optionsPriceAtMost?: number;
      /** the last reply's approval card equals the stored approval record (§ 2.5.5) */
      cardMatchesApproval?: boolean;
      /** the card's price differs from the picked option's search price (V-2) */
      cardPriceDiffersFromSearch?: boolean;
      /** provider-side bookings this user's runs created (seeded history excluded) */
      agentBookings?: number;
      /** the last run's tool calls, in order, as "tool:result" (e.g. "book:timeout", "get_booking_status:booked") */
      lastRunToolCalls?: string[];
    }
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
      if (s.step === "force") return `force ${s.tool}=${s.outcome}`;
      if (s.step === "pick") return `pick block ${s.block ?? 0} slot ${s.slot ?? 0}`;
      if (s.step === "click") return `click ${s.decision}`;
      if (s.step === "expect") {
        return `expect ${JSON.stringify({ ...s, step: undefined })}`;
      }
      return s.step;
    })
    .join(" → ");

export const runScenario = async (
  db: Db,
  scenario: EvalScenario,
  userId: string,
): Promise<ScenarioResult> => {
  const clock = createClock({ now: new Date("2026-11-02T03:45:00Z") });
  seedMockWorld(db, { seed: scenario.seed, clock });
  const queued: { tool: string; outcome: string }[] = [];
  const forced: ForcedQueue = {
    take: (tool) => {
      const i = queued.findIndex((q) => q.tool === tool);
      return i === -1 ? undefined : { outcome: queued.splice(i, 1)[0]!.outcome };
    },
  };
  const start = () =>
    createConversationService({ db, clock, model: scriptedModel, mock: { seed: scenario.seed, forced } });
  let service = start();
  const conversationId = service.createConversation(userId).id;
  let firstFailure: string | null = null;
  let lastReply: string | null = null;
  let lastParts: Record<string, unknown>[] = [];
  let lastOutcome: string | null = null;
  let lastRunId: string | null = null;
  /** the newest approval card shown — its buttons stay on screen after later replies */
  let lastCardId: string | null = null;
  let pickedSearchPrice: number | null = null;

  const keep = (
    result: Awaited<ReturnType<typeof service.decideApproval>>,
    label: string,
    busyOk = false,
  ): void => {
    if (!result.ok) {
      if (busyOk && result.code === "CONVERSATION_BUSY") lastOutcome = result.code;
      else recordFailure(`${label} → ${result.code}: ${result.message}`);
      return;
    }
    lastReply = result.reply.message.text;
    lastParts = result.reply.message.parts;
    lastOutcome = result.reply.outcome;
    lastRunId = result.reply.runId;
    const card = result.reply.message.parts.find((p) => p.type === "approval_card") as
      { approvalId: string } | undefined;
    if (card) lastCardId = card.approvalId;
  };
  /** a `send_concurrently` text waiting to go out while the next step's run is in progress */
  let concurrent: string | null = null;
  const act = async (
    label: string,
    start: () => Promise<Awaited<ReturnType<typeof service.sendMessage>>>,
  ): Promise<void> => {
    const main = start(); // runs up to its first await, so its run already holds the conversation
    const sideText = concurrent;
    concurrent = null;
    const side =
      sideText === null ? undefined : service.sendMessage(userId, conversationId, sideText, randomUUID());
    try {
      keep(await main, label);
    } catch (error) {
      // a forced `server_crash_*` outcome: the run dies mid-call, like a killed process
      if (!(error instanceof Error && error.message.startsWith("simulated server crash"))) throw error;
      lastOutcome = "server_crashed";
    }
    if (side) keep(await side, `send_concurrently "${sideText}"`, true);
  };
  const send = (label: string, text: string): Promise<void> =>
    act(`${label} "${text}"`, () => service.sendMessage(userId, conversationId, text, randomUUID()));
  const toolCallsOf = (runId: string | null): string[] =>
    (runId
      ? (db
          .prepare(`SELECT data FROM trace_event WHERE run_id = ? AND type = 'tool_call' ORDER BY seq`)
          .all(runId) as { data: string }[])
      : []
    ).map(({ data }) => {
      const call = JSON.parse(data) as { tool: string; errorCode: string | null; result?: string };
      if (call.errorCode) return `${call.tool}:${call.errorCode}`;
      if (call.tool === "get_booking_status")
        return `${call.tool}:${(JSON.parse(call.result ?? "{}") as { status?: string }).status}`;
      return `${call.tool}:ok`;
    });
  const partOf = (type: string) => lastParts.find((p) => p.type === type);

  for (const step of scenario.steps) {
    if (step.step === "say") {
      await send(step.step, step.text);
    } else if (step.step === "send_concurrently") {
      concurrent = step.text;
    } else if (step.step === "restart") {
      service = start();
      await service.recoverInFlight();
      const run = db
        .prepare(
          `SELECT id, outcome FROM run WHERE conversation_id = ? AND trigger = 'recovery' ORDER BY started_at DESC, rowid DESC LIMIT 1`,
        )
        .get(conversationId) as { id: string; outcome: string } | undefined;
      const message = run
        ? (db.prepare(`SELECT text, parts FROM message WHERE run_id = ? AND role = 'agent'`).get(run.id) as {
            text: string;
            parts: string;
          })
        : undefined;
      if (!run || !message) recordFailure("restart → no recovery run");
      else {
        lastReply = message.text;
        lastParts = JSON.parse(message.parts) as Record<string, unknown>[];
        lastOutcome = run.outcome;
        lastRunId = run.id;
        const card = lastParts.find((p) => p.type === "approval_card") as { approvalId: string } | undefined;
        if (card) lastCardId = card.approvalId;
      }
    } else if (step.step === "force") {
      queued.push({ tool: step.tool, outcome: step.outcome });
    } else if (step.step === "pick") {
      const blocks = partOf("option_blocks")?.blocks as
        { provider: { price: number }; slots: { pickText: string }[] }[] | undefined;
      const block = blocks?.[step.block ?? 0];
      const slot = block?.slots[step.slot ?? 0];
      if (!block || !slot) recordFailure("pick → no such option on screen");
      else {
        pickedSearchPrice = block.provider.price;
        await send("pick", slot.pickText);
      }
    } else if (step.step === ("advance" as const)) {
      clock.advanceMs((step as { ms: number }).ms);
    } else if (step.step === "expect") {
      if (step.outcome && lastOutcome !== step.outcome)
        recordFailure(`expect outcome ${step.outcome} → got ${lastOutcome ?? "none"}`);
      if (step.replyContains && !(lastReply ?? "").includes(step.replyContains)) {
        recordFailure(
          `expect reply containing "${step.replyContains}" → got "${(lastReply ?? "").slice(0, 120)}"`,
        );
      }
      if (
        step.replyNotContains &&
        (lastReply ?? "").toLowerCase().includes(step.replyNotContains.toLowerCase())
      ) {
        recordFailure(
          `expect reply NOT containing "${step.replyNotContains}" → got "${(lastReply ?? "").slice(0, 120)}"`,
        );
      }
      if (step.phase) {
        const row = db
          .prepare(`SELECT phase FROM workflow WHERE conversation_id = ? ORDER BY updated_at DESC LIMIT 1`)
          .get(conversationId) as { phase: string } | undefined;
        if (row?.phase !== step.phase)
          recordFailure(`expect phase ${step.phase} → got ${row?.phase ?? "none"}`);
      }
      if (step.facts) {
        const row = db
          .prepare(`SELECT facts FROM workflow WHERE conversation_id = ? ORDER BY updated_at DESC LIMIT 1`)
          .get(conversationId) as { facts: string } | undefined;
        const stored = JSON.parse(row?.facts ?? "{}") as Record<string, { value: unknown }>;
        for (const [key, value] of Object.entries(step.facts)) {
          if (JSON.stringify(stored[key]?.value) !== JSON.stringify(value))
            recordFailure(
              `expect fact ${key}=${JSON.stringify(value)} → got ${JSON.stringify(stored[key]?.value)}`,
            );
        }
      }
      if (step.optionsPriceAtMost !== undefined) {
        const blocks = lastParts.find((p) => p.type === "option_blocks")?.blocks as
          { provider: { price: number } }[] | undefined;
        if (!blocks?.length) recordFailure("expect option blocks → none in the reply");
        else if (blocks.some((b) => b.provider.price > step.optionsPriceAtMost!))
          recordFailure(`expect every option ≤ ₹${step.optionsPriceAtMost} → found pricier`);
      }
      if (step.cardMatchesApproval || step.cardPriceDiffersFromSearch) {
        const card = partOf("approval_card") as
          | { approvalId: string; action: string; provider: { id: string }; slot: string; price: number }
          | undefined;
        const record = card
          ? (db
              .prepare(`SELECT action, provider_id, slot, price FROM approval WHERE id = ?`)
              .get(card.approvalId) as
              { action: string; provider_id: string; slot: string; price: number } | undefined)
          : undefined;
        if (!card || !record) recordFailure("expect approval card → none (or no approval record behind it)");
        else if (
          step.cardMatchesApproval &&
          (card.action !== record.action ||
            card.provider.id !== record.provider_id ||
            card.slot !== record.slot ||
            card.price !== record.price)
        ) {
          recordFailure("expect card = approval record → they differ");
        } else if (step.cardPriceDiffersFromSearch && card.price === pickedSearchPrice) {
          recordFailure(`expect card price ≠ search price ₹${pickedSearchPrice} → same`);
        }
      }
      if (
        step.lastRunToolCalls &&
        JSON.stringify(toolCallsOf(lastRunId)) !== JSON.stringify(step.lastRunToolCalls)
      ) {
        recordFailure(
          `expect last run's tool calls ${step.lastRunToolCalls.join(" → ")} → got ${toolCallsOf(lastRunId).join(" → ")}`,
        );
      }
      if (step.agentBookings !== undefined) {
        const { c } = db
          .prepare(`SELECT COUNT(*) AS c FROM mock_booking WHERE user_id = ? AND id NOT LIKE 'mb-demo%'`)
          .get(userId) as { c: number };
        if (c !== step.agentBookings)
          recordFailure(`expect ${step.agentBookings} agent booking(s) → got ${c}`);
      }
    } else if (step.step === "click") {
      const cardId = lastCardId;
      if (!cardId) recordFailure(`click ${step.decision} → no approval card on screen`);
      else await act(`click ${step.decision}`, () => service.decideApproval(userId, cardId, step.decision));
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
    notes: firstFailure ?? `invariants ${CHECKED_INVARIANTS.join(", ")} checked after every step`,
    checkedInvariants: [...CHECKED_INVARIANTS],
    firstFailure,
  };

  function recordFailure(message: string) {
    firstFailure ??= message;
  }
};

// Invariants over stored state (§ 2.5.10). More switch on as their units land.
const CHECKED_INVARIANTS = ["I-1", "I-2", "I-3", "I-4", "I-5", "I-9"] as const;

/**
 * I-1, I-2, I-3 — bookings. Agent-created bookings are the ones with a provider-side
 * idempotency record (R10: seeded history and "someone else took the slot" bookings
 * carry no approval by design). A success reply always starts with "Booked:".
 */
const checkBookingInvariants = (db: Db): string | null => {
  const stray = db
    .prepare(
      `SELECT b.id FROM mock_booking b WHERE b.id NOT LIKE 'mb-demo%' AND b.user_id <> 'u-someone-else'
       AND NOT EXISTS (SELECT 1 FROM mock_idempotency k WHERE k.booking_id = b.id AND k.tool = 'book')`,
    )
    .get() as { id: string } | undefined;
  if (stray) return `I-1: booking ${stray.id} was made outside any operation`;
  const unapproved = db
    .prepare(
      `SELECT b.id FROM mock_idempotency k JOIN mock_booking b ON b.id = k.booking_id
       LEFT JOIN operation o ON o.idempotency_key = k.key
       LEFT JOIN approval a ON a.id = o.approval_id
       WHERE k.tool = 'book' AND (a.id IS NULL OR a.status <> 'used' OR a.provider_id <> b.provider_id OR a.slot <> b.slot OR a.price <> b.price)`,
    )
    .get() as { id: string } | undefined;
  if (unapproved)
    return `I-1: booking ${unapproved.id} has no used approval matching provider, slot and price`;
  const duplicate = db
    .prepare(
      `SELECT o.id FROM operation o JOIN mock_idempotency k ON k.key LIKE o.id || ':%' AND k.tool = 'book' AND k.booking_id IS NOT NULL
       GROUP BY o.id HAVING COUNT(DISTINCT k.booking_id) > 1`,
    )
    .get() as { id: string } | undefined;
  if (duplicate) return `I-2: operation ${duplicate.id} created more than one booking`;
  for (const m of db
    .prepare(`SELECT run_id FROM message WHERE role = 'agent' AND text LIKE 'Booked:%'`)
    .all() as { run_id: string }[]) {
    const events = db
      .prepare(`SELECT type, data FROM trace_event WHERE run_id = ? ORDER BY seq`)
      .all(m.run_id) as { type: string; data: string }[];
    const verified = events.findIndex(
      (e) =>
        e.type === "tool_call" &&
        e.data.includes('"get_booking_status"') &&
        e.data.includes('\\"status\\":\\"booked\\"'),
    );
    const succeeded = events.findIndex((e) => e.type === "operation_event" && e.data.includes('"succeeded"'));
    if (verified === -1 || succeeded < verified)
      return `I-3: run ${m.run_id} reported a booking without a verified booked status first`;
  }
  return null;
};

export const checkInvariants = (
  db: Db,
  caps: { modelCalls: number; toolCalls: number; elapsedMs: number },
): string | null => {
  const booking = checkBookingInvariants(db);
  if (booking) return booking;
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
      if (run.model_calls > caps.modelCalls)
        return `I-4: run ${run.id} used ${run.model_calls} model calls (cap ${caps.modelCalls})`;
      if (run.tool_calls > caps.toolCalls)
        return `I-4: run ${run.id} used ${run.tool_calls} tool calls (cap ${caps.toolCalls})`;
      if (run.ended_at - run.started_at > caps.elapsedMs)
        return `I-4: run ${run.id} took ${run.ended_at - run.started_at} ms (cap ${caps.elapsedMs})`;
      const agent = db
        .prepare(`SELECT COUNT(*) c FROM message WHERE run_id = ? AND role = 'agent' AND trim(text) <> ''`)
        .get(run.id) as { c: number };
      if (agent.c === 0) return `I-5: run ${run.id} ended without an agent reply`;
    }
  }
  for (const event of db.prepare(`SELECT run_id, seq, data FROM trace_event`).all() as {
    run_id: string;
    seq: number;
    data: string;
  }[]) {
    for (const user of DEMO_USERS) {
      if (event.data.includes(user.password))
        return `I-9: trace event ${event.run_id}#${event.seq} contains a password`;
    }
    if (/session=|cookie/i.test(event.data))
      return `I-9: trace event ${event.run_id}#${event.seq} contains a cookie`;
  }
  return null;
};
