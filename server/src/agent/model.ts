import { parseTimeWindow, type TimeWindow } from "./time-window.js";
import type { Clock } from "../shared/clock.js";

// The scripted model (ADR-002, V-1 phrase table): pattern code that turns the user's
// text into labelled values. Never writes prose for the agent's decisions — the state
// machine and its reply-writer own those.

export type ReadResult =
  | { kind: "workflow"; intent: "book" | "reschedule" | "cancel"; service?: string | null; area?: string | null; budget?: number | "any"; preferences?: string | null; timeWindow?: TimeWindow; unknownService?: boolean; unknownArea?: boolean; timeOutOfRange?: boolean }
  | { kind: "correction"; target: "time_window" | "budget" | "area" | "service"; text: string; correctionText?: string; mergeTime?: boolean; budget?: number | "any" }
  | { kind: "drop" }
  | { kind: "decision"; decision: "yes" | "no" }
  | { kind: "unknown" };

export const SERVICE_SYNONYMS: Record<string, string> = {
  plumber: "plumber",
  plumbing: "plumber",
  electrician: "electrician",
  electrical: "electrician",
  "ac servicing": "ac_servicing",
  "ac cleaning": "ac_servicing",
  "ac clean": "ac_servicing",
  ac: "ac_servicing",
  "air conditioner": "ac_servicing",
  "deep cleaning": "deep_cleaning",
  cleaning: "deep_cleaning",
  carpenter: "carpentry",
  carpentry: "carpentry",
};

export const AREA_SYNONYMS: Record<string, string> = {
  indiranagar: "indiranagar",
  koramangala: "koramangala",
  hsr: "hsr_layout",
  "hsr layout": "hsr_layout",
  jayanagar: "jayanagar",
  whitefield: "whitefield",
};

const DROP_RE = /never mind|forget it|stop|not that|don't need/i;
const YES_RE = /^\s*(yes|confirm|go ahead|book it|fine|ok|okay)\b/i;
const NO_RE = /^\s*(no|decline|not this one|cancel that)\b/i;
const BUDGET_UNDER = /(?:under|below|less than|max|budget)\s*₹?\s*([\d,]+)/i;

export const findArea = (text: string): { area: string | null; unknownArea: boolean } => {
  const lower = text.toLowerCase();
  for (const [phrase, canonical] of Object.entries(AREA_SYNONYMS)) {
    if (lower.includes(phrase)) return { area: canonical, unknownArea: false };
  }
  const guess = lower.match(/\b(?:in|near|at|around)\s+([a-z][a-z ]{2,20}?)(?:\s|,|\.|$)/);
  if (guess) return { area: null, unknownArea: true, ...(guess[1] ? { guessed: guess[1].trim() } : {}) } as never;
  return { area: null, unknownArea: false };
};

export const findService = (text: string): { service: string | null; unknownService: boolean } => {
  const lower = text.toLowerCase();
  const sorted = Object.keys(SERVICE_SYNONYMS).sort((a, b) => b.length - a.length);
  for (const phrase of sorted) {
    const re = new RegExp(`\\b${phrase.replace(/[-]/g, "\\-")}\\b`, "i");
    if (re.test(lower)) return { service: SERVICE_SYNONYMS[phrase]!, unknownService: false };
  }
  // a service-shaped noun after a booking verb that we don't know → unknown service
  const guess = lower.match(/(?:book|find|need|get|schedule)\s+(?:an?\s+)?([a-z]+(?:\s+[a-z]+)?)/);
  if (guess && !/this|that|it|one|someone|me/.test(guess[1]!)) return { service: null, unknownService: true };
  return { service: null, unknownService: false };
};

export const readUserMessage = async (text: string, clock: Clock): Promise<ReadResult> => {
  if (DROP_RE.test(text)) return { kind: "drop" };

  // corrections carry content: the trigger words, or a decision word with a change
  const DAY_RE = /\b(saturday|sunday|monday|tuesday|wednesday|thursday|friday)\b/i;
  const correctionTrigger = /make it|move it|actually|change|correct|instead/i;
  const afterBound = /(?:after|not before)\s+(\d{1,2})\s*(?::\d{2})?\s*(a\.?m\.?|p\.?m\.?)?/i.exec(text);
  const bareDecision = /^\s*(yes|no|confirm|ok|okay|decline)\b[\s.,!]*$/i;
  const timeContent = afterBound || DAY_RE.exec(text);
  if (correctionTrigger.test(text) && timeContent) {
    return {
      kind: "correction",
      target: "time_window",
      text,
      correctionText: text.slice(afterBound ? text.toLowerCase().indexOf(afterBound[0].toLowerCase()) : (DAY_RE.exec(text)?.index ?? 0)),
      mergeTime: true,
    };
  }
  if (!bareDecision.test(text) && timeContent && /^\s*(yes|no)\b/i.test(text)) {
    // "no, keep my budget but after 11" — a decision that carries a change (R2/R9)
    return {
      kind: "correction",
      target: "time_window",
      text,
      correctionText: text.slice(timeContent.index ?? 0),
      mergeTime: true,
    };
  }
  if (NO_RE.test(text)) return { kind: "decision", decision: "no" };
  if (YES_RE.test(text)) return { kind: "decision", decision: "yes" };

  const budgetCorrection = BUDGET_UNDER.exec(text);
  if ((correctionTrigger.test(text) || /make the|set the/i.test(text)) && budgetCorrection) {
    return { kind: "correction", target: "budget", text, budget: budget(budgetCorrection[1]!) };
  }

  const serviceProbe = findService(text);
  const anyTime = /\banytime\b|whenever/i.test(text);
  const windowProbe = anyTime ? undefined : parseTimeWindow(text, clock);
  // service, area or a readable time is enough intent; bare-detail answers to an
  // open question count as workflow continuations
  const serviceInfo = serviceProbe;
  const areaInfo = findArea(text);
  const hasDetail =
    serviceInfo.service !== null || serviceInfo.unknownService || areaInfo.area !== null || areaInfo.unknownArea || (windowProbe?.ok ?? false) || anyTime;
  if (!hasDetail) return { kind: "unknown" };

  const service = serviceProbe.service;
  const unknownService = serviceProbe.unknownService;
  const unknownArea = areaInfo.unknownArea;
  const area = areaInfo.area;
  const budgetMatch = BUDGET_UNDER.exec(text);

  let timeOutOfRange = false;
  let window: TimeWindow | undefined;
  if (!anyTime) {
    const parsed = windowProbe ?? parseTimeWindow(text, clock);
    if (parsed.ok) window = parsed.data;
    else if (parsed.error === "TIME_OUT_OF_RANGE") timeOutOfRange = true;
  }

  return {
    kind: "workflow",
    intent: "book",
    ...(timeOutOfRange ? { timeOutOfRange: true } : {}),
    ...(unknownService ? { unknownService: true } : {}),
    ...(unknownArea ? { unknownArea: true } : {}),
    ...(service ? { service } : {}),
    ...(area ? { area } : {}),
    ...(window ? { timeWindow: window } : {}),
    ...(text.match(/\bany\s+budget|don'?t\s*care.*budget|no\s+budget/i) ? { budget: "any" as const } : budgetMatch ? { budget: budget(budgetMatch[1]!) } : {}),
  };
};

const budget = (raw: string): number => Number(raw.replace(/,/g, ""));