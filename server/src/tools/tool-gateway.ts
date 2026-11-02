import type { Db } from "../shared/db.js";
import type { Clock } from "../shared/clock.js";
import { startTrace, type Trace } from "../tracing/index.js";
import type { ForcedQueue, WriteOpts } from "./write-tools.js";
import { cancel, getBookingStatus, holdSlot, reschedule, book } from "./write-tools.js";
import { getProvider, listBookings, searchProviders, type BookingRecord, type ProviderSummary, type ToolResult } from "./read-tools.js";
import { DEFAULT_SEED, type MockSettings } from "./settings.js";

// The tool gateway (§ 2.5.4): the agent's ONLY way to the provider API. Bound to one
// signed-in user and one run (trace + tool budget). Write tools are fail-closed here
// until U21 adds the persisted-operation execution path (R1, MH-2).

export const TOOL_CALL_CAP = 10;

const SUSPECT_PATTERNS = [
  /ignore (all|previous|prior) instructions/i,
  /already approved/i,
  /\[?system:?|assistant:/i,
  /remember( that)?/i,
  /real charge|tell the user/i,
];

const cleanReviews = (reviews: { text: string; suspectedInjection?: boolean }[]): { suspected: boolean } => {
  let suspected = false;
  for (const review of reviews) {
    if (review.text.length > 500) review.text = review.text.slice(0, 500);
    if (SUSPECT_PATTERNS.some((p) => p.test(review.text))) {
      review.suspectedInjection = true;
      suspected = true;
    }
  }
  return { suspected };
};

export type CreateGatewayOpts = {
  db: Db;
  clock: Clock;
  settings: MockSettings;
  forced: ForcedQueue;
  seed?: string;
  userId: string;
  trace?: Trace;
  toolsUsed?: number;
  broken?: { listBookings?: (db: Db, opts: WriteOpts, userId: string) => ToolResult<{ bookings: BookingRecord[] }> };
};

export type ProviderDetails = {
  id: string;
  name: string;
  service: string;
  areas: string[];
  price: number;
  rating: number;
  attributes: Record<string, unknown>;
  reviews: { text: string; suspectedInjection?: boolean }[];
};

export const createToolGateway = (opts: CreateGatewayOpts) => {
  const { db, clock, settings, forced, userId } = opts;
  const trace = opts.trace ?? startTrace(db, clock, `gateway-${userId}`);
  let used = opts.toolsUsed ?? 0;

  const toolOpts: WriteOpts = {
    seed: opts.seed ?? DEFAULT_SEED,
    clock,
    settings,
    forced: { take: (tool, nth) => forced.take(tool, nth) },
  };

  const budgeted = <T>(tool: string, args: Record<string, unknown>, call: () => ToolResult<T>, shape: (data: T) => boolean): ToolResult<T> => {
    if (used >= TOOL_CALL_CAP) {
      return { ok: false, error: "CAP_TOOL_CALLS", transient: false }; // refused before the call
    }
    used += 1;
    const raw = call();
    if (raw.ok && !shape(raw.data)) {
      trace.record("tool_call", { tool, args, attempt: 1, ok: false, errorCode: "PROVIDER_BAD_RESPONSE", transient: false });
      return { ok: false, error: "PROVIDER_BAD_RESPONSE", transient: false };
    }
    let suspectedInjection: boolean | undefined;
    let resultString: string;
    if (raw.ok) {
      if (tool === "get_provider") {
        const { suspected } = cleanReviews((raw.data as ProviderDetails).reviews);
        suspectedInjection = suspected || undefined;
      }
      resultString = JSON.stringify(raw.data).slice(0, 4000);
    } else {
      resultString = `error: ${raw.error}`;
    }
    trace.record("tool_call", {
      tool,
      args,
      attempt: 1,
      ok: raw.ok,
      errorCode: raw.ok ? null : raw.error,
      transient: raw.ok ? null : raw.transient,
      result: resultString,
      suspectedInjection,
    });
    return raw as ToolResult<T>;
  };

  return {
    searchProviders: (args: { service: string; area: string; from: string; to: string }): ToolResult<{ providers: ProviderSummary[] }> =>
      budgeted(
        "search_providers",
        { ...args },
        () => searchProviders(db, toolOpts, args),
        (d) => Array.isArray(d.providers) && d.providers.every((p) => typeof p?.id === "string" && Array.isArray(p.slots)),
      ),
    getProvider: (providerId: string): ToolResult<ProviderDetails> =>
      budgeted("get_provider", { providerId }, () => getProvider(db, toolOpts, providerId) as ToolResult<ProviderDetails>, (d) => Array.isArray(d.reviews)),
    listBookings: (): ToolResult<{ bookings: BookingRecord[] }> =>
      budgeted(
        "list_bookings",
        {},
        () => (opts.broken?.listBookings ? opts.broken.listBookings(db, toolOpts, userId) : listBookings(db, toolOpts, userId)),
        (d) => Array.isArray(d.bookings) && d.bookings.every((b) => typeof b?.id === "string" && typeof b?.price === "number"),
      ),
    holdSlot: (args: { providerId: string; slot: string }): ToolResult<{ holdId: string; slot: string; quotedPrice: number; expiresAt: number }> =>
      budgeted("hold_slot", { ...args }, () => holdSlot(db, toolOpts, userId, args), (d) => typeof d?.holdId === "string" && typeof d?.quotedPrice === "number"),
    getBookingStatus: (idempotencyKey: string): ToolResult<{ status: string; bookingId?: string }> =>
      budgeted("get_booking_status", { idempotencyKey }, () => getBookingStatus(db, toolOpts, idempotencyKey), (d) => typeof d?.status === "string"),
    // ——— fail-closed writes (MH-2): executable only through booking operations (U21, R1) ———
    book: (args: { holdId: string; idempotencyKey: string }): ToolResult<never> =>
      budgeted("book", { ...args }, () => refuse(), () => false),
    cancel: (args: { bookingId: string; idempotencyKey: string }): ToolResult<never> =>
      budgeted("cancel", { ...args }, () => refuse(), () => false),
    reschedule: (args: { bookingId: string; newSlot: string; idempotencyKey: string }): ToolResult<never> =>
      budgeted("reschedule", { ...args }, () => refuse(), () => false),
  };
};

const refuse = (): ToolResult<never> => ({ ok: false, error: "UNAUTHORIZED_WRITE", transient: false });