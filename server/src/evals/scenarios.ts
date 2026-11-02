import type { EvalScenario } from "./runner.js";

// The scenario catalogue (§ 2.5.10). Scenario ids match the design's table;
// scenarios land with their build units — E0 rides in with the runner skeleton
// (U13), the numbered ones 1–23 come with the units that build their subject.
export const SCENARIOS: Record<string, EvalScenario> = {
  E0: {
    id: "E0",
    name: "Runner skeleton: hello → help reply",
    description:
      "A message the scripted model doesn't understand gets the help reply listing what the agent can do; outcome completed.",
    seed: "eval-seed",
    steps: [
      { step: "say", text: "hello" },
      { step: "expect", outcome: "completed", replyContains: "I can help you book, reschedule or cancel" },
      { step: "expect", replyContains: "plumber" },
    ],
  },
  "1": {
    id: "1",
    name: "Happy path: plumber this week, mornings, under ₹1,500 → booked and verified",
    description:
      "FR-2, MH-3: search, pick, approve; the booking is made once, confirmed with get_booking_status, then reported.",
    seed: "eval-seed",
    steps: [
      { step: "force", tool: "book", outcome: "ok" },
      { step: "say", text: "plumber in HSR Layout this week, mornings only, under ₹1,500" },
      { step: "expect", phase: "choosing" },
      { step: "pick" },
      { step: "expect", phase: "awaiting_approval", cardMatchesApproval: true, agentBookings: 0 },
      { step: "click", decision: "approve" },
      { step: "expect", phase: "done", replyContains: "Booked:", agentBookings: 1, outcome: "completed" },
    ],
  },
  "2": {
    id: "2",
    name: "Only missing details asked; 'any budget' never asked again",
    description:
      "MH-1: the ask covers exactly the missing required details; an optional 'any budget' is stored and never asked again.",
    seed: "eval-seed",
    steps: [
      { step: "say", text: "I need a plumber, any budget" },
      { step: "expect", replyContains: "which area and when", replyNotContains: "budget" },
      { step: "say", text: "hsr layout mornings only" },
      { step: "expect", phase: "choosing", outcome: "completed", replyNotContains: "budget" },
    ],
  },
  "3": {
    id: "3",
    name: "Correct the budget after options → search redone, other details kept",
    description:
      "MH-1, FR-8: a budget correction clears the options and searches again; service, area and time window stay as they were.",
    seed: "eval-seed",
    steps: [
      { step: "say", text: "plumber in HSR Layout this week, mornings only, under ₹1,500" },
      { step: "expect", phase: "choosing", optionsPriceAtMost: 1500 },
      // eval-seed plumbers in HSR cost ₹985, ₹995, ₹1,518: ₹990 keeps exactly one
      { step: "say", text: "make the budget ₹990" },
      {
        step: "expect",
        phase: "choosing",
        optionsPriceAtMost: 990,
        facts: {
          service: "plumber",
          area: "hsr_layout",
          budget: 990,
          time_window: { dateFrom: "2026-11-02", dateTo: "2026-11-08", earliest: null, latest: "12:00" },
        },
      },
    ],
  },
  "5": {
    id: "5",
    name: "Quoted price differs from search price → approval shows the quoted price",
    description:
      "V-2: the slot is held before approval, so the card (drawn from the approval record) shows the hold's quoted price, not the search price.",
    seed: "eval-seed",
    steps: [
      { step: "force", tool: "hold_slot", outcome: "price_changed" },
      { step: "say", text: "plumber in HSR Layout this week, mornings only, under ₹1,500" },
      { step: "expect", phase: "choosing" },
      { step: "pick" },
      {
        step: "expect",
        phase: "awaiting_approval",
        cardMatchesApproval: true,
        cardPriceDiffersFromSearch: true,
        replyContains: "quoted",
      },
    ],
  },
  // ——— booking failure paths (§ 2.5.6 decision table, U22). Forces are queued after the
  // pick, so the first hold is a normal one and only the approve run sees them. ———
  "6": {
    id: "6",
    name: "Price change after approval → approval voided, nothing booked until re-approved",
    description:
      "MH-2: the hold ran out; the re-hold quotes a new price, so the used approval is voided and a new card asks again.",
    seed: "eval-seed",
    steps: [
      { step: "say", text: "plumber in HSR Layout this week, mornings only, under ₹1,500" },
      { step: "pick" },
      { step: "force", tool: "book", outcome: "hold_expired" },
      { step: "force", tool: "hold_slot", outcome: "price_changed" },
      { step: "click", decision: "approve" },
      {
        step: "expect",
        phase: "awaiting_approval",
        agentBookings: 0,
        cardMatchesApproval: true,
        replyContains: "now quotes",
      },
    ],
  },
  "7": {
    id: "7",
    name: "Slot change after approval → approval voided, back to options",
    description:
      "MH-2: the hold ran out and the re-hold finds the slot gone, so nothing is booked and the options come back.",
    seed: "eval-seed",
    steps: [
      { step: "say", text: "plumber in HSR Layout this week, mornings only, under ₹1,500" },
      { step: "pick" },
      { step: "force", tool: "book", outcome: "hold_expired" },
      { step: "force", tool: "hold_slot", outcome: "slot_unavailable" },
      { step: "click", decision: "approve" },
      { step: "expect", phase: "choosing", agentBookings: 0, replyContains: "gone" },
    ],
  },
  "8": {
    id: "8",
    name: "Hold expired, re-hold at the same price → booked without asking again",
    description:
      "V-4: the approval covers provider, slot and price — not the hold — so a same-price re-hold books with the next key.",
    seed: "eval-seed",
    steps: [
      { step: "say", text: "plumber in HSR Layout this week, mornings only, under ₹1,500" },
      { step: "pick" },
      { step: "force", tool: "book", outcome: "hold_expired" },
      { step: "force", tool: "book", outcome: "ok" },
      { step: "click", decision: "approve" },
      {
        step: "expect",
        phase: "done",
        replyContains: "Booked:",
        agentBookings: 1,
        lastRunToolCalls: ["book:hold_expired", "hold_slot:ok", "book:ok", "get_booking_status:booked"],
      },
    ],
  },
  "9": {
    id: "9",
    name: "Timeout after success → status check → booked once, reported once",
    description:
      "MH-3: the provider booked but the call timed out; get_booking_status finds it, so it is reported — and never booked twice.",
    seed: "eval-seed",
    steps: [
      { step: "say", text: "plumber in HSR Layout this week, mornings only, under ₹1,500" },
      { step: "pick" },
      { step: "force", tool: "book", outcome: "timeout_booked" },
      { step: "click", decision: "approve" },
      {
        step: "expect",
        phase: "done",
        replyContains: "Booked:",
        agentBookings: 1,
        lastRunToolCalls: ["book:timeout", "get_booking_status:booked"],
      },
    ],
  },
  "10": {
    id: "10",
    name: "Timeout, nothing booked → not_found → retry with the same key → exactly one booking",
    description:
      "MH-3, NFR-2: a timeout that left nothing behind is retried with the same idempotency key after the wait.",
    seed: "eval-seed",
    steps: [
      { step: "say", text: "plumber in HSR Layout this week, mornings only, under ₹1,500" },
      { step: "pick" },
      { step: "force", tool: "book", outcome: "timeout" },
      { step: "force", tool: "book", outcome: "ok" },
      { step: "click", decision: "approve" },
      {
        step: "expect",
        phase: "done",
        agentBookings: 1,
        lastRunToolCalls: [
          "book:timeout",
          "get_booking_status:not_found",
          "book:ok",
          "get_booking_status:booked",
        ],
      },
    ],
  },
  "11": {
    id: "11",
    name: "slot_taken → back to options → pick another → booked",
    description:
      "NFR-3: slot_taken is an answer, not a glitch — the options come back without that slot and the next pick books.",
    seed: "eval-seed",
    steps: [
      { step: "say", text: "plumber in HSR Layout this week, mornings only, under ₹1,500" },
      { step: "pick" },
      { step: "force", tool: "book", outcome: "slot_taken" },
      { step: "click", decision: "approve" },
      { step: "expect", phase: "choosing", agentBookings: 0, replyContains: "taken" },
      { step: "pick" },
      { step: "force", tool: "book", outcome: "ok" },
      { step: "click", decision: "approve" },
      { step: "expect", phase: "done", replyContains: "Booked:", agentBookings: 1 },
    ],
  },
  // ——— repeated yes and overlapping messages (§ 2.5.6, § 2.3, U23) ———
  "13": {
    id: "13",
    name: "Repeated confirmation: typed yes, yes again, then a button click → one booking",
    description:
      "MH-3: the approval is used after the first yes; repeats report the operation's status and call nothing.",
    seed: "eval-seed",
    steps: [
      { step: "say", text: "plumber in HSR Layout this week, mornings only, under ₹1,500" },
      { step: "pick" },
      { step: "force", tool: "book", outcome: "ok" },
      { step: "say", text: "yes" },
      { step: "expect", phase: "done", replyContains: "Booked:", agentBookings: 1 },
      { step: "say", text: "yes" },
      { step: "expect", replyContains: "Already booked", agentBookings: 1, lastRunToolCalls: [] },
      { step: "click", decision: "approve" },
      { step: "expect", replyContains: "Already booked", agentBookings: 1, lastRunToolCalls: [] },
    ],
  },
  "14": {
    id: "14",
    name: '"yes" sent while a run is in progress → CONVERSATION_BUSY, one booking',
    description: "§ 2.3: one run per conversation; a message that arrives mid-run is refused, not queued.",
    seed: "eval-seed",
    steps: [
      { step: "say", text: "plumber in HSR Layout this week, mornings only, under ₹1,500" },
      { step: "pick" },
      { step: "force", tool: "book", outcome: "ok" },
      { step: "send_concurrently", text: "yes" },
      { step: "click", decision: "approve" },
      { step: "expect", outcome: "CONVERSATION_BUSY", replyContains: "Booked:", agentBookings: 1 },
    ],
  },
};
