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
  "2": {
    id: "2",
    name: "Only missing details asked; 'any budget' never asked again",
    description: "MH-1: the ask covers exactly the missing required details; an optional 'any budget' is stored and never asked again.",
    seed: "eval-seed",
    steps: [
      { step: "say", text: "I need a plumber, any budget" },
      { step: "expect", replyContains: "which area and when", replyNotContains: "budget" },
      { step: "say", text: "hsr layout mornings only" },
      { step: "expect", phase: "searching", outcome: "completed" },
    ],
  },
};