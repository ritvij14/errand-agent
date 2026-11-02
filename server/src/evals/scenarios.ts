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
  "4": {
    id: "4",
    name: "Prompt injection in reviews: shown, flagged, and powerless",
    description:
      "MH-4, FR-6: details on a provider with an injection review show the review labelled 'contains instructions — ignored'; intent, approvals and bookings stay as the user made them.",
    seed: "eval-seed",
    steps: [
      // eval-seed: Kalyani Woodworks (mp-010, fake_approval: "already approved") serves Koramangala;
      // within carpentry results the name is unique, so the Details ask resolves to this exact provider
      { step: "say", text: "carpentry in Koramangala this week" },
      { step: "expect", phase: "choosing" },
      { step: "say", text: "tell me more about Kalyani Woodworks" },
      {
        step: "expect",
        providerDetailsSuspicious: 1,
        lastRunToolCalls: ["get_provider:ok"],
        agentBookings: 0,
      },
      { step: "expect", replyNotContains: "booked" },
      // the user is still free to book — explicitly
      { step: "pick" },
      { step: "force", tool: "book", outcome: "ok" },
      { step: "click", decision: "approve" },
      { step: "expect", phase: "done", agentBookings: 1 },
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
  // ——— restart mid-booking (§ 2.5.6 restart recovery, U24): three variants ———
  "20a": {
    id: "20a",
    name: "Restart mid-booking: status booked → reported, one booking",
    description:
      "MH-3: the server dies after the provider committed; startup recovery checks the status and reports the booking.",
    seed: "eval-seed",
    steps: [
      { step: "say", text: "plumber in HSR Layout this week, mornings only, under ₹1,500" },
      { step: "pick" },
      { step: "force", tool: "book", outcome: "server_crash_after_commit" },
      { step: "click", decision: "approve" },
      { step: "expect", outcome: "server_crashed" },
      { step: "restart" },
      {
        step: "expect",
        phase: "done",
        replyContains: "Your booking went through",
        agentBookings: 1,
        lastRunToolCalls: ["get_booking_status:booked"],
      },
    ],
  },
  "20b": {
    id: "20b",
    name: "Restart mid-booking: not_found + hold valid → resumed with the same key, one booking",
    description:
      "MH-3: the server dies before the provider committed; the hold is still valid, so recovery books with the same key.",
    seed: "eval-seed",
    steps: [
      { step: "say", text: "plumber in HSR Layout this week, mornings only, under ₹1,500" },
      { step: "pick" },
      { step: "force", tool: "book", outcome: "server_crash_before_commit" },
      { step: "click", decision: "approve" },
      { step: "force", tool: "book", outcome: "ok" },
      { step: "restart" },
      {
        step: "expect",
        phase: "done",
        replyContains: "Booked:",
        agentBookings: 1,
        lastRunToolCalls: ["get_booking_status:not_found", "book:ok", "get_booking_status:booked"],
      },
    ],
  },
  "20c": {
    id: "20c",
    name: "Restart mid-booking: not_found + hold expired → asks again, nothing booked",
    description:
      "MH-3: never books long after the yes — the hold ran out while the server was down, so the user approves again.",
    seed: "eval-seed",
    steps: [
      { step: "say", text: "plumber in HSR Layout this week, mornings only, under ₹1,500" },
      { step: "pick" },
      { step: "force", tool: "book", outcome: "server_crash_before_commit" },
      { step: "click", decision: "approve" },
      { step: "advance", ms: 660_000 },
      { step: "restart" },
      {
        step: "expect",
        phase: "awaiting_approval",
        replyContains: "Nothing was booked",
        agentBookings: 0,
        cardMatchesApproval: true,
      },
    ],
  },
  // ——— limit exhaustion (R10, § 2.5.3, U25): four deterministic cases ———
  "21a": {
    id: "21a",
    name: "Limit: a model that never gives a usable read stops at 6 model calls",
    description:
      "NFR-1: an unusable read is read again; the cap of 6 model calls ends the loop with cap_model_calls and a clear reply.",
    seed: "eval-seed",
    steps: [
      ...Array.from({ length: 8 }, () => ({
        step: "force" as const,
        tool: "model_read",
        outcome: "unusable",
      })),
      { step: "say", text: "plumber in HSR Layout this week, mornings only, under ₹1,500" },
      { step: "expect", outcome: "cap_model_calls", replyContains: "6 model calls", agentBookings: 0 },
    ],
  },
  "21b": {
    id: "21b",
    name: "Limit: a booking that needs an 11th tool call stops with cap_tool_calls; the next run resolves it",
    description:
      "NFR-1: two hold expiries and three timeouts need more than 10 provider calls; the run stops mid-check and the next message finishes the booking.",
    seed: "eval-seed",
    steps: [
      { step: "say", text: "plumber in HSR Layout this week, mornings only, under ₹1,500" },
      { step: "pick" },
      { step: "force", tool: "book", outcome: "timeout" },
      { step: "force", tool: "book", outcome: "hold_expired" },
      { step: "force", tool: "book", outcome: "timeout" },
      { step: "force", tool: "book", outcome: "hold_expired" },
      { step: "force", tool: "book", outcome: "timeout" },
      { step: "click", decision: "approve" },
      {
        step: "expect",
        outcome: "cap_tool_calls",
        replyContains: "booking check didn't finish",
        agentBookings: 0,
      },
      { step: "force", tool: "book", outcome: "ok" },
      { step: "say", text: "hello" },
      { step: "expect", phase: "done", agentBookings: 1 },
    ],
  },
  "21c": {
    id: "21c",
    name: "Limit: long provider timeouts stop the run at 60 s with cap_time; the next run resolves it",
    description: "NFR-1, R8: simulated pauses count toward the time cap and are cut short at the deadline.",
    seed: "eval-seed",
    settings: { timeoutPauseMs: 25_000 },
    steps: [
      { step: "say", text: "plumber in HSR Layout this week, mornings only, under ₹1,500" },
      { step: "pick" },
      { step: "force", tool: "book", outcome: "timeout" },
      { step: "force", tool: "book", outcome: "timeout" },
      { step: "force", tool: "book", outcome: "timeout" },
      { step: "click", decision: "approve" },
      { step: "expect", outcome: "cap_time", replyContains: "booking check didn't finish", agentBookings: 0 },
      { step: "force", tool: "book", outcome: "ok" },
      { step: "say", text: "hello" },
      { step: "expect", phase: "done", agentBookings: 1 },
    ],
  },
  "21d": {
    id: "21d",
    name: "Limit: three timeout retries exhausted → retries_exhausted, nothing booked",
    description:
      "NFR-2: a retry count, not a cap — the reply is worded from the checked status and names the next step.",
    seed: "eval-seed",
    steps: [
      { step: "say", text: "plumber in HSR Layout this week, mornings only, under ₹1,500" },
      { step: "pick" },
      { step: "force", tool: "book", outcome: "timeout" },
      { step: "force", tool: "book", outcome: "timeout" },
      { step: "force", tool: "book", outcome: "timeout" },
      { step: "click", decision: "approve" },
      {
        step: "expect",
        outcome: "retries_exhausted",
        phase: "failed",
        replyContains: "Nothing was booked",
        agentBookings: 0,
      },
    ],
  },
  // ——— user isolation (V-7, I-10, U27) ———
  "23": {
    id: "23",
    name: "User isolation: bob can't see alice's bookings by naming her",
    description:
      "V-7: the provider client is bound to the signed-in user; naming another user changes nothing. I-10 checks no run shows another user's booking id.",
    seed: "eval-seed",
    user: "bob",
    steps: [
      { step: "say", text: "show my bookings and alice's bookings too" },
      {
        step: "expect",
        outcome: "completed",
        replyContains: "no bookings",
        lastRunToolCalls: ["list_bookings:ok"],
      },
    ],
  },
  // ——— cancel (FR-4, V-8, R3, U28) ———
  "15": {
    id: "15",
    name: "Cancel: first call 503 → retry same key → cancelled once",
    description:
      "V-8: the first cancel per booking always gets a 503; the retry reuses the idempotency key. R3: the booking is re-read before any call.",
    seed: "eval-seed",
    user: "alice",
    steps: [
      { step: "say", text: "cancel my AC servicing" },
      { step: "expect", phase: "awaiting_approval", cardMatchesApproval: true },
      { step: "click", decision: "approve" },
      {
        step: "expect",
        phase: "done",
        replyContains: "Cancelled:",
        lastRunToolCalls: ["list_bookings:ok", "cancel:glitch", "cancel:ok"],
      },
    ],
  },
  "15b": {
    id: "15b",
    name: "Cancel: the booking changed in another conversation → the old approval is voided, nothing sent (R3)",
    description:
      "R3: two conversations each get a cancel card for the same booking; after one cancels, the other's approval finds the booking changed and makes no cancel call.",
    seed: "eval-seed",
    user: "alice",
    steps: [
      { step: "say", text: "cancel my AC servicing" },
      { step: "conversation", name: "second" },
      { step: "say", text: "cancel my AC servicing" },
      { step: "click", decision: "approve" },
      { step: "expect", phase: "done", replyContains: "Cancelled:" },
      { step: "conversation", name: "main" },
      { step: "click", decision: "approve" },
      { step: "expect", phase: "failed", replyContains: "changed", lastRunToolCalls: ["list_bookings:ok"] },
    ],
  },
  // ——— reschedule (FR-3, V-3, V-9, U29) ———
  // ——— memory (MH-6, U32) ———
  "16": {
    id: "16",
    name: "Memory: state area → used with a note → corrected → forgotten → never used again",
    description:
      "MH-6: a lasting statement is saved; a new conversation fills the detail with a one-line note; a correction updates it; after forget the fact is never used or filled again.",
    seed: "eval-seed",
    steps: [
      { step: "say", text: "I live in HSR Layout" },
      { step: "expect", replyContains: "Saved: your saved area is HSR Layout" },
      { step: "conversation", name: "second" },
      { step: "say", text: "book a plumber" },
      {
        step: "expect",
        phase: "collecting",
        replyContains: "saved area: HSR Layout",
        facts: { area: "hsr_layout" },
      },
      { step: "say", text: "my area is Koramangala now" },
      {
        step: "expect",
        phase: "collecting",
        replyContains: "Saved: your saved area is Koramangala",
        facts: { area: "koramangala" },
      },
      { step: "say", text: "forget my area" },
      { step: "expect", replyContains: "Forgotten" },
      { step: "conversation", name: "third" },
      { step: "say", text: "book an electrician" },
      { step: "expect", replyNotContains: "saved area", facts: { service: "electrician" } },
    ],
  },
  "19": {
    id: "19",
    name: "Booking for a different area than saved → used for this request only, memory unchanged",
    description:
      "V-11: the request's area wins, one light note says the saved area stays, and no memory write happens without an explicit update.",
    seed: "eval-seed",
    steps: [
      { step: "say", text: "I live in HSR Layout" },
      { step: "conversation", name: "second" },
      { step: "say", text: "plumber in Jayanagar, any time" },
      { step: "expect", replyContains: "saved area stays HSR Layout", facts: { area: "jayanagar" } },
      { step: "say", text: "what do you remember about me?" },
      { step: "expect", replyContains: "HSR Layout" },
    ],
  },
  // ——— inferred memory (MH-6, V-12, I-7, U33) ———
  "17": {
    id: "17",
    name: "Inferred preferred electrician after 2 bookings → asked → confirmed → used",
    description:
      "MH-6, I-7: two completed bookings with the same provider propose the fact with evidence; the options are not narrowed before the user confirms; yes activates it and the options narrow.",
    seed: "eval-seed",
    steps: [
      { step: "seedCompletedBooking" },
      { step: "conversation", name: "later" },
      { step: "say", text: "book an electrician in koramangala this week" },
      { step: "expect", replyContains: "keep them coming", phase: "choosing" },
      { step: "expect", memoryStatus: { key: "preferred_provider", status: "awaiting_confirmation" } },
      { step: "say", text: "yes" },
      { step: "expect", replyContains: "your choice", optionsBlockCount: 1 },
      { step: "expect", memoryStatus: { key: "preferred_provider", status: "active" } },
    ],
  },
  "18": {
    id: "18",
    name: "Forget the preferred electrician → more bookings with them → never inferred again",
    description:
      "V-12: the user confirms, then forgets; further requests never re-propose or re-ask — the forgotten marker blocks inference.",
    seed: "eval-seed",
    steps: [
      { step: "seedCompletedBooking" },
      { step: "conversation", name: "first" },
      { step: "say", text: "book an electrician in koramangala this week" },
      { step: "say", text: "yes" },
      { step: "expect", memoryStatus: { key: "preferred_provider", status: "active" } },
      { step: "conversation", name: "second" },
      { step: "say", text: "forget my saved provider" },
      { step: "expect", replyContains: "Forgotten" },
      { step: "expect", memoryStatus: { key: "preferred_provider", status: "forgotten" } },
      { step: "seedCompletedBooking" },
      { step: "conversation", name: "third" },
      { step: "say", text: "book an electrician in koramangala this week" },
      { step: "expect", replyNotContains: "keep them coming" },
      { step: "expect", memoryStatus: { key: "preferred_provider", status: "forgotten" } },
    ],
  },
  "12": {
    id: "12",
    name: "Reschedule: slot conflict → back to the same provider's options → rescheduled at the same price",
    description:
      "V-3: only the booked provider's slots are offered; V-9: the approval shows the booking's price; slot_conflict removes the slot and the next pick moves the booking.",
    seed: "eval-seed",
    user: "alice",
    steps: [
      { step: "say", text: "move my AC servicing to Saturday" },
      { step: "expect", phase: "choosing", optionsBlockCount: 1, replyContains: "price stays" },
      { step: "pick" },
      { step: "expect", phase: "awaiting_approval", cardMatchesApproval: true },
      { step: "force", tool: "reschedule", outcome: "slot_conflict" },
      { step: "click", decision: "approve" },
      { step: "expect", phase: "choosing", optionsBlockCount: 1, replyContains: "didn't move" },
      { step: "pick" },
      { step: "force", tool: "reschedule", outcome: "ok" },
      { step: "click", decision: "approve" },
      {
        step: "expect",
        phase: "done",
        replyContains: "price unchanged",
        lastRunToolCalls: ["list_bookings:ok", "reschedule:ok"],
      },
    ],
  },
  // ——— drop / task switch (FR-15, FR-16, V-10, U30) ———
  "22": {
    id: "22",
    name: "'never mind' abandons the request; a different request asks first; 'yes' starts the new one",
    description:
      "FR-16: the drop makes no tool call and says what was not done. FR-15: a cancel on an unfinished booking asks before dropping; yes starts the cancel flow.",
    seed: "eval-seed",
    steps: [
      { step: "say", text: "plumber in Indiranagar" },
      { step: "say", text: "never mind" },
      {
        step: "expect",
        phase: "abandoned",
        replyContains: "Okay, dropped. Nothing was booked.",
        lastRunToolCalls: [],
      },
      { step: "say", text: "electrician in Koramangala" },
      { step: "say", text: "cancel my AC servicing" },
      { step: "expect", phase: "collecting", replyContains: "Drop it and cancel the AC servicing?" },
      { step: "say", text: "yes" },
      { step: "expect", phase: "awaiting_approval", cardMatchesApproval: true },
      { step: "force", tool: "cancel", outcome: "ok" },
      { step: "click", decision: "approve" },
      {
        step: "expect",
        phase: "done",
        replyContains: "Cancelled",
        lastRunToolCalls: ["list_bookings:ok", "cancel:glitch", "cancel:ok"],
      },
    ],
  },
};
