import { randomUUID } from "node:crypto";
import type { Db } from "../shared/db.js";
import type { Clock } from "../shared/clock.js";
import type { AgentModel, ReadResult } from "./index.js";
import { mergeCorrection, TIME_OUT_OF_RANGE, type TimeWindow } from "./time-window.js";
import type { Trace } from "../tracing/index.js";
import type { ProviderSummary, ToolResult } from "../tools/index.js";
import { buildOptions, searchRange, type OptionBlock } from "./options.js";
import { approvalCardPart, approvalRepo } from "../approval/index.js";

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

export type ApplyOutcome = { phase: string; reply: string; facts: Facts; code?: string; parts?: Record<string, unknown>[] };

/** `search_providers` through the run's tool gateway (the only way to the provider API). */
export type SearchTool = (args: { service: string; area: string; from: string; to: string }) => ToolResult<{ providers: ProviderSummary[] }>;

/** `hold_slot` through the run's tool gateway. */
export type HoldTool = (args: Selection) => ToolResult<{ holdId: string; slot: string; quotedPrice: number; expiresAt: number }>;

/** What the run applying a message lends the store: its trace (MH-7) and its tools. */
export type RunTools = { trace?: Trace; search?: SearchTool; hold?: HoldTool };

const REQUIRED = ["service", "area", "time_window"] as const;

export const SERVICE_NAMES: Record<string, string> = {
  plumber: "plumbing",
  electrician: "electrical work",
  ac_servicing: "AC servicing",
  deep_cleaning: "deep cleaning",
  carpentry: "carpentry",
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
const timeFactHasBounds = (fact: Fact & { value: TimeWindow | null } | undefined): boolean => {
  const w = fact?.value;
  return !!w && (w.dateFrom !== null || w.dateTo !== null || w.earliest !== null || w.latest !== null);
};

export const createWorkflowStore = (db: Db, clock: Clock, model: AgentModel) => {
  let trace: Trace | undefined;
  let search: SearchTool | undefined;
  let hold: HoldTool | undefined;
  const approvals = approvalRepo(db);
  const nowMs = () => clock.now().getTime();

  const getActive = (conversationId: string): WorkflowRow | undefined => {
    const row = db
      .prepare(`SELECT * FROM workflow WHERE conversation_id = ? AND phase NOT IN ('done','failed','abandoned') ORDER BY updated_at DESC LIMIT 1`)
      .get(conversationId) as WorkflowRecord | undefined;
    return row ? decode(row) : undefined;
  };

  const fact = (key: keyof Facts, value: unknown): Fact => ({ value, source: "user", updatedAt: nowMs() }) as Fact;

  /** Collect or advance: with every required fact present the phase is `searching`. */
  const nextPhase = (facts: Facts): string => {
    const missing = REQUIRED.some((key) => !facts[key] || (key === "time_window" && !timeFactHasBounds(facts.time_window as Fact & { value: TimeWindow | null })));
    return missing ? "collecting" : "searching";
  };

  const missingFacts = (facts: Facts): (typeof REQUIRED)[number][] =>
    REQUIRED.filter((key) => {
      const f = facts[key];
      if (!f) return true;
      if (key === "time_window") return !timeFactHasBounds(facts.time_window as Fact & { value: TimeWindow | null });
      return f.value === undefined;
    });

  /** Save with optimistic concurrency: the version must match the row’s current one (or -1 to insert). */
  const saveWorkflow = (conversationId: string, expectedVersion: number, mutate: (w: WorkflowRow) => WorkflowRow): { ok: boolean; workflow?: WorkflowRow } => {
    const existing = getActive(conversationId);
    if (expectedVersion !== -1 && (!existing || existing.version !== expectedVersion)) return { ok: false };
    if (expectedVersion === -1) {
      if (existing) return { ok: false }; // only one active workflow per conversation
      const w = mutate({
        id: randomUUID(), conversation_id: conversationId, user_id: "", intent: null,
        phase: "collecting", facts: {}, candidates: null, selection: null, hold: null, target_booking_id: null,
        pending_question: null, version: 0, updatedAt: nowMs(),
      } as WorkflowRow);
      try {
        db.prepare(
          `INSERT INTO workflow (id, conversation_id, user_id, intent, phase, facts, candidates, selection, hold, target_booking_id, pending_question, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        ).run(w.id, conversationId, w.user_id, w.intent, w.phase, JSON.stringify(w.facts), json(w.candidates), json(w.selection), json(w.hold), w.target_booking_id, w.pending_question, nowMs(), nowMs());
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
        `UPDATE workflow SET intent = ?, phase = ?, facts = ?, candidates = ?, selection = ?, hold = ?, target_booking_id = ?, pending_question = ?, version = version + 1, updated_at = ?
         WHERE conversation_id = ? AND version = ?`,
      )
      .run(next.intent, next.phase, JSON.stringify(next.facts), json(next.candidates), json(next.selection), json(next.hold), next.target_booking_id, next.pending_question, nowMs(), conversationId, expectedVersion);
    if (result.changes === 0) return { ok: false };
    if (existing!.phase !== next.phase) trace?.record("state_transition", { fromPhase: existing!.phase, toPhase: next.phase, reason: "apply" });
    return { ok: true, workflow: getActive(conversationId) };
  };

  return {
    getActiveWorkflow: getActive,
    currentVersion: (conversationId: string): number => getActive(conversationId)?.version ?? -1,
    saveWorkflow,
    useRun: (run: RunTools | undefined): void => {
      trace = run?.trace;
      search = run?.search;
      hold = run?.hold;
    },

    /** Apply one user message to the workflow (MH-1): fill facts, ask for missing ones. */
    applyUserText: async (userId: string, conversationId: string, text: string): Promise<ApplyOutcome> => {
      const active = getActive(conversationId);
      const shown = active?.phase === "choosing" ? (active.candidates as OptionBlock[] | null) ?? undefined : undefined;
      const read: ReadResult = await model.read({ text, waitingFor: active?.phase ?? "nothing", clock, options: shown });

      if (read.kind === "pick" || read.kind === "pick_unclear") {
        if (!active || !shown?.length) {
          return { phase: active?.phase ?? "collecting", reply: "There's no list of options to pick from right now.", code: "NOTHING_TO_PICK", facts: active?.facts ?? ({} as Facts) };
        }
        const chosen = read.kind === "pick" ? shown.find((b) => b.provider.id === read.providerId && b.slots.some((s) => s.start === read.slot)) : undefined;
        if (read.kind === "pick_unclear" || !chosen) {
          return { ...optionsOutcome(active, "Which slot? Tap one and press Confirm, or tell me the provider and the time."), code: read.kind === "pick" ? "NOTHING_TO_PICK" : undefined };
        }
        const saved = saveWorkflow(conversationId, active.version, (w) => ({ ...w, selection: { providerId: read.providerId, slot: read.slot }, phase: "holding" }));
        if (!saved.ok || !saved.workflow) return { phase: active.phase, reply: "", code: "unknown_error", facts: active.facts };
        return advance(saved.workflow);
      }

      if (read.kind === "unknown" || read.kind === "decision") {
        // nothing is waiting for a plain yes/no at U17 (decisions come with U20)
        const phase = getActive(conversationId)?.phase ?? "collecting";
        return { phase, reply: "", code: "NOT_UNDERSTOOD", facts: getActive(conversationId)?.facts ?? ({} as Facts) };
      }

      if (read.kind === "drop") {
        const current = getActive(conversationId);
        if (!current) return { phase: "collecting", reply: "", code: "NOT_UNDERSTOOD", facts: {} as Facts };
        const saved = saveWorkflow(conversationId, current.version, (w) => ({ ...w, phase: "abandoned", pending_question: null }));
        trace?.record("state_transition", { fromPhase: current.phase, toPhase: "abandoned", reason: "user dropped" });
        return { phase: "abandoned", reply: "Okay, dropped. Nothing was booked.", facts: {} as Facts, code: saved.ok ? undefined : "unknown_error" };
      }

      const current = getActive(conversationId);

      if (current) {
        if (read.kind === "workflow" && read.intent && read.intent !== current.intent && current.phase !== "collecting") {
          // FR-15: switching tasks on an unfinished workflow asks first (U30); until
          // then record that the intent stayed
        }
        return applyToWorkflow(conversationId, current, read);
      }

      const intent = read.kind === "workflow" ? read.intent : undefined;
      if (!intent) return { phase: "collecting", reply: "", code: "NOT_UNDERSTOOD", facts: {} as Facts };
      const flags = read as { unknownService?: boolean; unknownArea?: boolean; timeOutOfRange?: boolean };
      if (flags.unknownService)
        return { phase: "collecting", reply: "I book these services: plumbing, electrical work, AC servicing, deep cleaning, carpentry. Which one?", code: "UNKNOWN_SERVICE", facts: {} as Facts };
      if (flags.unknownArea)
        return { phase: "collecting", reply: "I book in Indiranagar, Koramangala, HSR Layout, Jayanagar and Whitefield — which one?", code: "UNKNOWN_AREA", facts: {} as Facts };
      const facts: Facts = {};
      const values = read as { service?: string | null; area?: string | null; budget?: number | "any"; preferences?: string | null; timeWindow?: TimeWindow };
      if (values.service) facts.service = fact("service", values.service);
      if (values.area) facts.area = fact("area", values.area);
      if (values.timeWindow) facts.time_window = fact("time_window", values.timeWindow) as Fact & { value: TimeWindow };
      if (values.budget !== undefined) facts.budget = fact("budget", values.budget);
      if (values.preferences) facts.preferences = fact("preferences", values.preferences);

      const saved = saveWorkflow(conversationId, -1, (w) => ({ ...w, user_id: userId, intent, facts: { ...w.facts, ...facts }, phase: nextPhase({ ...w.facts, ...facts }) }));
      if (!saved.ok || !saved.workflow) return { phase: "collecting", reply: "", code: "unknown_error", facts: {} as Facts };
      for (const [key, f] of Object.entries(saved.workflow.facts)) {
        trace?.record("fact_changed", { key, oldValue: null, newValue: (f as Fact).value, source: "user", isCorrection: false });
      }
      trace?.record("state_transition", { fromPhase: "none", toPhase: saved.workflow.phase, reason: "workflow started" });
      return flags.timeOutOfRange
        ? { phase: saved.workflow.phase, reply: "I can only book within the next 14 days — that time is outside it. Tell me another day.", facts: saved.workflow.facts, code: TIME_OUT_OF_RANGE }
        : advance(saved.workflow);
    },

    /** Save search results (U18 calls the tool; this stores them on the workflow). */
    setCandidates: (conversationId: string, candidates: unknown[]): WorkflowRow | undefined => {
      const current = getActive(conversationId);
      if (!current) return undefined;
      return saveWorkflow(conversationId, current.version, (w) => ({ ...w, candidates })).workflow;
    },
  };

  function applyToWorkflow(conversationId: string, current: WorkflowRow, read: ReadResult): ApplyOutcome {
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
        const parsed = mergeCorrection({ dateFrom: null, dateTo: null, earliest: null, latest: null }, read.correctionText ?? read.text, clock);
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
    const saved = saveWorkflow(conversationId, current.version, (w) => ({
      ...w,
      facts,
      phase,
      ...(changed ? { candidates: null, selection: null, hold: null } : {}),
      intent: (values.intent as WorkflowRow["intent"]) ?? w.intent,
    }));
    if (!saved.ok || !saved.workflow) return { phase: current.phase, reply: "", code: "unknown_error", facts: current.facts };
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
    return advance(savedWorkflow);
  }

  function optionsOutcome(w: WorkflowRow, reply: string): ApplyOutcome {
    return { phase: w.phase, reply, facts: w.facts, parts: [{ type: "option_blocks", blocks: w.candidates as OptionBlock[] }] };
  }

  /**
   * `holding` needs no user input: hold the picked slot, then wait for approval with a
   * pending record built from the saved selection and hold — never from model text (§ 2.5.5).
   * The workflow save and the approval insert share one transaction.
   */
  function holdSelection(w: WorkflowRow): ApplyOutcome {
    const selection = w.selection!;
    const blocks = w.candidates as OptionBlock[];
    const block = blocks.find((b) => b.provider.id === selection.providerId)!;
    const held = hold!(selection);
    if (!held.ok) {
      // NFR-3: an answer, not a glitch — drop that slot and show what is left
      const remaining = blocks
        .map((b) => (b.provider.id === selection.providerId ? { ...b, slots: b.slots.filter((s) => s.start !== selection.slot) } : b))
        .filter((b) => b.slots.length > 0);
      const saved = saveWorkflow(w.conversation_id, w.version, (wf) => ({ ...wf, candidates: remaining, selection: null, phase: remaining.length ? "choosing" : "searching" }));
      if (!saved.ok || !saved.workflow) return { phase: w.phase, reply: "", code: "unknown_error", facts: w.facts };
      if (!remaining.length) return advance(saved.workflow);
      return { ...optionsOutcome(saved.workflow, "That slot was just taken — here are the options still open."), code: held.error };
    }
    const result = db.transaction(() => {
      const saved = saveWorkflow(w.conversation_id, w.version, (wf) => ({
        ...wf,
        hold: { holdId: held.data.holdId, expiresAt: held.data.expiresAt, quotedPrice: held.data.quotedPrice },
        phase: "awaiting_approval",
      }));
      if (!saved.ok || !saved.workflow) return undefined;
      const record = approvals.createPending(
        {
          user_id: w.user_id,
          conversation_id: w.conversation_id,
          workflow_id: w.id,
          action: "book",
          provider_id: selection.providerId,
          slot: selection.slot,
          price: held.data.quotedPrice, // V-2: the user approves the quoted price
          hold_id: held.data.holdId,
        },
        nowMs(),
      );
      return { workflow: saved.workflow, record };
    })();
    if (!result) return { phase: w.phase, reply: "", code: "unknown_error", facts: w.facts };
    trace?.record("approval_event", { approvalId: result.record.id, event: "created", action: "book", providerId: result.record.provider_id, slot: result.record.slot, price: result.record.price });
    const changed = result.record.price !== block.provider.price;
    const reply = changed
      ? `The provider quoted ₹${result.record.price.toLocaleString("en-IN")} for this slot (the search showed ₹${block.provider.price.toLocaleString("en-IN")}). Approve to book it at the new price, or decline.`
      : `Here are the details — approve to book, or decline.`;
    return { phase: "awaiting_approval", reply, facts: result.workflow.facts, parts: [approvalCardPart(result.record, block.provider.name)] };
  }

  /** Phases that need no user input run now (§ 2.5.3 step 6): searching, holding. */
  function advance(w: WorkflowRow): ApplyOutcome {
    if (w.phase === "holding" && hold) return holdSelection(w);
    if (w.phase !== "searching" || !search) return replyFor(w);
    const service = String(w.facts.service!.value);
    const area = String(w.facts.area!.value);
    const timeWindow = w.facts.time_window!.value!;
    const found = search({ service, area, ...searchRange(timeWindow, clock) });
    if (!found.ok) {
      return { phase: w.phase, reply: "I couldn't reach the provider service just now — try again in a moment.", facts: w.facts, code: found.error };
    }
    const options = buildOptions(found.data.providers, { timeWindow, budget: w.facts.budget?.value });
    const what = `${SERVICE_NAMES[service] ?? service} in ${AREA_NAMES[area] ?? area}`;
    if (!options.ok) {
      const saved = saveWorkflow(w.conversation_id, w.version, (wf) => ({ ...wf, candidates: [] }));
      const reply =
        options.filter === "budget"
          ? `Nobody offering ${what} fits your budget — the cheapest is ₹${options.cheapest.toLocaleString("en-IN")}. Want to raise the budget?`
          : `Nobody offering ${what} has a free slot in that time. Want to try a wider time window?`;
      return { phase: "searching", reply, facts: (saved.workflow ?? w).facts, code: "NO_MATCHES" };
    }
    const saved = saveWorkflow(w.conversation_id, w.version, (wf) => ({ ...wf, candidates: options.blocks, phase: "choosing" }));
    if (!saved.ok || !saved.workflow) return { phase: w.phase, reply: "", code: "unknown_error", facts: w.facts };
    const count = options.blocks.length;
    return {
      phase: "choosing",
      reply: `I found ${count} option${count === 1 ? "" : "s"} for ${what}. Tap a slot and press Confirm, or tell me the provider and time.`,
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
      return { phase: w.phase, reply: `I book these services: plumbing, electrical work, AC servicing, deep cleaning, carpentry. Which one?`, facts: w.facts, code: errorCode };
    }
    if (errorCode === "UNKNOWN_AREA") {
      return { phase: w.phase, reply: `I book in Indiranagar, Koramangala, HSR Layout, Jayanagar and Whitefield — which one?`, facts: w.facts, code: errorCode };
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

    const missing = missingFacts(w.facts);
    if (w.phase === "collecting" && missing.length > 0) {
      const asks = missing.map((key) => (key === "area" ? "which area" : key === "time_window" ? "when" : `which ${key}`));
      const known = Object.entries(w.facts)
        .filter(([key]) => key !== "time_window" && w.facts[key as keyof Facts] !== undefined)
        .map(([, v]) => (typeof (v as Fact).value === "string" ? ((v as Fact).value as string) : null))
        .filter((s) => s !== null);
      const subject = known.length > 0 ? known.join(", ") : "that";
      return { phase: "collecting", reply: `${subject ? `${subject} — ` : ""}${asks.join(" and ")}?`, facts: w.facts, code: errorCode };
    }
    return { phase: w.phase, reply: "", facts: w.facts, code: errorCode };
  }
};