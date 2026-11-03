import { randomUUID } from "node:crypto";
import type { Db } from "../shared/db.js";
import type { Clock } from "../shared/clock.js";
import type { AgentModel, ReadResult } from "./index.js";
import { mergeCorrection, TIME_OUT_OF_RANGE, type TimeWindow } from "./time-window.js";
import type { Trace } from "../tracing/index.js";
import type { BookingRecord, ProviderDetails, ProviderSummary, ToolResult } from "../tools/index.js";
import { buildOptions, movePickText, searchRange, slotLabel, type OptionBlock } from "./options.js";
import {
  executeBook,
  executeCancel,
  executeReschedule,
  MAX_BOOK_ATTEMPTS,
  operationRepo,
  startBookOperation,
  startCancelOperation,
  startRescheduleOperation,
  type BookTools,
  type CancelTools,
  type RescheduleTools,
  type OperationRecord,
} from "../booking/index.js";
import { findService } from "./model.js";
import * as memoryApi from "../memory/index.js";
import {
  APPROVAL_MAX_AGE_MS,
  approvalCardPart,
  approvalRepo,
  type ApprovalRecord,
  type NewApproval,
} from "../approval/index.js";

// The workflow store (§ 2.5.2): code drives; the model only reads and writes text.
// Facts → candidates → selection → hold → approval build one on top of the other; a
// correction overwrites one detail and its built-on state clears (rule 2). Saves are
// optimistic: version must match the row's current version or the save is refused.

export type Fact = { value: unknown; source: "user" | "memory"; updatedAt: number; memoryFactId?: string };
export type Facts = {
  service?: Fact;
  area?: Fact;
  time_window?: Fact & { value: TimeWindow | null };
  budget?: Fact;
  preferences?: Fact;
};

export type WorkflowRow = {
  id: string;
  conversation_id: string;
  user_id: string;
  intent: "book" | "reschedule" | "cancel" | null;
  phase: string;
  facts: Facts;
  candidates: unknown[] | null;
  selection: Selection | null;
  hold: Hold | null;
  target_booking_id: string | null;
  pending_question: string | null;
  version: number;
  updatedAt: number;
};

export type Selection = { providerId: string; slot: string };
export type Hold = { holdId: string; expiresAt: number; quotedPrice: number };

export type ApplyOutcome = {
  phase: string;
  reply: string;
  facts: Facts;
  code?: string;
  parts?: Record<string, unknown>[];
};

/** `search_providers` through the run's tool gateway (the only way to the provider API). */
export type SearchTool = (args: {
  service: string;
  area: string;
  from: string;
  to: string;
}) => ToolResult<{ providers: ProviderSummary[] }>;

/** `hold_slot` through the run's tool gateway. */
export type HoldTool = (
  args: Selection,
) => ToolResult<{ holdId: string; slot: string; quotedPrice: number; expiresAt: number }>;

/** `list_bookings` through the run's gateway — bound to the signed-in user (V-7). */
export type ListTool = () => ToolResult<{ bookings: BookingRecord[] }>;

/** What the run applying a message lends the store: its trace (MH-7) and its tools. */
export type RunTools = {
  trace?: Trace;
  search?: SearchTool;
  hold?: HoldTool;
  list?: ListTool;
  /** FR-6 (U31): details + reviews; the gateway flags and caps review text (2.5.7) */
  details?: DetailsTool;
  book?: BookTools;
  cancel?: CancelTools;
  reschedule?: RescheduleTools;
  model?: AgentModel;
};

const REQUIRED = ["service", "area", "time_window"] as const;

export const SERVICE_NAMES: Record<string, string> = {
  plumber: "plumbing",
  electrician: "electrical work",
  ac_servicing: "AC servicing",
  deep_cleaning: "deep cleaning",
  carpentry: "carpentry",
};

/** Who does the service: "your preferred electrician". */
const SERVICE_LABEL: Record<string, string> = {
  plumber: "plumber",
  electrician: "electrician",
  ac_servicing: "AC technician",
  deep_cleaning: "cleaner",
  carpentry: "carpenter",
};

export const AREA_NAMES: Record<string, string> = {
  indiranagar: "Indiranagar",
  koramangala: "Koramangala",
  hsr_layout: "HSR Layout",
  jayanagar: "Jayanagar",
  whitefield: "Whitefield",
};

type WorkflowRecord = {
  id: string;
  conversation_id: string;
  user_id: string;
  intent: string | null;
  phase: string;
  facts: string;
  candidates: string | null;
  selection: string | null;
  hold: string | null;
  target_booking_id: string | null;
  pending_question: string | null;
  version: number;
  updated_at: number;
};

const json = (value: unknown): string | null => (value ? JSON.stringify(value) : null);

const decode = (row: WorkflowRecord): WorkflowRow => ({
  id: row.id,
  conversation_id: row.conversation_id,
  user_id: row.user_id,
  intent: (row.intent as WorkflowRow["intent"]) ?? null,
  phase: row.phase,
  facts: JSON.parse(row.facts || "{}") as Facts,
  candidates: row.candidates ? (JSON.parse(row.candidates) as unknown[]) : null,
  selection: row.selection ? (JSON.parse(row.selection) as Selection) : null,
  hold: row.hold ? (JSON.parse(row.hold) as Hold) : null,
  target_booking_id: row.target_booking_id,
  pending_question: row.pending_question,
  version: row.version,
  updatedAt: row.updated_at,
});

// A time fact whose window has no bound at all counts as missing (it would search
// everything); the "any" reading of time searches the full window instead.
const timeFactHasBounds = (fact: (Fact & { value: TimeWindow | null }) | undefined): boolean => {
  const w = fact?.value;
  return !!w && (w.dateFrom !== null || w.dateTo !== null || w.earliest !== null || w.latest !== null);
};

type DetailsTool = { getProvider: (providerId: string) => ToolResult<ProviderDetails> };
type Held = { holdId: string; expiresAt: number; quotedPrice: number };
/** One inferred memory value offered for confirmation (2.5.8) — saved as the workflow's pending question. */
type Proposal = {
  ask: string;
  factId: string;
  key: string;
  value: string;
  service: string | null;
  label: string;
};

/** The memory key a pending yes/no is about, if the waiting question is a memory confirmation. */
const pendingMemoryKey = (w: WorkflowRow): string | undefined => {
  const pending = w.pending_question
    ? (JSON.parse(w.pending_question) as { type?: string; key?: string })
    : undefined;
  return pending?.type === "memory_confirm" ? pending.key : undefined;
};

/** The provider's display name from the saved option blocks. */
const nameOf = (w: WorkflowRow, providerId: string): string =>
  (w.candidates as OptionBlock[] | null)?.find((b) => b.provider.id === providerId)?.provider.name ??
  providerId;
const rupees = (n: number): string => `₹${n.toLocaleString("en-IN")}`;

const CHANGE_VERB = { cancel: "cancel", reschedule: "move" } as const;
const DROP_REPLY = {
  book: "Okay, dropped. Nothing was booked.",
  reschedule: "Okay, dropped. Nothing was changed.",
  cancel: "Okay, dropped. Your booking is unchanged.",
} as const;

/** FR-15 ask wording: what the current task is ("booking the plumber"). */
const taskLabel = (intent: WorkflowRow["intent"], service: string | null): string =>
  intent === "book"
    ? `booking ${service ? `the ${service}` : "an errand"}`
    : intent === "cancel"
      ? `cancelling ${service ? `the ${SERVICE_NAMES[service] ?? service} booking` : "your booking"}`
      : `moving ${service ? `the ${SERVICE_NAMES[service] ?? service} booking` : "your booking"}`;

/** FR-15 ask wording: what the new request would be ("cancel the AC servicing"). */
const newRequestLabel = (intent: "book" | "cancel" | "reschedule", service: string | null): string => {
  if (intent === "book")
    return `book ${service ? (/^[aeiou]/i.test(service) ? "an" : "a") + ` ${service}` : "a new request"}`;
  return `${intent === "cancel" ? "cancel" : "move"} ${service ? `the ${SERVICE_NAMES[service] ?? service}` : ""}`.trim();
};

/** One row of a `bookings_list` part (FR-5): what the page shows for a booking. */
const listItem = (b: BookingRecord) => ({
  id: b.id,
  providerName: b.providerName,
  service: b.service,
  area: b.area,
  slot: b.slot,
  slotLabel: slotLabel(b.slot),
  price: b.price,
  status: b.status,
});

/** Which of the user's bookings the text means: a booking id, else the service, else a provider name, else all. */
const matchBookings = (bookings: BookingRecord[], text: string): BookingRecord[] => {
  const lower = text.toLowerCase();
  const byId = bookings.filter((b) => lower.includes(b.id.toLowerCase()));
  if (byId.length) return byId;
  const service = findService(text).service;
  if (service) return bookings.filter((b) => b.service === service);
  const byProvider = bookings.filter((b) => lower.includes(b.providerName.toLowerCase()));
  return byProvider.length ? byProvider : bookings;
};

export const createWorkflowStore = (db: Db, clock: Clock, model: AgentModel) => {
  let trace: Trace | undefined;
  let search: SearchTool | undefined;
  let hold: HoldTool | undefined;
  let list: ListTool | undefined;
  let bookTools: BookTools | undefined;
  let cancelTools: CancelTools | undefined;
  let rescheduleTools: RescheduleTools | undefined;
  let getProvider: DetailsTool["getProvider"] | undefined;
  /** the run's counted model (caps, NFR-1); the store's own model outside a run */
  let runModel: AgentModel | undefined;
  const approvals = approvalRepo(db);
  const operations = operationRepo(db);
  const nowMs = () => clock.now().getTime();

  const getActive = (conversationId: string): WorkflowRow | undefined => {
    const row = db
      .prepare(
        `SELECT * FROM workflow WHERE conversation_id = ? AND phase NOT IN ('done','failed','abandoned') ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(conversationId) as WorkflowRecord | undefined;
    return row ? decode(row) : undefined;
  };

  const fact = (key: keyof Facts, value: unknown): Fact =>
    ({ value, source: "user", updatedAt: nowMs() }) as Fact;

  /** Collect or advance: with every required fact present the phase is `searching`. */
  const nextPhase = (facts: Facts): string => {
    const missing = REQUIRED.some(
      (key) =>
        !facts[key] ||
        (key === "time_window" &&
          !timeFactHasBounds(facts.time_window as Fact & { value: TimeWindow | null })),
    );
    return missing ? "collecting" : "searching";
  };

  const missingFacts = (facts: Facts): (typeof REQUIRED)[number][] =>
    REQUIRED.filter((key) => {
      const f = facts[key];
      if (!f) return true;
      if (key === "time_window")
        return !timeFactHasBounds(facts.time_window as Fact & { value: TimeWindow | null });
      return f.value === undefined;
    });

  /** Save with optimistic concurrency: the version must match the row’s current one (or -1 to insert). */
  const saveWorkflow = (
    conversationId: string,
    expectedVersion: number,
    mutate: (w: WorkflowRow) => WorkflowRow,
  ): { ok: boolean; workflow?: WorkflowRow } => {
    const existing = getActive(conversationId);
    if (expectedVersion !== -1 && (!existing || existing.version !== expectedVersion)) return { ok: false };
    if (expectedVersion === -1) {
      if (existing) return { ok: false }; // only one active workflow per conversation
      const w = mutate({
        id: randomUUID(),
        conversation_id: conversationId,
        user_id: "",
        intent: null,
        phase: "collecting",
        facts: {},
        candidates: null,
        selection: null,
        hold: null,
        target_booking_id: null,
        pending_question: null,
        version: 0,
        updatedAt: nowMs(),
      } as WorkflowRow);
      try {
        db.prepare(
          `INSERT INTO workflow (id, conversation_id, user_id, intent, phase, facts, candidates, selection, hold, target_booking_id, pending_question, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        ).run(
          w.id,
          conversationId,
          w.user_id,
          w.intent,
          w.phase,
          JSON.stringify(w.facts),
          json(w.candidates),
          json(w.selection),
          json(w.hold),
          w.target_booking_id,
          w.pending_question,
          nowMs(),
          nowMs(),
        );
        return { ok: true, workflow: getActive(conversationId) };
      } catch (err) {
        if (String((err as Error).message).includes("UNIQUE")) return { ok: false }; // lost the one-active-workflow race
        throw err;
      }
    }
    const next = mutate({ ...existing! });
    next.updatedAt = nowMs();
    const result = db
      .prepare(
        // by id: version alone ties whenever an older workflow (e.g. abandoned by a
        // task switch) reached the same version — one update would rewrite both rows
        `UPDATE workflow SET intent = ?, phase = ?, facts = ?, candidates = ?, selection = ?, hold = ?, target_booking_id = ?, pending_question = ?, version = version + 1, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.intent,
        next.phase,
        JSON.stringify(next.facts),
        json(next.candidates),
        json(next.selection),
        json(next.hold),
        next.target_booking_id,
        next.pending_question,
        nowMs(),
        existing!.id,
      );
    if (result.changes === 0) return { ok: false };
    if (existing!.phase !== next.phase)
      trace?.record("state_transition", { fromPhase: existing!.phase, toPhase: next.phase, reason: "apply" });
    return { ok: true, workflow: getActive(conversationId) };
  };

  /** Apply one user message to the workflow (MH-1): fill facts, ask for missing ones. */
  const applyUserText = async (
    userId: string,
    conversationId: string,
    text: string,
    approvalId?: string,
    memoryFactId?: string,
  ): Promise<ApplyOutcome> => {
    const active = getActive(conversationId);
    // R6: memory-sourced facts are re-checked at every run start — a fact the user forgot
    // or corrected (chat or panel) learns the open workflow here, before anything reads it.
    // During `executing` / `verifying` nothing changes (2.5.2 rule 4).
    const memoryNote =
      active?.phase !== "executing" && active?.phase !== "verifying" && active
        ? syncMemoryFacts(active, userId)
        : undefined;
    const syncNote = memoryNote?.note ?? "";
    const synced = memoryNote?.workflow ?? active;
    const shown =
      synced?.phase === "choosing" ? ((synced.candidates as OptionBlock[] | null) ?? undefined) : undefined;
    const readJob = { text, waitingFor: synced?.phase ?? "nothing", clock, options: shown };
    let read: ReadResult = await (runModel ?? model).read(readJob);
    // an unusable read is read again; the model-call cap stops a model that never gives one
    while (read.kind === "unusable") read = await (runModel ?? model).read(readJob);

    if (read.kind === "memory_view") return memoryView(synced, userId);
    if (read.kind === "memory_forget") return memoryForget(synced, userId, read.key, syncNote);
    if (read.kind === "memory_save") return memorySave(synced, userId, conversationId, read, syncNote);
    if (read.kind === "provider_details") return providerDetails(synced, read.providerId);
    if (read.kind === "list_bookings") return listMyBookings(synced);
    if (read.kind === "cancel") return startChange("cancel", userId, conversationId, synced, text);
    if (read.kind === "reschedule")
      return startChange("reschedule", userId, conversationId, synced, text, read.timeWindow);
    // a yes / no from a memory card answers exactly that card's fact, like an approval card (R2)
    if (memoryFactId && read.kind === "decision")
      return answerMemoryCard(active, userId, memoryFactId, read.decision === "yes");
    if (active?.pending_question && read.kind === "decision") {
      const pending = JSON.parse(active.pending_question) as { type?: string; text?: string };
      if (pending.type === "memory_confirm" && !approvals.getOpen(active.id)) {
        return answerMemoryCard(
          active,
          userId,
          (pending as { factId: string }).factId,
          read.decision === "yes",
        );
      }
      if (pending.type === "task_switch" && !approvals.getOpen(active.id)) {
        const ended = saveWorkflow(conversationId, active.version, (w) => ({
          ...w,
          phase: pending.text && read.decision === "yes" ? "abandoned" : w.phase,
          pending_question: null,
        }));
        if (read.decision === "yes" && pending.text) {
          trace?.record("state_transition", {
            fromPhase: active.phase,
            toPhase: "abandoned",
            reason: "task switch confirmed",
          });
          void ended;
          return applyUserText(userId, conversationId, pending.text);
        }
        const again = replyFor((ended.workflow ?? active) as WorkflowRow);
        return {
          phase: again.phase,
          reply: again.reply || "Okay, keeping your current request.",
          facts: again.facts,
          code: again.code,
        };
      }
    }
    if (active?.phase === "identifying_booking" && read.kind !== "drop") return identifyTarget(active, text);

    if (read.kind === "pick" || read.kind === "pick_unclear") {
      if (!active || !shown?.length) {
        return {
          phase: active?.phase ?? "collecting",
          reply: "There's no list of options to pick from right now.",
          code: "NOTHING_TO_PICK",
          facts: active?.facts ?? ({} as Facts),
        };
      }
      const chosen =
        read.kind === "pick"
          ? shown.find((b) => b.provider.id === read.providerId && b.slots.some((s) => s.start === read.slot))
          : undefined;
      if (read.kind === "pick_unclear" || !chosen) {
        return {
          ...optionsOutcome(
            active,
            "Which slot? Tap one and press Confirm, or tell me the provider and the time.",
          ),
          code: read.kind === "pick" ? "NOTHING_TO_PICK" : undefined,
        };
      }
      const saved = saveWorkflow(conversationId, active.version, (w) => ({
        ...w,
        selection: { providerId: read.providerId, slot: read.slot },
        phase: "holding",
      }));
      if (!saved.ok || !saved.workflow)
        return { phase: active.phase, reply: "", code: "unknown_error", facts: active.facts };
      return advance(saved.workflow);
    }

    if (active?.phase === "awaiting_approval") {
      // § 2.5.5 rule 1: a typed yes answers the card it carries, else the one waiting
      if (read.kind === "decision")
        return decideOn(active, approvalId, read.decision === "yes" ? "approve" : "decline", "typed");
      if (read.kind === "unknown") {
        const open = approvals.getOpen(active.id);
        if (open)
          return cardOutcome(active, open, "I didn't catch that — approve or decline the booking below.");
      }
    }

    if (read.kind === "decision" && read.decision === "yes") {
      const used = approvals.lastUsed(conversationId);
      if (used) return reportUsed(used); // § 2.5.6 repeated yes: no second call
    }

    if (read.kind === "unknown" || read.kind === "decision") {
      // nothing is waiting for a plain yes/no at U17 (decisions come with U20)
      const phase = getActive(conversationId)?.phase ?? "collecting";
      return {
        phase,
        reply: "",
        code: "NOT_UNDERSTOOD",
        facts: getActive(conversationId)?.facts ?? ({} as Facts),
      };
    }

    if (read.kind === "drop") {
      const current = getActive(conversationId);
      if (!current)
        return read.rest
          ? applyUserText(userId, conversationId, read.rest)
          : { phase: "collecting", reply: "", code: "NOT_UNDERSTOOD", facts: {} as Facts };
      voidOpenApproval(current, "user_dropped");
      const saved = saveWorkflow(conversationId, current.version, (w) => ({
        ...w,
        phase: "abandoned",
        pending_question: null,
      }));
      trace?.record("state_transition", {
        fromPhase: current.phase,
        toPhase: "abandoned",
        reason: "user dropped",
      });
      const dropped = DROP_REPLY[(current.intent ?? "book") as keyof typeof DROP_REPLY];
      if (saved.ok && read.rest) {
        const next = await applyUserText(userId, conversationId, read.rest);
        return { ...next, reply: `${dropped} ${next.reply}`.trim() };
      }
      return {
        phase: "abandoned",
        reply: dropped,
        facts: {} as Facts,
        code: saved.ok ? undefined : "unknown_error",
      };
    }

    const current = getActive(conversationId);

    if (current) {
      // a bare time/budget answer reads as a book request too — only an explicit service starts a new one
      if (read.kind === "workflow" && read.intent && read.service && read.intent !== current.intent)
        return askBeforeSwitch(current, read.intent, read.service, text);
      return applyToWorkflow(conversationId, current, read);
    }

    const intent = read.kind === "workflow" ? read.intent : undefined;
    if (!intent) return { phase: "collecting", reply: "", code: "NOT_UNDERSTOOD", facts: {} as Facts };
    const flags = read as { unknownService?: boolean; unknownArea?: boolean; timeOutOfRange?: boolean };
    if (flags.unknownService)
      return {
        phase: "collecting",
        reply:
          "I book these services: plumbing, electrical work, AC servicing, deep cleaning, carpentry. Which one?",
        code: "UNKNOWN_SERVICE",
        facts: {} as Facts,
      };
    if (flags.unknownArea)
      return {
        phase: "collecting",
        reply: "I book in Indiranagar, Koramangala, HSR Layout, Jayanagar and Whitefield — which one?",
        code: "UNKNOWN_AREA",
        facts: {} as Facts,
      };
    const facts: Facts = {};
    const values = read as {
      service?: string | null;
      area?: string | null;
      budget?: number | "any";
      preferences?: string | null;
      timeWindow?: TimeWindow;
    };
    if (values.service) facts.service = fact("service", values.service);
    if (values.area) facts.area = fact("area", values.area);
    if (values.timeWindow)
      facts.time_window = fact("time_window", values.timeWindow) as Fact & { value: TimeWindow };
    if (values.budget !== undefined) facts.budget = fact("budget", values.budget);
    if (values.preferences) facts.preferences = fact("preferences", values.preferences);

    // MH-6: a workflow starts only from what the user said — active memory fills what is
    // still missing, with the note saying so ("say if that's changed"). Never fills a
    // detail the user gave (V-11).
    const memoryNotes: string[] = [];
    if (!facts.area) {
      const saved = memoryApi.state(db, userId, "area");
      if (saved) {
        facts.area = memoryFactOf("area", saved) as Fact & { value: string };
        memoryNotes.push(
          `Using your saved area: ${AREA_NAMES[saved.value] ?? saved.value} (say if that's changed).`,
        );
        trace?.record("memory_event", { event: "used", key: "area", value: saved.value });
      }
    }
    // the saved earliest time is a time of day: it also bounds a request that named only
    // days ("this week"), unless the request gave its own earliest time or ends before it
    const userWindow = facts.time_window?.value ?? null;
    if (!userWindow || userWindow.earliest === null) {
      const savedTime = memoryApi.state(db, userId, "earliest_time");
      if (savedTime && (userWindow?.latest == null || userWindow.latest > savedTime.value)) {
        const window = {
          dateFrom: userWindow?.dateFrom ?? null,
          dateTo: userWindow?.dateTo ?? null,
          earliest: savedTime.value,
          latest: userWindow?.latest ?? null,
        } as TimeWindow;
        facts.time_window = memoryFactOf("earliest_time", savedTime, window) as Fact & { value: TimeWindow };
        memoryNotes.push(`Using your saved time: not before ${savedTime.value} (say if that's changed).`);
        trace?.record("memory_event", { event: "used", key: "earliest_time", value: savedTime.value });
      }
    }

    const saved = saveWorkflow(conversationId, -1, (w) => ({
      ...w,
      user_id: userId,
      intent,
      facts: { ...w.facts, ...facts },
      phase: nextPhase({ ...w.facts, ...facts }),
    }));
    if (!saved.ok || !saved.workflow)
      return { phase: "collecting", reply: "", code: "unknown_error", facts: {} as Facts };
    for (const [key, f] of Object.entries(saved.workflow.facts)) {
      trace?.record("fact_changed", {
        key,
        oldValue: null,
        newValue: (f as Fact).value,
        source: "user",
        isCorrection: false,
      });
    }
    trace?.record("state_transition", {
      fromPhase: "none",
      toPhase: saved.workflow.phase,
      reason: "workflow started",
    });
    if (flags.timeOutOfRange)
      return {
        phase: saved.workflow.phase,
        reply: "I can only book within the next 14 days — that time is outside it. Tell me another day.",
        facts: saved.workflow.facts,
        code: TIME_OUT_OF_RANGE,
      };
    // 2.5.8 inferred memory: propose one remembered value from the user's own history
    // (only for book, only when memory and the request don't already answer it); one
    // yes/no ask rides on the reply as R9 priority 3.
    const proposal =
      intent === "book"
        ? proposeFromHistory(
            saved.workflow,
            userId,
            values.service ?? null,
            (read as { sameAsLast?: boolean }).sameAsLast === true,
          )
        : undefined;
    let withPendingRow: WorkflowRow | undefined = saved.workflow;
    if (proposal) {
      const withPending = saveWorkflow(conversationId, saved.workflow.version, (w) => ({
        ...w,
        pending_question: JSON.stringify({
          type: "memory_confirm",
          factId: proposal.factId,
          key: proposal.key,
          value: proposal.value,
          service: proposal.service,
          label: proposal.label,
        }),
      }));
      withPendingRow = withPending.workflow;
    }
    // V-11: the request's area wins over the saved one — memory keeps it, one light note.
    const savedArea = memoryApi.state(db, userId, "area");
    const userArea = facts.area ? (facts.area.value as string) : undefined;
    const differs =
      userArea && savedArea && userArea !== savedArea.value
        ? ` I'll book that in ${AREA_NAMES[userArea] ?? userArea} this time — your saved area stays ${AREA_NAMES[savedArea.value] ?? savedArea.value} (“update my area” if you've moved).`
        : "";
    const outcome = await advance(withPendingRow!);
    let prefix = `${memoryNotes.join(" ")}${differs}`.trim();
    if (proposal) prefix = `${prefix} ${proposal.ask}`.trim();
    // the memory card is drawn from the waiting fact, like an approval card from its record
    const parts = proposal
      ? [
          ...(outcome.parts ?? []),
          {
            type: "memory_confirm",
            factId: proposal.factId,
            key: proposal.key,
            label: proposal.label,
            ask: proposal.ask,
          },
        ]
      : outcome.parts;
    return prefix ? { ...outcome, parts, reply: `${prefix} ${outcome.reply}`.trim() } : outcome;
  };

  return {
    applyUserText,
    getActiveWorkflow: getActive,
    currentVersion: (conversationId: string): number => getActive(conversationId)?.version ?? -1,
    saveWorkflow,
    useRun: (run: RunTools | undefined): void => {
      trace = run?.trace;
      search = run?.search;
      hold = run?.hold;
      list = run?.list;
      bookTools = run?.book;
      cancelTools = run?.cancel;
      rescheduleTools = run?.reschedule;
      getProvider = run?.details?.getProvider;
      runModel = run?.model;
    },

    /**
     * § 2.5.2 rule 5 / § 2.5.6 restart recovery: a workflow still `executing` / `verifying`
     * was cut off mid-booking. Finish it before anything else; undefined when nothing is.
     */
    recover: (conversationId: string): ApplyOutcome | undefined => {
      const w = getActive(conversationId);
      if (!w || (w.phase !== "executing" && w.phase !== "verifying")) return undefined;
      const op = operations.inFlightFor(w.id);
      if (op && op.kind !== "book") {
        // § 2.5.6: retry only while the approval is fresh (10 min, like a hold); else just read the booking
        const fresh = nowMs() - approvals.getById(op.approval_id)!.created_at < APPROVAL_MAX_AGE_MS;
        return fresh
          ? executeChangeOp(w, op)
          : settleChangeByList(w, op, "The server restarted before your change finished.");
      }
      return op ? recoverOperation(w, op) : undefined;
    },

    /**
     * R5 / § 2.5.3 `unknown_error`: the reply is worded from the operation's checked status,
     * never a hopeful default. Absent → nothing was booked (the operation is closed, so it
     * can't be booked later behind the user's back); found → reported; unreadable → left
     * in flight for recovery to check again.
     */
    afterUnknownError: (conversationId: string): string => {
      const w = getActive(conversationId);
      const op = w ? operations.inFlightFor(w.id) : undefined;
      if (!w || !op)
        return "Something went wrong on our side, so I stopped. Nothing was booked or changed — please send that again.";
      if (op.kind !== "book") {
        return (
          settleChangeByList(w, op, "Something went wrong on our side.")?.reply ??
          "Something went wrong on our side. I couldn't confirm whether your booking changed — don't try again yet. Message me in a moment and I'll check again."
        );
      }
      let checked: ReturnType<BookTools["status"]> | undefined;
      try {
        checked = bookTools?.status(op.idempotency_key);
      } catch {
        checked = undefined; // unreadable — including a cap hit on the check itself
      }
      if (checked?.ok && checked.data.status === "booked" && checked.data.bookingId)
        return finishFoundBooking(w, op, checked.data.bookingId).reply;
      if (checked?.ok && (checked.data.status === "not_found" || checked.data.status === "failed")) {
        operations.finish(
          op.id,
          "failed",
          { error: "unknown_error", checkedStatus: checked.data.status },
          nowMs(),
        );
        trace?.record("operation_event", {
          event: "failed",
          kind: "book",
          key: op.idempotency_key,
          result: checked.data.status,
        });
        saveWorkflow(w.conversation_id, w.version, (wf) => ({ ...wf, phase: "failed" }));
        return "Something went wrong on our side. Nothing was booked — ask me to try again.";
      }
      return "Something went wrong on our side. I couldn't confirm whether it went through — don't book again yet. Message me in a moment and I'll check again.";
    },

    /** The Approve / Decline buttons (§ 2.5.5): the same rules as a typed answer. */
    decide: (conversationId: string, approvalId: string, decision: "approve" | "decline"): ApplyOutcome => {
      const used = approvals.getById(approvalId);
      if (used?.status === "used") return reportUsed(used);
      const active = getActive(conversationId);
      if (!active)
        return {
          phase: "none",
          reply: "That approval is no longer valid — nothing is waiting for your approval.",
          facts: {} as Facts,
          code: "APPROVAL_STALE",
        };
      return decideOn(active, approvalId, decision, "button");
    },

    /** Save search results (U18 calls the tool; this stores them on the workflow). */
    setCandidates: (conversationId: string, candidates: unknown[]): WorkflowRow | undefined => {
      const current = getActive(conversationId);
      if (!current) return undefined;
      return saveWorkflow(conversationId, current.version, (w) => ({ ...w, candidates })).workflow;
    },
  };

  function applyToWorkflow(conversationId: string, current: WorkflowRow, read: ReadResult): ApplyOutcome {
    if (
      (current.phase === "executing" || current.phase === "verifying") &&
      (read.kind === "workflow" || read.kind === "correction")
    ) {
      return {
        phase: current.phase,
        reply: "I can't change it while I'm confirming the booking — I'll be right with you.",
        facts: current.facts,
        code: "CHANGE_REFUSED_IN_FLIGHT",
      };
    }
    const facts: Facts = { ...current.facts };
    let errorCode: string | undefined;
    let factChanged = false;
    let timeChanged = false;

    if (read.kind === "correction" && read.target === "time_window" && read.mergeTime) {
      const known = facts.time_window?.value;
      if (known) {
        const merged = mergeCorrection(known, read.correctionText ?? read.text, clock);
        if (merged.ok) {
          facts.time_window = fact("time_window", merged.data) as Fact & { value: TimeWindow };
          timeChanged = true;
        } else {
          errorCode = merged.error;
        }
      } else {
        // no window yet — treat the correction as a new window statement
        const parsed = mergeCorrection(
          { dateFrom: null, dateTo: null, earliest: null, latest: null },
          read.correctionText ?? read.text,
          clock,
        );
        if (parsed.ok) {
          facts.time_window = fact("time_window", parsed.data) as Fact & { value: TimeWindow };
          timeChanged = true;
        } else {
          errorCode = parsed.error;
        }
      }
    }

    const values = (read.kind === "workflow" || read.kind === "correction" ? read : read) as {
      intent?: WorkflowRow["intent"] | undefined;
      service?: string | null;
      area?: string | null;
      budget?: number | "any";
      timeWindow?: TimeWindow | undefined;
    };

    if (values.timeWindow && !(read.kind === "correction" && read.mergeTime)) {
      facts.time_window = fact("time_window", values.timeWindow) as Fact & { value: TimeWindow };
      timeChanged = true;
    }
    if (values.service) {
      facts.service = fact("service", values.service);
      factChanged = true;
    }
    if (values.area) {
      facts.area = fact("area", values.area);
      factChanged = true;
    }
    if (values.budget !== undefined) {
      facts.budget = fact("budget", values.budget);
      factChanged = true;
    }

    if (errorCode) {
      // out-of-range etc.: nothing saved; the user is asked to correct again
      return replyFor(current, errorCode);
    }

    const phase = phaseAfterChange(current, factChanged || timeChanged, facts);
    const changed = factChanged || timeChanged; // rule 2: what was built on the facts clears
    if (changed) voidOpenApproval(current, "user_correction");
    // the user answered the detail a memory question was about: the question is gone, and the
    // inferred fact stays unconfirmed (never used, I-7)
    const proposing = pendingMemoryKey(current);
    const answered =
      (proposing === "area" && !!values.area) ||
      (proposing === "earliest_time" && timeChanged && !!facts.time_window?.value?.earliest);
    const saved = saveWorkflow(conversationId, current.version, (w) => ({
      ...w,
      facts,
      phase,
      ...(answered ? { pending_question: null } : {}),
      ...(changed ? { candidates: null, selection: null, hold: null } : {}),
      intent: w.intent ?? (values.intent as WorkflowRow["intent"]), // a correction never switches the task (U30 asks first)
    }));
    if (!saved.ok || !saved.workflow)
      return { phase: current.phase, reply: "", code: "unknown_error", facts: current.facts };
    const savedWorkflow = saved.workflow;

    for (const key of ["service", "area", "time_window", "budget", "preferences"] as (keyof Facts)[]) {
      const before = (current.facts as Facts)[key];
      const after = saved.workflow.facts[key];
      if (JSON.stringify(before) !== JSON.stringify(after) && after) {
        trace?.record("fact_changed", {
          key,
          oldValue: before ? before.value : null,
          newValue: after.value,
          source: "user",
          isCorrection: read.kind === "correction" || Object.keys(current.facts).length > 0,
        });
      }
    }
    const outcome = advance(savedWorkflow);
    // V-11: a request detail that differs from a saved preference applies to this request
    // only — one light note, memory unchanged, no waiting for an answer.
    const memoryArea = memoryApi.state(db, savedWorkflow.user_id, "area");
    const newArea =
      savedWorkflow.facts.area?.source === "user"
        ? (savedWorkflow.facts.area?.value as string | undefined)
        : undefined;
    const differing = newArea && memoryArea && newArea !== memoryArea.value;
    const differingNote = differing
      ? ` I'll book that in ${AREA_NAMES[newArea!]} this time — your saved area stays ${AREA_NAMES[memoryArea!.value] ?? memoryArea!.value} (“update my area” if you've moved).`
      : "";
    return differingNote ? { ...outcome, reply: `${outcome.reply}${differingNote}` } : outcome;
  }

  function voidOpenApproval(w: WorkflowRow, reason: string): void {
    const open = approvals.getOpen(w.id);
    if (open && approvals.voidOpen(open.id, reason, nowMs())) {
      trace?.record("approval_event", { approvalId: open.id, event: "voided", voidReason: reason });
    }
  }

  /**
   * § 2.5.6 repeated "yes": the approval is used and the database allows one operation per
   * approval, so report that operation's status instead of calling anything.
   */
  function reportUsed(record: ApprovalRecord): ApplyOutcome {
    const op = operations.forApproval(record.id);
    const row = db.prepare(`SELECT * FROM workflow WHERE id = ?`).get(record.workflow_id) as WorkflowRecord;
    const w = decode(row);
    const what = `${nameOf(w, record.provider_id)} on ${slotLabel(record.slot)}`;
    const result = op?.result
      ? (JSON.parse(op.result) as { bookingId?: string; checkedStatus?: string; error?: string })
      : {};
    const cancel = record.action === "cancel";
    if (record.action === "reschedule" && op?.status === "succeeded") {
      return {
        phase: w.phase,
        reply: `Already moved: ${what}. Booking id: ${record.booking_id}. I didn't send it again.`,
        facts: w.facts,
        code: "APPROVAL_ALREADY_USED",
      };
    }
    const reply =
      op?.status === "succeeded"
        ? cancel
          ? `Already cancelled: ${what}. Booking id: ${record.booking_id}. I didn't send it again.`
          : `Already booked: ${what}. Booking id: ${result.bookingId}. I didn't book it again.`
        : op?.status === "in_flight"
          ? `I'm still confirming ${what} with the provider — I won't ${cancel ? "cancel" : "book"} it twice.`
          : `That approval was already used and nothing was ${cancel ? "cancelled" : "booked"} for ${what} (${result.checkedStatus ?? result.error ?? "failed"}).`;
    return { phase: w.phase, reply, facts: w.facts, code: "APPROVAL_ALREADY_USED" };
  }

  function cardOutcome(w: WorkflowRow, record: ApprovalRecord, reply: string, code?: string): ApplyOutcome {
    const name =
      (w.candidates as OptionBlock[] | null)?.find((b) => b.provider.id === record.provider_id)?.provider
        .name ?? record.provider_id;
    return {
      phase: w.phase,
      reply,
      facts: w.facts,
      parts: [approvalCardPart(record, name, slotLabel(record.slot))],
      ...(code ? { code } : {}),
    };
  }

  /**
   * Approve or decline (§ 2.5.5): only the card the user was shown, only while it is
   * pending and fresh. Anything else is APPROVAL_STALE / APPROVAL_ALREADY_USED, and
   * the current details are shown again.
   */
  function decideOn(
    w: WorkflowRow,
    approvalId: string | undefined,
    decision: "approve" | "decline",
    via: "button" | "typed",
  ): ApplyOutcome {
    const open = approvals.getOpen(w.id);
    const target = approvalId ? approvals.getById(approvalId) : open;
    if (target?.status === "used") return reportUsed(target);
    if (target && target.id === open?.id && target.status === "approved") {
      return cardOutcome(w, target, "You've already approved this booking.", "APPROVAL_ALREADY_USED");
    }
    if (!target || !open || target.id !== open.id || target.status !== "pending") {
      // R2: an old card's id never decides the current card
      return open
        ? cardOutcome(
            w,
            open,
            "That approval is no longer valid — the details changed. Here is the current one.",
            "APPROVAL_STALE",
          )
        : {
            phase: w.phase,
            reply: "That approval is no longer valid — nothing is waiting for your approval.",
            facts: w.facts,
            code: "APPROVAL_STALE",
          };
    }
    if (nowMs() - target.created_at > APPROVAL_MAX_AGE_MS) {
      voidOpenApproval(w, "expired");
      if (w.intent === "cancel") {
        const again = saveWorkflow(w.conversation_id, w.version, (wf) => ({
          ...wf,
          phase: "identifying_booking",
        }));
        if (!again.ok || !again.workflow)
          return { phase: w.phase, reply: "", code: "unknown_error", facts: w.facts };
        return {
          ...identifyTarget(
            again.workflow,
            "",
            target.booking_id ?? undefined,
            "That approval expired after 10 minutes, so I checked again. ",
          ),
          code: "APPROVAL_STALE",
        };
      }
      const saved = saveWorkflow(w.conversation_id, w.version, (wf) => ({
        ...wf,
        hold: null,
        phase: "holding",
      }));
      if (!saved.ok || !saved.workflow)
        return { phase: w.phase, reply: "", code: "unknown_error", facts: w.facts };
      const fresh = advance(saved.workflow); // re-hold the same slot → a new card
      return {
        ...fresh,
        reply: `That approval expired after 10 minutes, so I checked again. ${fresh.reply}`,
        code: "APPROVAL_STALE",
      };
    }
    const status = decision === "approve" ? "approved" : "declined";
    approvals.decide(target.id, status, via, nowMs());
    trace?.record("approval_event", {
      approvalId: target.id,
      event: status,
      via,
      action: target.action,
      providerId: target.provider_id,
      slot: target.slot,
      price: target.price,
    });
    if (decision === "approve") {
      // § 2.5.6 step 1 (Gate 1): approval used + operation created + workflow executing, one transaction
      let moved: WorkflowRow | undefined;
      const toExecuting = () => {
        moved = saveWorkflow(w.conversation_id, w.version, (wf) => ({ ...wf, phase: "executing" })).workflow;
        if (!moved) throw new Error("workflow changed while approving"); // rolls the whole step back
      };
      const started =
        target.action === "cancel"
          ? startCancelOperation(db, clock, target.id, { bookingId: target.booking_id! }, toExecuting)
          : target.action === "reschedule"
            ? startRescheduleOperation(
                db,
                clock,
                target.id,
                { bookingId: target.booking_id!, newSlot: target.slot },
                toExecuting,
              )
            : startBookOperation(
                db,
                clock,
                target.id,
                {
                  providerId: target.provider_id,
                  slot: target.slot,
                  price: target.price,
                  holdId: w.hold?.holdId ?? "",
                },
                toExecuting,
              );
      if (!started.ok && started.reason.includes("in progress")) {
        // R3: another conversation is already changing this booking
        return {
          phase: w.phase,
          reply:
            "Another change to this booking is already in progress, so I didn't do anything. Ask me again in a moment.",
          facts: w.facts,
          code: "BOOKING_IN_FLIGHT",
        };
      }
      if (!started.ok || !moved) return { phase: w.phase, reply: "", code: "unknown_error", facts: w.facts };
      trace?.record("operation_event", {
        event: "created",
        kind: target.action,
        key: started.operation.idempotency_key,
      });
      return advance(moved);
    }
    if (w.intent === "cancel") {
      // R9: declining a cancel ends it — the booking stays
      const ended = saveWorkflow(w.conversation_id, w.version, (wf) => ({ ...wf, phase: "abandoned" }));
      return {
        phase: "abandoned",
        reply: "Okay — I kept your booking. Nothing was cancelled.",
        facts: (ended.workflow ?? w).facts,
      };
    }
    // R9: decline goes back by intent — a booking returns to the same options
    const saved = saveWorkflow(w.conversation_id, w.version, (wf) => ({
      ...wf,
      selection: null,
      hold: null,
      phase: "choosing",
    }));
    if (!saved.ok || !saved.workflow)
      return { phase: w.phase, reply: "", code: "unknown_error", facts: w.facts };
    return optionsOutcome(saved.workflow, "Okay, not that one. Here are the options again.");
  }

  function optionsOutcome(w: WorkflowRow, reply: string): ApplyOutcome {
    return {
      phase: w.phase,
      reply,
      facts: w.facts,
      parts: [{ type: "option_blocks", blocks: w.candidates as OptionBlock[] }],
    };
  }

  /** NFR-3: a slot that can't be had is an answer, not a glitch — drop it and show what is left. */
  function showRemaining(w: WorkflowRow, gone: Selection, reply: string, code?: string): ApplyOutcome {
    const remaining = (w.candidates as OptionBlock[])
      .map((b) =>
        b.provider.id === gone.providerId ? { ...b, slots: b.slots.filter((s) => s.start !== gone.slot) } : b,
      )
      .filter((b) => b.slots.length > 0);
    const saved = saveWorkflow(w.conversation_id, w.version, (wf) => ({
      ...wf,
      candidates: remaining,
      selection: null,
      hold: null,
      phase: remaining.length ? "choosing" : "searching",
    }));
    if (!saved.ok || !saved.workflow)
      return { phase: w.phase, reply: "", code: "unknown_error", facts: w.facts };
    if (!remaining.length) return advance(saved.workflow);
    return { ...optionsOutcome(saved.workflow, reply), ...(code ? { code } : {}) };
  }

  /**
   * Wait for approval with a pending record built from the saved selection and hold —
   * never from model text (§ 2.5.5). The workflow save and the approval insert share
   * one transaction; the card is drawn from the record.
   */
  function awaitApproval(w: WorkflowRow, held: Held, reply?: string): ApplyOutcome {
    const selection = w.selection!;
    const searchPrice = (w.candidates as OptionBlock[]).find((b) => b.provider.id === selection.providerId)
      ?.provider.price;
    return openApproval(
      w,
      {
        action: "book",
        provider_id: selection.providerId,
        slot: selection.slot,
        price: held.quotedPrice,
        hold_id: held.holdId,
      }, // V-2: the quoted price
      { hold: held },
      nameOf(w, selection.providerId),
      (record) =>
        reply ??
        (searchPrice !== undefined && record.price !== searchPrice
          ? `The provider quoted ${rupees(record.price)} for this slot (the search showed ${rupees(searchPrice)}). Approve to book it at the new price, or decline.`
          : `Here are the details — approve to book, or decline.`),
    );
  }

  /**
   * One pending approval for the workflow (§ 2.5.5): the workflow moving to
   * `awaiting_approval` and the approval insert share one transaction; the card is drawn
   * from the stored record, never from model text.
   */
  function openApproval(
    w: WorkflowRow,
    input: Omit<NewApproval, "user_id" | "conversation_id" | "workflow_id">,
    patch: Partial<WorkflowRow>,
    providerName: string,
    reply: (record: ApprovalRecord) => string,
  ): ApplyOutcome {
    const result = db.transaction(() => {
      const saved = saveWorkflow(w.conversation_id, w.version, (wf) => ({
        ...wf,
        ...patch,
        phase: "awaiting_approval",
      }));
      if (!saved.ok || !saved.workflow) return undefined;
      const record = approvals.createPending(
        { user_id: w.user_id, conversation_id: w.conversation_id, workflow_id: w.id, ...input },
        nowMs(),
      );
      return { workflow: saved.workflow, record };
    })();
    if (!result) return { phase: w.phase, reply: "", code: "unknown_error", facts: w.facts };
    const { record } = result;
    trace?.record("approval_event", {
      approvalId: record.id,
      event: "created",
      action: record.action,
      providerId: record.provider_id,
      slot: record.slot,
      price: record.price,
    });
    return {
      phase: "awaiting_approval",
      reply: reply(record),
      facts: result.workflow.facts,
      parts: [approvalCardPart(record, providerName, slotLabel(record.slot))],
    };
  }

  /** `holding` needs no user input: hold the picked slot, then wait for approval. */
  function holdSelection(w: WorkflowRow): ApplyOutcome {
    const held = hold!(w.selection!);
    if (!held.ok)
      return showRemaining(
        w,
        w.selection!,
        "That slot was just taken — here are the options still open.",
        held.error,
      );
    return awaitApproval(w, {
      holdId: held.data.holdId,
      expiresAt: held.data.expiresAt,
      quotedPrice: held.data.quotedPrice,
    });
  }

  /**
   * `executing` → `verifying` → `done` (§ 2.5.6). The reply says "Booked:" only after
   * get_booking_status said booked (I-3); otherwise it reports the checked status (R5).
   */
  function executeOperation(w: WorkflowRow): ApplyOutcome {
    const op = operations.inFlightFor(w.id)!;
    if (op.kind !== "book") return executeChangeOp(w, op);
    let current = w;
    const outcome = executeBook(db, clock, bookTools!, op, () => {
      current =
        saveWorkflow(w.conversation_id, current.version, (wf) => ({ ...wf, phase: "verifying" })).workflow ??
        current;
    });
    if (!outcome.ok && outcome.kind === "hold_expired") return reHold(current, op);
    trace?.record("operation_event", {
      event: outcome.ok ? "succeeded" : "failed",
      kind: "book",
      key: op.idempotency_key,
      result: outcome.ok ? outcome.bookingId : outcome.checkedStatus,
    });
    if (!outcome.ok && outcome.kind === "slot_taken") {
      // the approval stays used; the user picks again from what is left
      return showRemaining(
        current,
        w.selection!,
        "That slot was taken by someone else just now, so nothing was booked — here are the options still open.",
        "slot_taken",
      );
    }
    const finished = saveWorkflow(w.conversation_id, current.version, (wf) => ({
      ...wf,
      phase: outcome.ok ? "done" : "failed",
    }));
    const facts = (finished.workflow ?? current).facts;
    if (!outcome.ok) {
      const exhausted = outcome.kind === "retries_exhausted";
      return {
        phase: "failed",
        reply: exhausted
          ? `Nothing was booked — the provider timed out ${MAX_BOOK_ATTEMPTS} times, and when I checked there was no booking (status: ${outcome.checkedStatus}). Ask me to try again.`
          : `Nothing was booked — I checked with the provider and there is no booking for this request (status: ${outcome.checkedStatus}). Ask me to try again.`,
        facts,
        code: exhausted ? "retries_exhausted" : "BOOKING_FAILED",
      };
    }
    const selection = w.selection!;
    return {
      phase: "done",
      reply: `Booked: ${nameOf(w, selection.providerId)} on ${slotLabel(selection.slot)}, ${rupees(w.hold?.quotedPrice ?? 0)}. Booking id: ${outcome.bookingId}.`,
      facts,
    };
  }

  /**
   * FR-5: a side question — answered from `list_bookings` (whose user is the signed-in
   * one, never a name in the text, V-7) without touching the request in progress.
   */
  function listMyBookings(active: WorkflowRow | undefined): ApplyOutcome {
    const phase = active?.phase ?? "none";
    const facts = active?.facts ?? ({} as Facts);
    const result = list!();
    if (!result.ok)
      return {
        phase,
        reply: "I couldn't read your bookings just now — please ask again.",
        facts,
        code: result.error,
      };
    const bookings = result.data.bookings.map(listItem);
    const reply = bookings.length
      ? `You have ${bookings.length} booking${bookings.length === 1 ? "" : "s"} — upcoming and past are below.`
      : "You have no bookings yet.";
    return { phase, reply, facts, parts: [{ type: "bookings_list", bookings }] };
  }

  /**
   * FR-3 / FR-4: a cancel or reschedule starts its own workflow in `identifying_booking`.
   * A request already in progress is never dropped silently — the user drops it first
   * (asking comes with U30).
   */
  /**
   * R6: sync the open workflow's memory-sourced facts against the memory store.
   * Forgotten → the fact is dropped (and asked again if still required, 2.5.8);
   * corrected → the fact takes the new value, built-on state clears (rule 2).
   * Returns note + updated workflow when something changed.
   */
  function syncMemoryFacts(
    current: WorkflowRow,
    userId: string,
  ): { note: string; workflow?: WorkflowRow } | undefined {
    const facts = { ...current.facts } as Facts;
    const notes: string[] = [];
    let changed = false;
    for (const key of ["area", "time_window"] as (keyof Facts)[]) {
      const fact = facts[key] as Fact | undefined;
      if (!fact || fact.source !== "memory" || !fact.memoryFactId) continue;
      const record =
        key === "area" ? memoryApi.state(db, userId, "area") : memoryApi.state(db, userId, "earliest_time");
      const stored = db
        .prepare(`SELECT status, value FROM memory_fact WHERE id = ?`)
        .get(fact.memoryFactId) as { status: string; value: string } | undefined;
      if (!stored) continue;
      if (stored.status === "forgotten" || !record) {
        // a time window merged from the request's days keeps those days; only the remembered bound goes
        const kept = key === "time_window" ? { ...(fact.value as TimeWindow), earliest: null } : null;
        if (kept && (kept.dateFrom !== null || kept.dateTo !== null || kept.latest !== null))
          facts.time_window = { value: kept, source: "user", updatedAt: nowMs() } as Fact & {
            value: TimeWindow;
          };
        else delete facts[key];
        changed = true;
        trace?.record("memory_event", { event: "blocked-by-forget", key, value: null });
        notes.push(
          key === "area"
            ? "Your saved area is gone — I'll ask for it again."
            : "Your saved time is gone — I've stopped using it.",
        );
        continue;
      }
      // corrected: for the time fact compare only the remembered bound
      const differ =
        key === "area"
          ? fact.value !== record.value
          : ((fact.value as TimeWindow).earliest ?? null) !== record.value;
      if (!differ) continue;
      if (key === "area") facts.area = memoryFactOf(key, record);
      else {
        const tw = { ...(fact.value as TimeWindow), earliest: record.value } as TimeWindow;
        facts.time_window = memoryFactOf(key, record, tw) as Fact & { value: TimeWindow };
      }
      changed = true;
      trace?.record("memory_event", { event: "used", key, value: record.value });
      notes.push(`Your saved ${key === "area" ? "area" : "time"} changed — using it.`);
    }
    if (!changed) return undefined;
    const saved = saveWorkflow(current.conversation_id, current.version, (w) => ({
      ...w,
      facts,
      phase: phaseAfterChange(current, true, facts),
      ...(changed ? { candidates: null, selection: null, hold: null } : {}),
    }));
    void saved;
    const fresh = getActive(current.conversation_id);
    return { note: notes.join(" "), workflow: fresh ?? undefined };
  }

  /** A fact built from a memory record: source stays honest, the record id travels (R6). */
  function memoryFactOf(_key: string, record: { id: string; value: string }, value?: unknown): Fact {
    return {
      value: value ?? record.value,
      source: "memory",
      updatedAt: nowMs(),
      memoryFactId: record.id,
    } as Fact;
  }

  function memoryView(current: WorkflowRow | undefined, userId: string): ApplyOutcome {
    const factsList = memoryApi.view(db, userId);
    const lines = factsList.map((f) => {
      const what =
        f.key === "area"
          ? `area — ${AREA_NAMES[f.value] ?? f.value}`
          : f.key === "earliest_time"
            ? `time — not before ${f.value}`
            : `preferred ${f.service ?? "provider"}`;
      return `${what} (${f.source === "stated" ? "you told me" : "I worked out — say yes to keep it"})`;
    });
    return {
      phase: current?.phase ?? "collecting",
      reply: lines.length
        ? `Here's what I remember: ${lines.join("; ")}.`
        : "I don't have anything saved for you yet.",
      facts: current?.facts ?? ({} as Facts),
    };
  }

  function memoryForget(
    current: WorkflowRow | undefined,
    userId: string,
    key: string,
    syncNote: string,
  ): ApplyOutcome {
    void current;
    if (key === "all") return memoryForgetAll(current, userId, syncNote);
    const result = memoryApi.forget(db, clock, userId, key, undefined, (record) =>
      trace?.record("memory_event", { event: "forgotten", key: record.key, value: record.value }),
    );
    if (!result.ok)
      return {
        phase: current?.phase ?? "collecting",
        reply: `${syncNote}There's nothing saved ${key === "area" ? "for your area" : `as ${key}`} to forget.`,
        facts: current?.facts ?? ({} as Facts),
      };
    return {
      phase: current?.phase ?? "collecting",
      reply: `${syncNote}Forgotten. I'll ask for it again next time we book.`,
      facts: current?.facts ?? ({} as Facts),
    };
  }

  /** "forget everything": every active fact is forgotten, every waiting one rejected (also a forget marker). */
  function memoryForgetAll(current: WorkflowRow | undefined, userId: string, syncNote: string): ApplyOutcome {
    const traced = (record: memoryApi.MemoryFactRecord) =>
      trace?.record("memory_event", { event: "forgotten", key: record.key, value: record.value });
    const facts = memoryApi.view(db, userId);
    for (const f of facts) {
      if (f.status === "active") memoryApi.forget(db, clock, userId, f.key, f.service ?? undefined, traced);
      else memoryApi.reject(db, clock, userId, f.id, traced);
    }
    const names = facts.map((f) =>
      f.key === "area"
        ? "area"
        : f.key === "earliest_time"
          ? "earliest time"
          : `preferred ${f.service ? (SERVICE_LABEL[f.service] ?? f.service) : "provider"}`,
    );
    return {
      phase: current?.phase ?? "collecting",
      reply: names.length
        ? `${syncNote}Forgotten: ${names.join(", ")}. I'll ask again next time we book.`
        : `${syncNote}There's nothing saved to forget.`,
      facts: current?.facts ?? ({} as Facts),
    };
  }

  function memorySave(
    current: WorkflowRow | undefined,
    userId: string,
    conversationId: string,
    read: Extract<ReadResult, { kind: "memory_save" }>,
    syncNote: string,
  ): ApplyOutcome {
    if (!read.value)
      return {
        phase: current?.phase ?? "collecting",
        reply: `${syncNote}Which ${read.key === "area" ? "area" : "time"} should I remember? Tell me the ${read.key === "area" ? "area" : "time"} in the same sentence.`,
        facts: current?.facts ?? ({} as Facts),
      };
    const record = memoryApi.saveStated(db, clock, userId, read.key, read.value, undefined, (event, r) =>
      trace?.record("memory_event", { event, key: r.key, value: r.value }),
    );
    const savedNote = `Saved: your saved ${read.key === "area" ? "area" : "earliest time"} is ${read.key === "area" ? (AREA_NAMES[read.value] ?? read.value) : `not before ${read.value}`}.`;
    // a lasting correction also corrects the open workflow's detail (2.5.8)
    if (current && current.intent) {
      const value =
        read.key === "area"
          ? { kind: "workflow", area: read.value }
          : {
              kind: "workflow",
              timeWindow: { dateFrom: null, dateTo: null, earliest: read.value, latest: null },
            };
      const applied = applyToWorkflow(conversationId, current, value as ReadResult);
      return { ...applied, reply: `${syncNote}${savedNote} ${applied.reply}`.trim() };
    }
    return {
      phase: current?.phase ?? "collecting",
      reply: `${syncNote}${savedNote}`,
      facts: current?.facts ?? ({} as Facts),
      code: record ? undefined : "unknown_error",
    };
  }

  /**
   * U33 (2.5.8): the same provider in this user's own completed bookings for the
   * service (or "same as last time") → an `awaiting_confirmation` fact with evidence
   * naming the bookings (V-12 checks forgotten markers first), plus one light yes/no
   * ask stored as the pending question (R9 priority 3). Skipped when memory already
   * answers the key or the user's own bookings never repeat a provider.
   */
  /**
   * 2.5.8: at most one inferred value is proposed per request, in this order — preferred
   * provider, area, earliest time — and only for a detail the request and active memory
   * leave open. `list_bookings` is called at most once for all of them.
   */
  function proposeFromHistory(
    w: WorkflowRow,
    userId: string,
    service: string | null,
    sameAsLast: boolean,
  ): Proposal | undefined {
    let listed: BookingRecord[] | null | undefined;
    const bookings = (): BookingRecord[] | null => {
      if (listed === undefined) {
        const result = list?.();
        listed = result?.ok ? result.data.bookings : null;
      }
      return listed;
    };
    const recordTrace = (event: "inferred" | "blocked-by-forget", r: { key: string; value: string }) =>
      trace?.record("memory_event", { event, key: r.key, value: r.value });
    if (service) {
      const provider = proposePreferredProvider(w, userId, service, sameAsLast, bookings, recordTrace);
      if (provider) return provider;
    }
    if (!w.facts.area && !memoryApi.state(db, userId, "area")) {
      const area = proposeArea(userId, bookings, recordTrace);
      if (area) return area;
    }
    const window = w.facts.time_window?.value ?? null;
    if (!window?.earliest && !memoryApi.state(db, userId, "earliest_time"))
      return proposeEarliestTime(userId, window, recordTrace);
    return undefined;
  }

  /** The same area in 2 completed bookings (any service), most recent first. */
  function proposeArea(
    userId: string,
    bookings: () => BookingRecord[] | null,
    recordTrace: (event: "inferred" | "blocked-by-forget", r: { key: string; value: string }) => void,
  ): Proposal | undefined {
    const days = new Map<string, string[]>();
    for (const b of bookings() ?? []) {
      if (b.status !== "completed") continue;
      const seen = [...(days.get(b.area) ?? []), b.slot.slice(0, 10)];
      days.set(b.area, seen);
      if (seen.length < 2) continue;
      const name = AREA_NAMES[b.area] ?? b.area;
      const result = memoryApi.inferCandidate(
        db,
        clock,
        userId,
        "area",
        b.area,
        null,
        `bookings in ${name} on ${seen.join(" and ")}`,
        recordTrace,
      );
      if (!result.created || !result.fact) return undefined;
      return {
        ask: `Your last two bookings were in ${name} — use ${name} again?`,
        factId: result.fact.id,
        key: "area",
        value: b.area,
        service: null,
        label: name,
      };
    }
    return undefined;
  }

  /** The same "not before X" the user gave in 2 finished bookings (our own workflows). */
  function proposeEarliestTime(
    userId: string,
    window: TimeWindow | null,
    recordTrace: (event: "inferred" | "blocked-by-forget", r: { key: string; value: string }) => void,
  ): Proposal | undefined {
    const rows = db
      .prepare(
        `SELECT facts, selection FROM workflow WHERE user_id = ? AND intent = 'book' AND phase = 'done' ORDER BY updated_at DESC, rowid DESC`,
      )
      .all(userId) as { facts: string; selection: string | null }[];
    const days = new Map<string, string[]>();
    for (const row of rows) {
      const tw = (JSON.parse(row.facts) as Facts).time_window;
      const earliest = tw?.source === "user" ? tw.value?.earliest : null;
      if (!earliest) continue;
      const slot = row.selection ? (JSON.parse(row.selection) as Selection).slot : "";
      const seen = [...(days.get(earliest) ?? []), slot.slice(0, 10)].filter(Boolean);
      days.set(earliest, seen);
      if (seen.length < 2) continue;
      if (window?.latest && window.latest <= earliest) return undefined; // would leave no time at all
      const result = memoryApi.inferCandidate(
        db,
        clock,
        userId,
        "earliest_time",
        earliest,
        null,
        `bookings not before ${earliest} on ${seen.join(" and ")}`,
        recordTrace,
      );
      if (!result.created || !result.fact) return undefined;
      return {
        ask: `Your last two bookings were not before ${earliest} — keep that as your earliest time?`,
        factId: result.fact.id,
        key: "earliest_time",
        value: earliest,
        service: null,
        label: earliest,
      };
    }
    return undefined;
  }

  function proposePreferredProvider(
    w: WorkflowRow,
    userId: string,
    service: string,
    sameAsLast: boolean,
    bookings: () => BookingRecord[] | null,
    recordTrace: (event: "inferred" | "blocked-by-forget", r: { key: string; value: string }) => void,
  ): Proposal | undefined {
    if (w.intent !== "book" || !service) return undefined;
    if (memoryApi.state(db, userId, "preferred_provider", service)) return undefined;
    const listedBookings = bookings();
    if (!listedBookings) return undefined;
    const completed = listedBookings.filter((b) => b.service === service && b.status === "completed");
    const byProvider = new Map<string, { name: string; days: string[] }>();
    for (const b of completed) {
      const e = byProvider.get(b.providerId) ?? { name: b.providerName, days: [] };
      e.days.push(b.slot.slice(0, 10));
      byProvider.set(b.providerId, e);
    }
    const entry = [...byProvider.entries()].find(([, e]) => e.days.length >= (sameAsLast ? 1 : 2));
    if (!entry) return undefined;
    const [providerId, pick] = entry;
    const label = SERVICE_NAMES[service] ?? service;
    const result = memoryApi.inferCandidate(
      db,
      clock,
      userId,
      "preferred_provider",
      providerId,
      service,
      sameAsLast
        ? `the same ${label} as last time — booked ${pick.name} on ${pick.days.join(" and ")}`
        : `${label} bookings with ${pick.name} on ${pick.days.join(" and ")}`,
      recordTrace,
    );
    if (!result.created || !result.fact) return undefined;
    const ask = sameAsLast
      ? `Your last ${label} booking was with ${pick.name} — keep them coming?`
      : `Your last two ${label} bookings were with ${pick.name} — keep them coming?`;
    return {
      ask,
      factId: result.fact.id,
      key: "preferred_provider",
      value: providerId,
      service,
      label: pick.name,
    };
  }

  /**
   * A memory card's yes / no (2.5.8): decided only while that exact fact is the waiting
   * question and still `awaiting_confirmation`. Another card's id, or a fact already
   * answered elsewhere (the memory panel), changes nothing and says so.
   */
  function answerMemoryCard(
    active: WorkflowRow | undefined,
    userId: string,
    factId: string,
    yes: boolean,
  ): ApplyOutcome {
    const pending = active?.pending_question
      ? (JSON.parse(active.pending_question) as { type?: string; factId?: string })
      : undefined;
    const phase = active?.phase ?? "collecting";
    const facts = active?.facts ?? ({} as Facts);
    if (!active || pending?.type !== "memory_confirm" || pending.factId !== factId)
      return {
        phase,
        reply: "That suggestion is no longer open — nothing changed.",
        facts,
        code: "MEMORY_CONFIRM_STALE",
      };
    if (memoryApi.byId(db, userId, factId)?.status !== "awaiting_confirmation") {
      const cleared = saveWorkflow(active.conversation_id, active.version, (w) => ({
        ...w,
        pending_question: null,
      }));
      return {
        phase,
        reply: "You already answered that in your memory panel — nothing changed here.",
        facts: (cleared.workflow ?? active).facts,
        code: "MEMORY_CONFIRM_STALE",
      };
    }
    return decideMemoryConfirm(active, userId, active.conversation_id, pending as never, yes);
  }

  /**
   * FR-6 (U31) comment header preserved for history; this function is decideMemoryConfirm.
   * R9 priority 3: answers the confirmed-memory yes/no (waited for no card and no switch
   * question, or it wouldn't exist).
   */
  function decideMemoryConfirm(
    current: WorkflowRow,
    userId: string,
    conversationId: string,
    pending: { factId: string; key: string; value: string; service: string | null; label: string },
    yes: boolean,
  ): ApplyOutcome {
    // the question clears first; the row it returns is the one every later save matches
    const cleared = saveWorkflow(conversationId, current.version, (w) => ({ ...w, pending_question: null }));
    const base = cleared.ok && cleared.workflow ? cleared.workflow : current;
    if (!yes) {
      memoryApi.reject(db, clock, userId, pending.factId, (record) =>
        trace?.record("memory_event", { event: "forgotten", key: record.key, value: record.value }),
      );
      return {
        phase: base.phase,
        reply:
          `Okay — I won't suggest that again. ${base.phase === "collecting" ? "" : "Picking up where we were."}`.trim(),
        facts: base.facts,
      };
    }
    memoryApi.confirm(db, clock, userId, pending.factId, (record) =>
      trace?.record("memory_event", { event: "confirmed", key: record.key, value: record.value }),
    );
    trace?.record("memory_event", { event: "used", key: pending.key, value: pending.value });
    // the confirmed fact applies to this booking right away
    if (pending.key === "preferred_provider")
      return applyPreferredProviderNow(base, pending.value, pending.label);
    const facts = { ...base.facts } as Facts;
    if (pending.key === "area") {
      facts.area = memoryFactOf(pending.key, { id: pending.factId, value: pending.value }) as Fact & {
        value: string;
      };
    } else {
      // the confirmed earliest time bounds the request's window and keeps its days
      const known = facts.time_window?.value ?? null;
      const window: TimeWindow = {
        dateFrom: known?.dateFrom ?? null,
        dateTo: known?.dateTo ?? null,
        earliest: pending.value,
        latest: known?.latest ?? null,
      };
      facts.time_window = memoryFactOf(
        pending.key,
        { id: pending.factId, value: pending.value },
        window,
      ) as Fact & {
        value: TimeWindow;
      };
    }
    const saved = saveWorkflow(conversationId, base.version, (w) => ({
      ...w,
      facts,
      phase: phaseAfterChange(base, true, facts),
    }));
    if (!saved.ok || !saved.workflow)
      return { phase: base.phase, reply: "", code: "unknown_error", facts: base.facts };
    const outcome = advance(saved.workflow);
    return {
      ...outcome,
      reply:
        `${pending.key === "area" ? `Using your saved area: ${AREA_NAMES[pending.value] ?? pending.value}.` : `Using your saved time: not before ${pending.value}.`} ${outcome.reply}`.trim(),
    };
  }

  /** The confirmed provider narrows the options on screen to just their slots. */
  function applyPreferredProviderNow(
    current: WorkflowRow,
    providerId: string,
    providerName: string,
  ): ApplyOutcome {
    const blocks = (current.candidates as OptionBlock[]) ?? [];
    const kept = blocks.filter((b) => b.provider.id === providerId);
    if (!kept.length)
      return {
        phase: current.phase,
        reply: `Saved: ${providerName} is your preferred ${current.facts.service?.value ? `${SERVICE_NAMES[String(current.facts.service.value)] ?? current.facts.service.value} provider` : "provider"} from now on. (No free slot with them right now.)`,
        facts: current.facts,
      };
    const saved = saveWorkflow(current.conversation_id, current.version, (w) => ({ ...w, candidates: kept }));
    if (!saved.ok || !saved.workflow)
      return { phase: current.phase, reply: "", code: "unknown_error", facts: current.facts };
    return optionsOutcome(
      saved.workflow,
      `Saved your choice: ${providerName}. Here are their times — tap one and press Confirm.`,
    );
  }

  /**
   * FR-6 (U31): answer a details question without touching the workflow — the reply is
   * built from structured fields only (2.5.7 rule 2) and reviews ride as a labelled part
   * the model's read never saw (rule 1). Only the user's ask brings them here.
   */
  function providerDetails(active: WorkflowRow | undefined, providerId?: string): ApplyOutcome {
    if (!providerId)
      return {
        phase: active?.phase ?? "collecting",
        reply: "Use the “Details” link under a provider in the results — or search for a service first.",
        facts: active?.facts ?? ({} as Facts),
      };
    if (!getProvider)
      return {
        phase: active?.phase ?? "collecting",
        reply: "",
        code: "unknown_error",
        facts: active?.facts ?? ({} as Facts),
      };
    const found = getProvider(providerId);
    if (!found.ok)
      return {
        phase: active?.phase ?? "collecting",
        reply: "I couldn't get that provider's details just now — please try again.",
        facts: active?.facts ?? ({} as Facts),
        code: found.error,
      };
    const d = found.data;
    const bits = [
      `${d.name} — ${SERVICE_NAMES[d.service] ?? d.service}, ${rupees(d.price)}, rating ${d.rating}`,
      d.attributes?.verified === true ? ", verified" : "",
      typeof d.attributes?.warranty_days === "number" && d.attributes.warranty_days > 0
        ? `, ${d.attributes.warranty_days}-day warranty`
        : "",
    ];
    return {
      phase: active?.phase ?? "collecting",
      reply: `${bits.join("")}. Reviews are below exactly as the provider returned them — not checked.`,
      facts: active?.facts ?? ({} as Facts),
      parts: [
        {
          type: "provider_details",
          provider: { id: d.id, name: d.name, service: d.service, price: d.price, rating: d.rating },
          reviews: d.reviews.map((r) => ({
            text: r.text,
            ...(r.suspectedInjection ? { suspectedInjection: true } : {}),
          })),
        },
      ],
    };
  }

  /**
   * FR-15: a different request on an unfinished workflow asks before dropping it. R9:
   * with an approval card open the question would stack, so the card is resolved first;
   * while `executing` / `verifying` the switch waits for the outcome. Otherwise the
   * question is stored — a plain "yes" drops the current request and starts the new one.
   */
  function askBeforeSwitch(
    current: WorkflowRow,
    intent: "book" | "cancel" | "reschedule",
    newService: string | null,
    text: string,
  ): ApplyOutcome {
    if (current.phase === "executing" || current.phase === "verifying") {
      return {
        phase: current.phase,
        reply: "I'm still confirming the booking — I'll ask about the new request once that's done.",
        facts: current.facts,
        code: "TASK_IN_PROGRESS",
      };
    }
    if (approvals.getOpen(current.id))
      return {
        phase: current.phase,
        reply: "Please approve or decline the card above first — then send the new request again.",
        facts: current.facts,
        code: "TASK_IN_PROGRESS",
      };
    const saved = saveWorkflow(current.conversation_id, current.version, (w) => ({
      ...w,
      pending_question: JSON.stringify({ type: "task_switch", text, intent }),
    }));
    if (!saved.ok || !saved.workflow)
      return { phase: current.phase, reply: "", code: "unknown_error", facts: current.facts };
    return {
      phase: current.phase,
      reply: `You haven't finished ${taskLabel(current.intent, typeof current.facts.service?.value === "string" ? current.facts.service.value : null)}. Drop it and ${newRequestLabel(intent, newService)}?`,
      facts: current.facts,
    };
  }

  function startChange(
    intent: "cancel" | "reschedule",
    userId: string,
    conversationId: string,
    active: WorkflowRow | undefined,
    text: string,
    timeWindow?: TimeWindow,
  ): ApplyOutcome {
    if (active) {
      if (active.intent !== intent) return askBeforeSwitch(active, intent, findService(text).service, text);
      return {
        phase: active.phase,
        reply: `A ${CHANGE_VERB[intent]} request is already in progress — say “never mind” to drop it first, then send it again.`,
        facts: active.facts,
        code: "TASK_IN_PROGRESS",
      };
    }
    const facts = (timeWindow ? { time_window: fact("time_window", timeWindow) } : {}) as Facts;
    const saved = saveWorkflow(conversationId, -1, (w) => ({
      ...w,
      user_id: userId,
      intent,
      facts,
      phase: "identifying_booking",
    }));
    if (!saved.ok || !saved.workflow)
      return { phase: "none", reply: "", code: "unknown_error", facts: {} as Facts };
    trace?.record("state_transition", {
      fromPhase: "none",
      toPhase: "identifying_booking",
      reason: "workflow started",
    });
    return identifyTarget(saved.workflow, text);
  }

  /**
   * Which upcoming booking? Matched against the user's own `list_bookings` (V-7): a
   * booking id in the text, else the service, else a provider name, else all of them.
   * None (`BOOKING_NOT_FOUND`) or several (`BOOKING_AMBIGUOUS`) → stay and ask which.
   * One → cancel: a card with the booking's provider, slot and price; reschedule: its
   * service and area become the search's, then the new time is asked for or searched.
   */
  function identifyTarget(w: WorkflowRow, text: string, bookingId?: string, lead = ""): ApplyOutcome {
    const verb = CHANGE_VERB[w.intent as "cancel" | "reschedule"];
    const listed = list!();
    if (!listed.ok)
      return {
        phase: w.phase,
        reply: "I couldn't read your bookings just now — please try again.",
        facts: w.facts,
        code: listed.error,
      };
    const upcoming = listed.data.bookings.filter((b) => b.status === "booked");
    const matches = bookingId ? upcoming.filter((b) => b.id === bookingId) : matchBookings(upcoming, text);
    if (matches.length !== 1) {
      const service = findService(text).service;
      const reply =
        matches.length > 1
          ? `Which booking do you want to ${verb}? Tell me the service or the booking id.`
          : `I can't find an upcoming ${service ? `${SERVICE_NAMES[service] ?? service} ` : ""}booking to ${verb}. ${upcoming.length ? "These are your upcoming bookings — which one?" : "You have no upcoming bookings."}`;
      return {
        phase: w.phase,
        reply: lead + reply,
        facts: w.facts,
        code: matches.length > 1 ? "BOOKING_AMBIGUOUS" : "BOOKING_NOT_FOUND",
        parts: [{ type: "bookings_list", bookings: upcoming.map(listItem) }],
      };
    }
    const b = matches[0]!;
    if (w.intent === "cancel") {
      const target: OptionBlock = {
        provider: { id: b.providerId, name: b.providerName, rating: 0, price: b.price },
        slots: [],
      };
      return openApproval(
        w,
        { action: "cancel", provider_id: b.providerId, slot: b.slot, price: b.price, booking_id: b.id },
        {
          target_booking_id: b.id,
          candidates: [target],
          selection: { providerId: b.providerId, slot: b.slot },
        },
        b.providerName,
        () => `${lead}Here are the details — approve to cancel this booking, or decline.`,
      );
    }
    const saved = saveWorkflow(w.conversation_id, w.version, (wf) => ({
      ...wf,
      target_booking_id: b.id,
      facts: { ...wf.facts, service: fact("service", b.service), area: fact("area", b.area) },
      phase: wf.facts.time_window ? "searching" : "collecting",
    }));
    if (!saved.ok || !saved.workflow)
      return { phase: w.phase, reply: "", code: "unknown_error", facts: w.facts };
    if (saved.workflow.phase === "collecting") {
      return {
        phase: "collecting",
        reply: `${lead}When would you like to move your ${b.providerName} booking (now ${slotLabel(b.slot)}) to?`,
        facts: saved.workflow.facts,
      };
    }
    return searchReschedule(saved.workflow, b); // just read: no second list_bookings in this run
  }

  /**
   * V-3: new slots come from `search_providers` in the booking's area, kept to the booked
   * provider, without the booking's own slot. V-9: the blocks show the booking's price —
   * a reschedule keeps it. The booking is re-read each time (no local copy of bookings).
   */
  function searchReschedule(w: WorkflowRow, justRead?: BookingRecord): ApplyOutcome {
    const listed = justRead ? undefined : list!();
    const b =
      justRead ??
      (listed?.ok
        ? listed.data.bookings.find((x) => x.id === w.target_booking_id && x.status === "booked")
        : undefined);
    if (!b) {
      const ended = saveWorkflow(w.conversation_id, w.version, (wf) => ({ ...wf, phase: "failed" }));
      return {
        phase: "failed",
        reply: "That booking isn't upcoming any more, so there's nothing to move.",
        facts: (ended.workflow ?? w).facts,
        code: "BOOKING_NOT_FOUND",
      };
    }
    const timeWindow = w.facts.time_window!.value!;
    const found = search!({ service: b.service, area: b.area, ...searchRange(timeWindow, clock) });
    if (!found.ok)
      return {
        phase: w.phase,
        reply: "I couldn't reach the provider service just now — try again in a moment.",
        facts: w.facts,
        code: found.error,
      };
    const options = buildOptions(found.data.providers, { timeWindow, budget: undefined });
    const blocks = (options.ok ? options.blocks : [])
      .filter((x) => x.provider.id === b.providerId)
      .map((x) => ({
        provider: { ...x.provider, price: b.price },
        slots: x.slots
          .filter((s) => s.start !== b.slot)
          .map((s) => ({ ...s, pickText: movePickText(b.providerName, s.start) })),
      }))
      .filter((x) => x.slots.length > 0);
    const saved = saveWorkflow(w.conversation_id, w.version, (wf) => ({
      ...wf,
      candidates: blocks,
      phase: blocks.length ? "choosing" : "searching",
    }));
    if (!saved.ok || !saved.workflow)
      return { phase: w.phase, reply: "", code: "unknown_error", facts: w.facts };
    if (!blocks.length) {
      return {
        phase: "searching",
        reply: `${b.providerName} has no free slot in that time — want to try another day or time?`,
        facts: saved.workflow.facts,
        code: "NO_MATCHES",
      };
    }
    return optionsOutcome(
      saved.workflow,
      `${b.providerName} can do these times — tap one and press Confirm. Your price stays ${rupees(b.price)}.`,
    );
  }

  /** A reschedule has no hold step: the picked slot goes straight to an approval at the booking's price (V-9). */
  function proposeReschedule(w: WorkflowRow): ApplyOutcome {
    const selection = w.selection!;
    const block = (w.candidates as OptionBlock[]).find((b) => b.provider.id === selection.providerId)!;
    return openApproval(
      w,
      {
        action: "reschedule",
        provider_id: selection.providerId,
        slot: selection.slot,
        price: block.provider.price,
        booking_id: w.target_booking_id!,
      },
      {},
      block.provider.name,
      () => "Here are the details — approve to move your booking, or decline.",
    );
  }

  /**
   * `executing` a cancel or reschedule (§ 2.5.6): R3 re-check, transient failures retried
   * with the same key, an unclear outcome settled by list_bookings. The reply claims the
   * change only when it happened; a reschedule `slot_conflict` goes back to the other times.
   */
  function executeChangeOp(w: WorkflowRow, op: OperationRecord): ApplyOutcome {
    const approval = approvals.getById(op.approval_id)!;
    const cancel = op.kind === "cancel";
    const outcome = cancel
      ? executeCancel(db, clock, cancelTools!, op, { providerId: approval.provider_id, slot: approval.slot })
      : executeReschedule(db, clock, rescheduleTools!, op, {
          providerId: approval.provider_id,
          price: approval.price,
        });
    trace?.record("operation_event", {
      event: outcome.ok ? "succeeded" : "failed",
      kind: op.kind,
      key: op.idempotency_key,
      result: outcome.ok ? op.booking_id : outcome.checkedStatus,
    });
    const name = nameOf(w, approval.provider_id);
    if (!outcome.ok && outcome.kind === "slot_conflict") {
      return showRemaining(
        w,
        w.selection!,
        `That time was just taken at ${name}, so your booking didn't move — here are the other times.`,
        "slot_conflict",
      );
    }
    if (
      !outcome.ok &&
      outcome.kind === "booking_changed" &&
      approvals.voidUsed(approval.id, "booking_changed", nowMs())
    ) {
      trace?.record("approval_event", {
        approvalId: approval.id,
        event: "voided",
        voidReason: "booking_changed",
      });
    }
    const finished = saveWorkflow(w.conversation_id, w.version, (wf) => ({
      ...wf,
      phase: outcome.ok ? "done" : "failed",
    }));
    const facts = (finished.workflow ?? w).facts;
    if (outcome.ok) {
      return {
        phase: "done",
        reply: cancel
          ? `Cancelled: ${name} on ${slotLabel(approval.slot)}. Booking id: ${op.booking_id}.`
          : `Moved: ${name} to ${slotLabel(approval.slot)}, price unchanged at ${rupees(approval.price)}. Booking id: ${op.booking_id}.`,
        facts,
      };
    }
    if (outcome.kind === "booking_changed") {
      return {
        phase: "failed",
        reply: `That booking changed since you approved (it's now ${outcome.checkedStatus}), so I didn't ${CHANGE_VERB[cancel ? "cancel" : "reschedule"]} it. Ask again if you still want to change it.`,
        facts,
        code: "booking_changed",
      };
    }
    return {
      phase: "failed",
      reply: cancel
        ? `Nothing was cancelled — the provider didn't confirm it, and your booking is still ${outcome.checkedStatus}. Ask me to try again.`
        : `Your booking didn't move — the provider didn't confirm it, and it's still at its old time. Ask me to try again.`,
      facts,
      code: cancel ? "CANCEL_FAILED" : "RESCHEDULE_FAILED",
    };
  }

  /**
   * A change whose outcome is unknown (restart with an old approval, or an unknown error):
   * the booking itself says. Undefined when it can't be read.
   */
  function settleChangeByList(
    w: WorkflowRow,
    op: OperationRecord,
    failedLead: string,
  ): ApplyOutcome | undefined {
    let listed: ReturnType<ListTool> | undefined;
    try {
      listed = list?.();
    } catch {
      listed = undefined;
    }
    const b = listed?.ok ? listed.data.bookings.find((x) => x.id === op.booking_id) : undefined;
    if (!b) return undefined;
    const { newSlot } = JSON.parse(op.request) as { newSlot?: string };
    const happened =
      op.kind === "cancel" ? b.status === "cancelled" : b.status === "booked" && b.slot === newSlot;
    const what = `${b.providerName} on ${slotLabel(b.slot)}`;
    operations.finish(
      op.id,
      happened ? "succeeded" : "failed",
      { bookingId: op.booking_id, checkedStatus: b.status },
      nowMs(),
    );
    trace?.record("operation_event", {
      event: happened ? "succeeded" : "failed",
      kind: op.kind,
      key: op.idempotency_key,
      result: b.status,
    });
    const finished = saveWorkflow(w.conversation_id, w.version, (wf) => ({
      ...wf,
      phase: happened ? "done" : "failed",
    }));
    const facts = (finished.workflow ?? w).facts;
    const change = op.kind === "cancel" ? "cancelled" : "moved";
    return happened
      ? { phase: "done", reply: `Your booking was ${change}: ${what}. Booking id: ${op.booking_id}.`, facts }
      : {
          phase: "failed",
          reply: `${failedLead} Your booking wasn't ${change} — it's still ${what}. Ask me again if you still want to change it.`,
          facts,
        };
  }

  /** The provider has the booking though the run never finished it: record it and report it. */
  function finishFoundBooking(w: WorkflowRow, op: OperationRecord, bookingId: string): ApplyOutcome {
    const selection = w.selection!;
    operations.finish(op.id, "succeeded", { bookingId, recovered: true }, nowMs());
    trace?.record("operation_event", {
      event: "succeeded",
      kind: "book",
      key: op.idempotency_key,
      result: bookingId,
    });
    const finished = saveWorkflow(w.conversation_id, w.version, (wf) => ({ ...wf, phase: "done" }));
    return {
      phase: "done",
      reply: `Your booking went through: ${nameOf(w, selection.providerId)} on ${slotLabel(selection.slot)}, ${rupees(w.hold?.quotedPrice ?? 0)}. Booking id: ${bookingId}.`,
      facts: (finished.workflow ?? w).facts,
    };
  }

  /**
   * Status first, never a blind retry: `booked` → done; `not_found` while the hold is still
   * valid → resume with the same key (the approval still covers it); otherwise nothing was
   * booked — hold the slot again and ask for a fresh approval. Never books long after the yes.
   */
  function recoverOperation(w: WorkflowRow, op: OperationRecord): ApplyOutcome {
    const checked = bookTools!.status(op.idempotency_key);
    const status = checked.ok ? checked.data.status : checked.error;
    if (checked.ok && status === "booked" && checked.data.bookingId)
      return finishFoundBooking(w, op, checked.data.bookingId);
    if (status === "not_found" && (w.hold?.expiresAt ?? 0) > nowMs()) return executeOperation(w);
    const holdRanOut = status === "not_found";
    operations.finish(
      op.id,
      "failed",
      { error: holdRanOut ? "hold_expired" : status, checkedStatus: status, recovered: true },
      nowMs(),
    );
    trace?.record("operation_event", {
      event: "failed",
      kind: "book",
      key: op.idempotency_key,
      result: status,
    });
    const saved = saveWorkflow(w.conversation_id, w.version, (wf) => ({
      ...wf,
      hold: null,
      phase: "holding",
    }));
    if (!saved.ok || !saved.workflow)
      return { phase: w.phase, reply: "", code: "unknown_error", facts: w.facts };
    const next = advance(saved.workflow); // re-hold the same slot → a new card, or the options left
    const why = holdRanOut
      ? "the server restarted before your booking finished, and the hold ran out"
      : `the provider says ${status}`;
    return { ...next, reply: `Nothing was booked — ${why}. ${next.reply}` };
  }

  /**
   * § 2.5.6 `hold_expired`: re-hold the same provider + slot. Same price → the next key
   * (`:2`) and book again — the approval stands (V-4). A new price or a gone slot voids
   * the approval: nothing is booked until the user decides again.
   */
  function reHold(w: WorkflowRow, op: OperationRecord): ApplyOutcome {
    const selection = w.selection!;
    const approval = approvals.getById(op.approval_id)!;
    const held = hold!(selection);
    if (held.ok && held.data.quotedPrice === approval.price && op.hold_seq < MAX_BOOK_ATTEMPTS) {
      const next = operations.nextKey(op.id, held.data.holdId, "hold_expired", nowMs());
      trace?.record("operation_event", {
        event: "key_changed",
        kind: "book",
        key: next.idempotency_key,
        result: "hold_expired",
      });
      const saved = saveWorkflow(w.conversation_id, w.version, (wf) => ({
        ...wf,
        hold: {
          holdId: held.data.holdId,
          expiresAt: held.data.expiresAt,
          quotedPrice: held.data.quotedPrice,
        },
      }));
      if (!saved.ok || !saved.workflow)
        return { phase: w.phase, reply: "", code: "unknown_error", facts: w.facts };
      return executeOperation(saved.workflow);
    }
    const reason = held.ok ? "price_changed" : "slot_changed";
    operations.finish(
      op.id,
      "failed",
      { error: "hold_expired", rehold: held.ok ? reason : held.error },
      nowMs(),
    );
    trace?.record("operation_event", {
      event: "failed",
      kind: "book",
      key: op.idempotency_key,
      result: reason,
    });
    if (approvals.voidUsed(approval.id, reason, nowMs())) {
      trace?.record("approval_event", { approvalId: approval.id, event: "voided", voidReason: reason });
    }
    if (!held.ok) {
      return showRemaining(
        w,
        selection,
        "The hold on that slot ran out and the slot is gone now, so nothing was booked — here are the options still open.",
        "slot_changed",
      );
    }
    return awaitApproval(
      w,
      { holdId: held.data.holdId, expiresAt: held.data.expiresAt, quotedPrice: held.data.quotedPrice },
      `The hold ran out and the provider now quotes ${rupees(held.data.quotedPrice)} instead of ${rupees(approval.price)}, so nothing was booked yet. Approve the new price, or decline.`,
    );
  }

  /** Phases that need no user input run now (§ 2.5.3 step 6): searching, holding, executing. */
  function advance(w: WorkflowRow): ApplyOutcome {
    if (w.phase === "executing" && bookTools) return executeOperation(w);
    if (w.phase === "holding" && w.intent === "reschedule") return proposeReschedule(w);
    if (w.phase === "searching" && w.intent === "reschedule" && search && list) return searchReschedule(w);
    if (w.phase === "holding" && hold) return holdSelection(w);
    if (w.phase !== "searching" || !search) return replyFor(w);
    const service = String(w.facts.service!.value);
    const area = String(w.facts.area!.value);
    const timeWindow = w.facts.time_window!.value!;
    const found = search({ service, area, ...searchRange(timeWindow, clock) });
    // MH-6 (U33): an active preferred provider for this service narrows the search — the
    // user confirmed it; only structured ids, never free text (2.5.7 rule 2)
    const preferred = memoryApi.state(db, w.user_id, "preferred_provider", service);
    const preferredName =
      preferred && found.ok ? found.data.providers.find((p) => p.id === preferred.value)?.name : undefined;
    const filtered =
      preferred && found.ok
        ? found.data.providers.filter((p) => p.id === preferred.value)
        : found.ok
          ? found.data.providers
          : [];
    if (preferredName && preferred)
      trace?.record("memory_event", { event: "used", key: "preferred_provider", value: preferred.value });
    if (!found.ok) {
      return {
        phase: w.phase,
        reply: "I couldn't reach the provider service just now — try again in a moment.",
        facts: w.facts,
        code: found.error,
      };
    }
    const options = buildOptions(filtered.length ? filtered : found.data.providers, {
      timeWindow,
      budget: w.facts.budget?.value,
    });
    const what = `${SERVICE_NAMES[service] ?? service} in ${AREA_NAMES[area] ?? area}`;
    if (!options.ok) {
      const saved = saveWorkflow(w.conversation_id, w.version, (wf) => ({ ...wf, candidates: [] }));
      const reply =
        options.filter === "budget"
          ? `Nobody offering ${what} fits your budget — the cheapest is ₹${options.cheapest.toLocaleString("en-IN")}. Want to raise the budget?`
          : preferred
            ? `Your saved ${SERVICE_NAMES[service] ?? service} choice has no free slot in that time — want a wider time window?`
            : `Nobody offering ${what} has a free slot in that time. Want to try a wider time window?`;
      return { phase: "searching", reply, facts: (saved.workflow ?? w).facts, code: "NO_MATCHES" };
    }
    const saved = saveWorkflow(w.conversation_id, w.version, (wf) => ({
      ...wf,
      candidates: options.blocks,
      phase: "choosing",
    }));
    if (!saved.ok || !saved.workflow)
      return { phase: w.phase, reply: "", code: "unknown_error", facts: w.facts };
    const count = options.blocks.length;
    const preferredNote = preferredName ? `Using your saved choice: ${preferredName}. ` : "";
    return {
      phase: "choosing",
      reply: `${preferredNote}I found ${count} option${count === 1 ? "" : "s"} for ${what}. Tap a slot and press Confirm, or tell me the provider and time.`,
      facts: saved.workflow.facts,
      parts: [{ type: "option_blocks", blocks: saved.workflow.candidates as OptionBlock[] }],
    };
  }

  /** Rule 2: a changed fact rebuilds what was made from it (candidates and later). */
  function phaseAfterChange(current: WorkflowRow, changed: boolean, facts: Facts): string {
    const next = nextPhase(facts);
    if (!changed) return next;
    if (next === "searching") return "searching";
    return next;
  }

  function replyFor(w: WorkflowRow, errorCode?: string): ApplyOutcome {
    if (errorCode === "UNKNOWN_SERVICE") {
      return {
        phase: w.phase,
        reply: `I book these services: plumbing, electrical work, AC servicing, deep cleaning, carpentry. Which one?`,
        facts: w.facts,
        code: errorCode,
      };
    }
    if (errorCode === "UNKNOWN_AREA") {
      return {
        phase: w.phase,
        reply: `I book in Indiranagar, Koramangala, HSR Layout, Jayanagar and Whitefield — which one?`,
        facts: w.facts,
        code: errorCode,
      };
    }
    const area = typeof w.facts.area?.value === "string" ? w.facts.area.value : null;

    if (errorCode === TIME_OUT_OF_RANGE) {
      const inArea = area ? ` in ${AREA_NAMES[area] ?? area}` : "";
      return {
        phase: w.phase,
        reply: `I can only book within the next 14 days${inArea} and that time is in the past — tell me another time.`,
        facts: w.facts,
        code: TIME_OUT_OF_RANGE,
      };
    }

    // a detail a waiting memory question would answer isn't asked a second time in the same reply
    const proposing = pendingMemoryKey(w);
    const missing = missingFacts(w.facts).filter(
      (key) =>
        !(proposing === "area" && key === "area") &&
        !(proposing === "earliest_time" && key === "time_window"),
    );
    if (w.phase === "collecting" && missing.length > 0) {
      const asks = missing.map((key) =>
        key === "area" ? "which area" : key === "time_window" ? "when" : `which ${key}`,
      );
      // the known details as the user reads them ("Plumbing in HSR Layout"), never raw ids
      const service = w.facts.service?.value as string | undefined;
      const area = w.facts.area?.value as string | undefined;
      const serviceName = service ? (SERVICE_NAMES[service] ?? service) : "";
      const areaName = area ? (AREA_NAMES[area] ?? area) : "";
      const known = serviceName && areaName ? `${serviceName} in ${areaName}` : serviceName || areaName;
      const subject = known ? known[0]!.toUpperCase() + known.slice(1) : "";
      return {
        phase: "collecting",
        reply: subject
          ? `${subject} — ${asks.join(" and ")}?`
          : `${asks.join(" and ")[0]!.toUpperCase()}${asks.join(" and ").slice(1)}?`,
        facts: w.facts,
        code: errorCode,
      };
    }
    return { phase: w.phase, reply: "", facts: w.facts, code: errorCode };
  }
};
