import { parseTimeWindow, type TimeWindow } from "./time-window.js";
import type { Clock } from "../shared/clock.js";
import type { OptionBlock } from "./options.js";

// The scripted model (ADR-002, V-1 phrase table): pattern code that turns the user's
// text into labelled values. Never writes prose for the agent's decisions — the state
// machine and its reply-writer own those.

export type ReadResult =
  | {
      kind: "workflow";
      intent: "book" | "reschedule" | "cancel";
      service?: string | null;
      area?: string | null;
      budget?: number | "any";
      preferences?: string | null;
      timeWindow?: TimeWindow;
      unknownService?: boolean;
      unknownArea?: boolean;
      timeOutOfRange?: boolean;
    }
  | {
      kind: "correction";
      target: "time_window" | "budget" | "area" | "service";
      text: string;
      correctionText?: string;
      mergeTime?: boolean;
      budget?: number | "any";
    }
  | { kind: "drop" }
  | { kind: "decision"; decision: "yes" | "no" }
  | { kind: "pick"; providerId: string; slot: string }
  | { kind: "pick_unclear" }
  | { kind: "unknown" }
  /** FR-5: "show my bookings" — whose bookings is never read from the text (V-7) */
  | { kind: "list_bookings" }
  /** FR-4: "cancel my AC servicing" — which booking is matched against the user's own list */
  | { kind: "cancel" }
  /** FR-3: "move my AC servicing to Saturday" — the time, when given, is the new time */
  | { kind: "reschedule"; timeWindow?: TimeWindow }
  /** FR-6: "tell me about provider 2" / a "Details" link — the id comes from the shown options */
  | { kind: "provider_details"; providerId?: string }
  /** the model's read can't be used (only an eval can force this with the scripted model); read again */
  | { kind: "unusable" };

const VAGUE_PICK_RE = /\b(first|second|third|fourth|fifth|last|that|this|other) one\b/i;

/**
 * A pick names a shown provider (FR-9, ADR-007); the time narrows its slots to one.
 * @remarks Returns undefined when the text names no shown provider, so corrections
 * and new requests read normally while options are on screen.
 */
const readPick = (text: string, options: OptionBlock[], clock: Clock): ReadResult | undefined => {
  const lower = text.toLowerCase();
  const block = [...options]
    .sort((a, b) => b.provider.name.length - a.provider.name.length)
    .find((b) => lower.includes(b.provider.name.toLowerCase()));
  if (!block) return undefined;
  const rest = lower.replace(block.provider.name.toLowerCase(), " ");
  const parsed = parseTimeWindow(rest, clock);
  const w = parsed.ok ? parsed.data : null;
  const matching = block.slots.filter((s) => {
    const day = s.start.slice(0, 10);
    const time = s.start.slice(11, 16);
    return (
      (!w?.dateFrom || (day >= w.dateFrom && day <= (w.dateTo ?? w.dateFrom))) &&
      (!w?.earliest || time === w.earliest)
    );
  });
  return matching.length === 1
    ? { kind: "pick", providerId: block.provider.id, slot: matching[0]!.start }
    : { kind: "pick_unclear" };
};

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

const DROP_RE = /never mind|forget it|stop|not that|don't need|cancel that/i;
const CANCEL_RE = /\bcancel\b/i;
// "move it to 11" stays a correction; only "move my …" / "reschedule" starts a reschedule
const RESCHEDULE_RE = /\breschedule\b|\bmove my\b/i;
// FR-6 asked for a provider's details — read before a pick, since its phrasing never picks a slot
const DETAILS_RE = /\b(details|tell me (?:more )?about)\b/i; // "cancel that" is a drop (DROP_RE is checked first)
const LIST_BOOKINGS_RE = /\b(show|list|see|view|what are|what's)\b[^.?!]*\bbookings?\b|^\s*my bookings\b/i;
// § 2.5.5 rule 2: only a *plain* yes approves — the whole message is the decision word
const PLAIN_YES = /^\s*(yes|yeah|yep|sure|confirm|approve|go ahead|book it|fine|ok|okay)[\s.,!]*$/i;
const PLAIN_NO = /^\s*(no|nope|decline|not this one)[\s.,!]*$/i;
// a decision word followed by more words: the rest is a change ("yes but 11am")
const DECISION_LEAD = /^\s*(yes|yeah|yep|sure|ok|okay|no|nope)\b[\s,.!]*(?:but\s+)?/i;
const BUDGET_UNDER = /(?:under|below|less than|max|budget)\s*₹?\s*([\d,]+)/i;

export const findArea = (text: string): { area: string | null; unknownArea: boolean } => {
  const lower = text.toLowerCase();
  for (const [phrase, canonical] of Object.entries(AREA_SYNONYMS)) {
    if (lower.includes(phrase)) return { area: canonical, unknownArea: false };
  }
  const guess = lower.match(/\b(?:in|near|at|around)\s+([a-z][a-z ]{2,20}?)(?:\s|,|\.|$)/);
  if (guess)
    return { area: null, unknownArea: true, ...(guess[1] ? { guessed: guess[1].trim() } : {}) } as never;
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

/** "yes but 11am" / "no, keep my budget but after 11": read the rest as a change. */
const readDecisionWithChange = async (rest: string, clock: Clock): Promise<ReadResult> => {
  const r = await readUserMessage(rest, clock);
  if (r.kind === "correction" || r.kind === "drop") return r;
  if (r.kind !== "workflow") return { kind: "unknown" };
  if (r.timeWindow || r.timeOutOfRange) {
    const after = /(?:after|not before)\s+\d/i.exec(rest);
    return {
      kind: "correction",
      target: "time_window",
      text: rest,
      correctionText: after ? rest.slice(after.index) : rest,
      mergeTime: true,
    };
  }
  if (r.budget !== undefined) return { kind: "correction", target: "budget", text: rest, budget: r.budget };
  return r;
};

export const readUserMessage = async (
  text: string,
  clock: Clock,
  options?: OptionBlock[],
): Promise<ReadResult> => {
  if (DROP_RE.test(text)) return { kind: "drop" };
  if (PLAIN_YES.test(text)) return { kind: "decision", decision: "yes" };
  if (PLAIN_NO.test(text)) return { kind: "decision", decision: "no" };
  const lead = DECISION_LEAD.exec(text);
  if (lead) return readDecisionWithChange(text.slice(lead[0].length), clock);
  if (DETAILS_RE.test(text)) {
    let providerId: string | undefined;
    if (options) {
      const ordinal = /provider\s+(\d+)/i.exec(text);
      if (ordinal) providerId = options[Number(ordinal[1]) - 1]?.provider.id;
      if (!providerId) {
        const lower = text.toLowerCase();
        providerId = [...options]
          .sort((a, b) => b.provider.name.length - a.provider.name.length)
          .find((b) => lower.includes(b.provider.name.toLowerCase()))?.provider.id;
      }
    }
    return { kind: "provider_details", ...(providerId ? { providerId } : {}) };
  }
  if (CANCEL_RE.test(text)) return { kind: "cancel" };
  if (LIST_BOOKINGS_RE.test(text)) return { kind: "list_bookings" };

  const pick = options ? readPick(text, options, clock) : undefined;
  if (pick) return pick;
  if (VAGUE_PICK_RE.test(text)) return { kind: "pick_unclear" };
  if (RESCHEDULE_RE.test(text)) {
    const parsed = parseTimeWindow(text, clock);
    return { kind: "reschedule", ...(parsed.ok ? { timeWindow: parsed.data } : {}) };
  }

  // corrections carry content: a trigger word plus what changes
  const DAY_RE = /\b(saturday|sunday|monday|tuesday|wednesday|thursday|friday)\b/i;
  const correctionTrigger = /make it|move it|actually|change|correct|instead/i;
  const afterBound = /(?:after|not before)\s+(\d{1,2})\s*(?::\d{2})?\s*(a\.?m\.?|p\.?m\.?)?/i.exec(text);
  const timeContent = afterBound || DAY_RE.exec(text);
  if (correctionTrigger.test(text) && timeContent) {
    return {
      kind: "correction",
      target: "time_window",
      text,
      correctionText: text.slice(
        afterBound
          ? text.toLowerCase().indexOf(afterBound[0].toLowerCase())
          : (DAY_RE.exec(text)?.index ?? 0),
      ),
      mergeTime: true,
    };
  }
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
    serviceInfo.service !== null ||
    serviceInfo.unknownService ||
    areaInfo.area !== null ||
    areaInfo.unknownArea ||
    (windowProbe?.ok ?? false) ||
    anyTime;
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
    ...(text.match(/\bany\s+budget|don'?t\s*care.*budget|no\s+budget/i)
      ? { budget: "any" as const }
      : budgetMatch
        ? { budget: budget(budgetMatch[1]!) }
        : {}),
  };
};

const budget = (raw: string): number => Number(raw.replace(/,/g, ""));
