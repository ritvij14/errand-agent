import type { Db } from "../shared/db.js";
import type { Clock } from "../shared/clock.js";
import { startTrace, readTrace } from "../tracing/index.js";
import { approvalRepo } from "../approval/index.js";
import { authorizeWrite, operationRepo } from "../booking/index.js";
import { createWorkflowStore as createConversationWorkflow, type ApplyOutcome } from "../agent/workflow.js";
import type { AgentModel, ReadResult } from "../agent/index.js";
import { CAPS, CapHit, createRunBudget, type CapCode, type Caps } from "../shared/run-budget.js";
import { createElapsed } from "../shared/elapsed.js";
import {
  createMockSettings,
  createToolGateway,
  DEFAULT_SEED,
  SimulatedCrash,
  type ForcedQueue,
  type MockSettings,
} from "../tools/index.js";
import { conversationRepo, type Conversation, type Run } from "./conversations.repo.js";

// The conversation feature (MH-5): one active run per conversation, everything
// else refused with CONVERSATION_BUSY; every run ends with a recorded outcome.

/** `mock` tunes the in-process provider API; evals pass their scenario seed. */
export type ConversationsDeps = {
  db: Db;
  clock: Clock;
  model: AgentModel;
  mock?: { seed?: string; settings?: MockSettings; forced?: ForcedQueue };
  /** the run caps (NFR-1); tests shrink them */
  caps?: Caps;
};

/** A workflow code that ends the run some other way than `completed` (§ 2.5.3). */
const runOutcomeOf = (code: string | undefined): string =>
  code === "unknown_error" ? "error" : code === "retries_exhausted" ? "retries_exhausted" : "completed";

export type ReplyPart = Record<string, unknown>;
export type Reply = {
  runId: string;
  outcome: string;
  message: { id: string; role: "agent"; text: string; parts: ReplyPart[]; runId: string };
};

export type SendResult =
  | { ok: true; reply: Reply }
  | { ok: false; code: "CONVERSATION_BUSY" | "VALIDATION_ERROR" | "NOT_FOUND"; message: string };

export type ConversationFailure = { code: string; message: string };
export type ConversationRunError = { ok: false; code: string; message: string };

// The run-in-progress marker lives in memory (2.3): one Node process carries the
// lock; a restart clears it and recovery picks up any in-flight work.
const busyMarkers = new Set<string>();
// conversations with an open workflow (phase 3 replaces this when workflows exist)
const openWorkflows = new Set<string>();

export const createConversationService = (deps: ConversationsDeps) => {
  const { db, clock, model } = deps;
  const repo = conversationRepo(db);
  const workflowStore = createConversationWorkflow(db, clock, model);
  const approvals = approvalRepo(db);
  const mockSettings = deps.mock?.settings ?? createMockSettings();
  const forced: ForcedQueue = deps.mock?.forced ?? { take: () => undefined };
  const caps = deps.caps ?? CAPS;

  /**
   * One run (§ 2.5.3): busy check, run + trace, a tool gateway bound to the user and
   * this run, the workflow step, the reply. A `message` run reads the text (model call
   * 1) and saves it first (NFR-5); an `approval_decision` run carries structured input.
   */
  const runTurn = async (
    userId: string,
    conversationId: string,
    trigger: "message" | "approval_decision" | "recovery",
    step: (text: string) => Promise<ApplyOutcome>,
    userMessage?: { text: string; clientMessageId: string },
  ): Promise<SendResult> => {
    if (busyMarkers.has(conversationId)) {
      return {
        ok: false,
        code: "CONVERSATION_BUSY",
        message: "Still working on your last message — one moment.",
      };
    }
    const run = repo.createRun(conversationId, userId, trigger, clock.now().getTime());
    busyMarkers.add(conversationId);
    const trace = startTrace(db, clock, run.id);
    trace.record("run_started", {
      trigger,
      conversationId,
      userId,
      phase: workflowStore.getActiveWorkflow(conversationId)?.phase ?? "none",
    });
    const budget = createRunBudget({ caps });
    // trace durations are real latency (MH-7); the budget's time also counts simulated pauses
    const runElapsed = createElapsed();
    // every model call goes through the run's caps and is raced against the time left (R8)
    const countedModel: AgentModel = {
      read: async (job) => {
        budget.beforeModelCall();
        const elapsed = createElapsed();
        const result: ReadResult =
          forced.take("model_read", 0)?.outcome === "unusable"
            ? { kind: "unusable" }
            : await budget.race(model.read(job));
        trace.record(
          "model_call",
          { job: "read", input: job.text, output: result.kind },
          Math.round(elapsed.ms()),
        );
        return result;
      },
      write: async (job) => {
        budget.beforeModelCall();
        return budget.race(model.write(job));
      },
    };
    try {
      let ending: { outcome: string; text: string; parts: ReplyPart[] };
      const gateway = createToolGateway({
        db,
        clock,
        settings: mockSettings,
        forced,
        seed: deps.mock?.seed ?? DEFAULT_SEED,
        userId,
        trace,
        budget,
        authorizeWrite: authorizeWrite(db, userId), // Gate 2 (R1)
      });
      workflowStore.useRun({
        trace,
        model: countedModel,
        search: gateway.searchProviders,
        hold: gateway.holdSlot,
        list: gateway.listBookings,
        details: { getProvider: gateway.getProvider },
        book: {
          book: gateway.book,
          status: gateway.getBookingStatus,
          retryWaitsMs: mockSettings.retryWaitsMs,
          wait: budget.wait,
        },
        cancel: {
          cancel: gateway.cancel,
          list: gateway.listBookings,
          retryWaitsMs: mockSettings.retryWaitsMs,
          wait: budget.wait,
        },
        reschedule: {
          reschedule: gateway.reschedule,
          list: gateway.listBookings,
          retryWaitsMs: mockSettings.retryWaitsMs,
          wait: budget.wait,
        },
      });
      try {
        // § 2.5.2 rule 5: a booking cut off by a restart is finished before the new input is read
        const recovered = trigger === "recovery" ? undefined : workflowStore.recover(conversationId);
        if (recovered?.reply)
          repo.addMessage(
            conversationId,
            run.id,
            "agent",
            recovered.reply,
            (recovered.parts ?? []) as ReplyPart[],
            clock.now().getTime(),
          );
        if (userMessage)
          repo.addMessage(
            conversationId,
            run.id,
            "user",
            userMessage.text,
            [],
            clock.now().getTime(),
            userMessage.clientMessageId,
          );
        const outcome = await step(userMessage?.text ?? "");
        // the write job: when the code already decided the wording it still counts as the run's write
        if (outcome.reply) budget.beforeModelCall();
        const writeElapsed = createElapsed();
        const text =
          outcome.reply || (await countedModel.write({ purpose: outcome.code ?? "help", state: {} }));
        trace.record(
          "model_call",
          // the decision being worded (§ 2.5.9): where the workflow stands and any known code
          { job: "write", input: { phase: outcome.phase, code: outcome.code ?? null }, output: text },
          Math.round(writeElapsed.ms()),
        );
        ending = { outcome: runOutcomeOf(outcome.code), text, parts: (outcome.parts ?? []) as ReplyPart[] };
      } catch (error) {
        if (error instanceof SimulatedCrash) throw error; // the process is gone: nothing more runs
        if (error instanceof CapHit) {
          trace.record("limit_hit", { cap: error.cap, ...budget.used() });
          ending = { outcome: error.cap, text: capReply(error.cap, conversationId), parts: [] };
        } else {
          // details stay in the trace; the reply comes from the operation's checked status (R5)
          const internalDetails = (
            error instanceof Error ? (error.stack ?? error.message) : String(error)
          ).slice(0, 2000);
          trace.record("error", { code: "unknown_error", internalDetails });
          ending = {
            outcome: "unknown_error",
            text: workflowStore.afterUnknownError(conversationId),
            parts: [],
          };
        }
      } finally {
        workflowStore.useRun(undefined);
      }
      const used = budget.used();
      const endedAt = clock.now().getTime();
      repo.finishRun(run.id, ending.outcome, endedAt, used.modelCalls, used.toolCalls);
      trace.record(
        "run_ended",
        {
          outcome: ending.outcome,
          modelCalls: used.modelCalls,
          toolCalls: used.toolCalls,
          countedMs: used.elapsedMs,
        },
        Math.round(runElapsed.ms()),
      );
      const saved = repo.addMessage(conversationId, run.id, "agent", ending.text, ending.parts, endedAt);
      return { ok: true, reply: toReply({ ...run, outcome: ending.outcome }, saved) };
    } finally {
      busyMarkers.delete(conversationId);
    }
  };

  /** Which limit was hit and what that leaves (§ 2.5.3): never a promised follow-up we don't run. */
  const capReply = (cap: CapCode, conversationId: string): string => {
    const limit = {
      cap_model_calls: `this message hit my limit of ${caps.modelCalls} model calls`,
      cap_tool_calls: `this request hit my limit of ${caps.toolCalls} provider calls`,
      cap_time: `this request hit my time limit of ${caps.elapsedMs / 1000} seconds`,
    }[cap];
    const phase = workflowStore.getActiveWorkflow(conversationId)?.phase;
    const midBooking = phase === "executing" || phase === "verifying";
    return midBooking
      ? `I stopped: ${limit}. Your booking check didn't finish — message me anything and I'll check and tell you right away.`
      : `I stopped: ${limit}. Nothing was booked or changed — send your message again to continue.`;
  };

  const toReply = (run: Run, message: { id: string; text: string; parts: unknown[] }): Reply => ({
    runId: run.id,
    outcome: (run.outcome as string) ?? "completed",
    message: {
      id: message.id,
      role: "agent",
      text: message.text,
      parts: message.parts as ReplyPart[],
      runId: run.id,
    },
  });

  return {
    createConversation: (userId: string): Conversation =>
      repo.createConversation(userId, clock.now().getTime()),

    listConversations: (
      userId: string,
    ): { id: string; title: string; createdAt: number; updatedAt: number; busy: boolean }[] =>
      repo.listConversations(userId).map((c) => ({
        id: c.id,
        title: c.title,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
        busy: busyMarkers.has(c.id),
      })),

    readConversation: (
      userId: string,
      id: string,
    ): { conversation: Conversation; messages: unknown[]; busy: boolean } | ConversationFailure => {
      const conversation = repo.getConversation(id, userId);
      if (!conversation) return { code: "NOT_FOUND", message: "Conversation doesn't exist" };
      return { conversation, messages: repo.listMessages(id), busy: busyMarkers.has(id) };
    },

    runTrace: (userId: string, runId: string): { run: unknown; events: unknown[] } | ConversationFailure => {
      const row = db.prepare(`SELECT * FROM run WHERE id = ? AND user_id = ?`).get(runId, userId) as
        Run | undefined;
      if (!row) return { code: "NOT_FOUND", message: "Run doesn't exist" } as const;
      return {
        run: {
          id: row.id,
          trigger: row.trigger,
          startedAt: row.started_at,
          endedAt: row.ended_at,
          outcome: row.outcome,
          modelCalls: row.model_calls,
          toolCalls: row.tool_calls,
        },
        events: readTrace(db, runId),
      };
    },

    // ——— the run (§ 2.5.3) ———

    sendMessage: async (
      userId: string,
      conversationId: string,
      text: string | undefined,
      clientMessageId: string | undefined,
      approvalId?: string,
      /** the memory card the user answered (2.5.8), so a yes binds to that fact only */
      memoryFactId?: string,
    ): Promise<SendResult> => {
      if (
        typeof text !== "string" ||
        text.trim() === "" ||
        text.length > 2000 ||
        typeof clientMessageId !== "string" ||
        clientMessageId === ""
      ) {
        return {
          ok: false,
          code: "VALIDATION_ERROR",
          message: "Field 'text' (1–2000 chars) and 'clientMessageId' are required",
        };
      }
      const conversation = repo.getConversation(conversationId, userId);
      if (!conversation) return { ok: false, code: "NOT_FOUND", message: "Conversation doesn't exist" };

      // R2: a resent clientMessageId replays the stored reply; no new run
      const already = repo.findUserMessageByClientMessageId(conversationId, clientMessageId);
      if (already) {
        const replayedRun = db
          .prepare(`SELECT * FROM run WHERE id = ? AND user_id = ?`)
          .get(already.run_id, userId) as Run | undefined;
        const replyMessage = replayedRun ? repo.findAgentReplyForRun(replayedRun.id) : undefined;
        if (replyMessage) {
          return {
            ok: true,
            reply: {
              runId: replayedRun!.id,
              outcome: (replayedRun!.outcome as string) ?? "completed",
              message: {
                id: replyMessage.id,
                role: "agent",
                text: replyMessage.text,
                parts: JSON.parse(String(replyMessage.parts)) as ReplyPart[],
                runId: replayedRun!.id,
              },
            },
          };
        }
      }

      return runTurn(
        userId,
        conversationId,
        "message",
        (text_) => workflowStore.applyUserText(userId, conversationId, text_, approvalId, memoryFactId),
        {
          text,
          clientMessageId,
        },
      );
    },

    /**
     * Server start (§ 2.5.6): every operation left in flight gets its own `recovery` run —
     * own trace, a tool client bound to the operation's user — and the outcome is added
     * to its conversation as an agent message.
     */
    recoverInFlight: async (): Promise<void> => {
      for (const op of operationRepo(db).allInFlight()) {
        await runTurn(
          op.user_id,
          op.conversation_id,
          "recovery",
          async () =>
            workflowStore.recover(op.conversation_id) ?? {
              phase: "none",
              reply: "",
              code: "help",
              facts: {},
            },
        );
      }
    },

    /** Approve / Decline buttons (§ 2.5.5): a run with trigger `approval_decision`. */
    decideApproval: async (userId: string, approvalId: string, decision: unknown): Promise<SendResult> => {
      if (decision !== "approve" && decision !== "decline") {
        return {
          ok: false,
          code: "VALIDATION_ERROR",
          message: "Field 'decision' must be 'approve' or 'decline'",
        };
      }
      const record = approvals.getById(approvalId);
      if (!record || record.user_id !== userId)
        return { ok: false, code: "NOT_FOUND", message: "Approval doesn't exist" };
      return runTurn(userId, record.conversation_id, "approval_decision", async () =>
        workflowStore.decide(record.conversation_id, approvalId, decision),
      );
    },

    // expose internals for later units (workflow/booking); not for tests to drive
    __internal: { repo, busyMarkers, openWorkflows },
  };
};

export type ConversationService = ReturnType<typeof createConversationService>;
