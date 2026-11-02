import type { EvalScenario } from "./runner.js";

// The scenario catalogue (§ 2.5.10). Scenario ids match the design's table;
// scenarios land with their build units — E0 rides in with the runner skeleton
// (U13), the numbered ones 1–23 come with the units that build their subject.
export const SCENARIOS: Record<string, EvalScenario> = {
  E0: {
    id: "E0",
    name: "Runner skeleton: hello → help reply",
    description: "A message the scripted model doesn't understand gets the help reply listing what the agent can do; outcome completed.",
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
    description: "FR-2, MH-3: search, pick, approve; the booking is made once, confirmed with get_booking_status, then reported.",
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
    description: "MH-1: the ask covers exactly the missing required details; an optional 'any budget' is stored and never asked again.",
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
    description: "MH-1, FR-8: a budget correction clears the options and searches again; service, area and time window stay as they were.",
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
    description: "V-2: the slot is held before approval, so the card (drawn from the approval record) shows the hold's quoted price, not the search price.",
    seed: "eval-seed",
    steps: [
      { step: "force", tool: "hold_slot", outcome: "price_changed" },
      { step: "say", text: "plumber in HSR Layout this week, mornings only, under ₹1,500" },
      { step: "expect", phase: "choosing" },
      { step: "pick" },
      { step: "expect", phase: "awaiting_approval", cardMatchesApproval: true, cardPriceDiffersFromSearch: true, replyContains: "quoted" },
    ],
  },
};