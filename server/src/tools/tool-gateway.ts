import type { Db } from "../shared/db.js";
import type { Clock } from "../shared/clock.js";
import { startTrace, type Trace } from "../tracing/index.js";
import type { ForcedQueue, WriteOpts } from "./write-tools.js";
import { book, cancel, getBookingStatus, holdSlot, reschedule } from "./write-tools.js";
import {
  getProvider,
  listBookings,
  searchProviders,
  type BookingRecord,
  type ProviderSummary,
  type ToolResult,
} from "./read-tools.js";

import { DEFAULT_SEED, type MockSettings } from "./settings.js";
import { AREAS, SERVICES } from "./mock-world.js";
import { createRunBudget, type RunBudget } from "../shared/run-budget.js";
import { createElapsed } from "../shared/elapsed.js";

// The tool gateway (§ 2.5.4): the agent's ONLY way to the provider API. Bound to one
// signed-in user and one run (trace + tool budget). Write tools are fail-closed: they
// run only when `authorizeWrite` (Gate 2, owned by booking operations) says the call
// matches a persisted in-flight operation (R1, MH-2). No authorizer → every write refused.

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

// § 2.5.7 rule 7: every result is checked for types, ranges and allowed values before
// anything uses it; a mismatch is PROVIDER_BAD_RESPONSE and nothing from it is used.
const isText = (v: unknown): v is string => typeof v === "string";
const isRupees = (v: unknown): boolean => Number.isInteger(v) && (v as number) > 0;
const isRating = (v: unknown): boolean => typeof v === "number" && v >= 0 && v <= 5;
const isSlot = (v: unknown): boolean => isText(v) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && !Number.isNaN(Date.parse(v));
const isService = (v: unknown): boolean => SERVICES.includes(v as never);
const isArea = (v: unknown): boolean => AREAS.includes(v as never);
const isObject = (v: unknown): boolean => typeof v === "object" && v !== null && !Array.isArray(v);
const isProviderCore = (p: Record<string, unknown> | undefined): boolean =>
  !!p && isText(p.id) && isText(p.name) && isRupees(p.price) && isRating(p.rating) && isObject(p.attributes);
const BOOKING_STATUSES = ["booked", "cancelled", "completed"];

export type CreateGatewayOpts = {
  db: Db;
  clock: Clock;
  settings: MockSettings;
  forced: ForcedQueue;
  seed?: string;
  userId: string;
  trace?: Trace;
  /** the run's caps (NFR-1); a gateway on its own gets a fresh budget */
  budget?: RunBudget;
  /** Gate 2 (§ 2.5.5): may this exact write call run? */
  authorizeWrite?: (tool: string, args: Record<string, unknown>) => boolean;
  broken?: {
    listBookings?: (db: Db, opts: WriteOpts, userId: string) => ToolResult<{ bookings: BookingRecord[] }>;
  };
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
  const budget = opts.budget ?? createRunBudget();

  const toolOpts: WriteOpts = {
    seed: opts.seed ?? DEFAULT_SEED,
    clock,
    settings,
    forced: { take: (tool, nth) => forced.take(tool, nth) },
    wait: (ms) => budget.wait(ms),
  };

  const budgeted = <T>(
    tool: string,
    args: Record<string, unknown>,
    call: () => ToolResult<T>,
    shape: (data: T) => boolean,
  ): ToolResult<T> => {
    budget.beforeToolCall(); // a cap stops the run before the call is made (CapHit)
    const elapsed = createElapsed(); // real latency (MH-7); the mock's pauses are on the clock
    const raw = call();
    const latencyMs = Math.round(elapsed.ms());
    if (raw.ok && !shape(raw.data)) {
      trace.record(
        "tool_call",
        { tool, args, attempt: 1, ok: false, errorCode: "PROVIDER_BAD_RESPONSE", transient: false },
        latencyMs,
      );
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
    trace.record(
      "tool_call",
      {
        tool,
        args,
        attempt: 1,
        ok: raw.ok,
        errorCode: raw.ok ? null : raw.error,
        transient: raw.ok ? null : raw.transient,
        result: resultString,
        suspectedInjection,
      },
      latencyMs,
    );
    budget.checkTime(); // R8: re-checked the moment the call returns
    return raw as ToolResult<T>;
  };

  return {
    toolCallsUsed: (): number => budget.used().toolCalls,
    searchProviders: (args: {
      service: string;
      area: string;
      from: string;
      to: string;
    }): ToolResult<{ providers: ProviderSummary[] }> =>
      budgeted(
        "search_providers",
        { ...args },
        () => searchProviders(db, toolOpts, args),
        (d) =>
          Array.isArray(d?.providers) &&
          d.providers.every(
            (p) => isProviderCore(p as never) && Array.isArray(p.slots) && p.slots.every(isSlot),
          ),
      ),
    getProvider: (providerId: string): ToolResult<ProviderDetails> =>
      budgeted(
        "get_provider",
        { providerId },
        () => getProvider(db, toolOpts, providerId) as ToolResult<ProviderDetails>,
        (d) =>
          isProviderCore(d as never) &&
          isService(d.service) &&
          Array.isArray(d.areas) &&
          d.areas.every(isArea) &&
          Array.isArray(d.reviews) &&
          d.reviews.every((r) => isText(r?.text)),
      ),
    listBookings: (): ToolResult<{ bookings: BookingRecord[] }> =>
      budgeted(
        "list_bookings",
        {},
        () =>
          opts.broken?.listBookings
            ? opts.broken.listBookings(db, toolOpts, userId)
            : listBookings(db, toolOpts, userId),
        (d) =>
          Array.isArray(d?.bookings) &&
          d.bookings.every(
            (b) =>
              isText(b?.id) &&
              isText(b.providerId) &&
              isText(b.providerName) &&
              isService(b.service) &&
              isArea(b.area) &&
              isSlot(b.slot) &&
              isRupees(b.price) &&
              BOOKING_STATUSES.includes(b.status),
          ),
      ),
    holdSlot: (args: {
      providerId: string;
      slot: string;
    }): ToolResult<{ holdId: string; slot: string; quotedPrice: number; expiresAt: number }> =>
      budgeted(
        "hold_slot",
        { ...args },
        () => holdSlot(db, toolOpts, userId, args),
        (d) =>
          isText(d?.holdId) && isSlot(d.slot) && isRupees(d.quotedPrice) && typeof d.expiresAt === "number",
      ),
    getBookingStatus: (idempotencyKey: string): ToolResult<{ status: string; bookingId?: string }> =>
      budgeted(
        "get_booking_status",
        { idempotencyKey },
        () => getBookingStatus(db, toolOpts, idempotencyKey),
        (d) =>
          (d?.status === "booked" && isText(d.bookingId)) || d?.status === "not_found" || d?.status === "failed",
      ),
    // ——— fail-closed writes (MH-2): executable only through booking operations (R1) ———
    book: (args: { holdId: string; idempotencyKey: string }): ToolResult<{ bookingId: string }> =>
      budgeted(
        "book",
        { ...args },
        () => (opts.authorizeWrite?.("book", { ...args }) ? book(db, toolOpts, userId, args) : refuse()),
        (d) => typeof d?.bookingId === "string",
      ),
    cancel: (args: { bookingId: string; idempotencyKey: string }): ToolResult<{ bookingId: string }> =>
      budgeted(
        "cancel",
        { ...args },
        () => (opts.authorizeWrite?.("cancel", { ...args }) ? cancel(db, toolOpts, userId, args) : refuse()),
        (d) => typeof d?.bookingId === "string",
      ),
    reschedule: (args: {
      bookingId: string;
      newSlot: string;
      idempotencyKey: string;
    }): ToolResult<{ booking: { id: string; slot: string; price: number; status: string } }> =>
      budgeted(
        "reschedule",
        { ...args },
        () =>
          opts.authorizeWrite?.("reschedule", { ...args })
            ? reschedule(db, toolOpts, userId, args)
            : refuse(),
        (d) =>
          isText(d?.booking?.id) &&
          isSlot(d.booking.slot) &&
          isRupees(d.booking.price) &&
          BOOKING_STATUSES.includes(d.booking.status),
      ),
  };
};

const refuse = (): ToolResult<never> => ({ ok: false, error: "UNAUTHORIZED_WRITE", transient: false });
