import type { Db } from "../shared/db.js";
import type { Clock } from "../shared/clock.js";
import { startTrace, readTrace } from "../tracing/index.js";
import { approvalRepo } from "../approval/index.js";
import { authorizeWrite } from "../booking/index.js";
import { createWorkflowStore as createConversationWorkflow, type ApplyOutcome } from "../agent/workflow.js";
import type { AgentModel } from "../agent/index.js";
import {
  createMockSettings,
  createToolGateway,
  DEFAULT_SEED,
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
};

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

  /**
   * One run (§ 2.5.3): busy check, run + trace, a tool gateway bound to the user and
   * this run, the workflow step, the reply. A `message` run reads the text (model call
   * 1) and saves it first (NFR-5); an `approval_decision` run carries structured input.
   */
  const runTurn = async (
    userId: string,
    conversationId: string,
    trigger: "message" | "approval_decision",
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
    try {
      const gateway = createToolGateway({
        db,
        clock,
        settings: mockSettings,
        forced,
        seed: deps.mock?.seed ?? DEFAULT_SEED,
        userId,
        trace,
        authorizeWrite: authorizeWrite(db, userId), // Gate 2 (R1)
      });
      workflowStore.useRun({
        trace,
        search: gateway.searchProviders,
        hold: gateway.holdSlot,
        book: {
          book: gateway.book,
          status: gateway.getBookingStatus,
          retryWaitsMs: mockSettings.retryWaitsMs,
        },
      });
      const outcome = await step(userMessage?.text ?? "").finally(() => workflowStore.useRun(undefined));
      const toolCalls = gateway.toolCallsUsed();
      const replyText = outcome.reply || (await model.write({ purpose: outcome.code ?? "help", state: {} }));
      if (userMessage)
        trace.record("model_call", {
          job: "read",
          input: userMessage.text,
          output: outcome.code ?? "applied",
        });
      trace.record("model_call", { job: "write", output: replyText });
      const modelCalls = userMessage ? 2 : 1;
      const endedAt = clock.now().getTime();
      const runOutcome = outcome.code === "unknown_error" ? "error" : "completed"; // conversation-level errors complete the run (§2.5.3)
      repo.finishRun(run.id, runOutcome, endedAt, modelCalls, toolCalls);
      trace.record("run_ended", { outcome: runOutcome, modelCalls, toolCalls });
      const saved = repo.addMessage(
        conversationId,
        run.id,
        "agent",
        replyText,
        (outcome.parts ?? []) as ReplyPart[],
        endedAt,
      );
      return { ok: true, reply: toReply(run, saved) };
    } finally {
      busyMarkers.delete(conversationId);
    }
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
        (text_) => workflowStore.applyUserText(userId, conversationId, text_, approvalId),
        {
          text,
          clientMessageId,
        },
      );
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
