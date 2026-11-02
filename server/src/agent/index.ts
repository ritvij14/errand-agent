// The model slot (ADR-002): the agent core always talks to this interface. Phase 1
// ships the scripted model; a recorded model (phase 2) or OpenRouter (phase 3)
// would implement the same shape. Code drives; the model only reads and writes text.

export type ReadJob = {
  text: string;
  waitingFor: string; // what the agent is waiting for (approval, options, nothing)
};

export type ReadResult =
  | { kind: "unknown" } // NOT_UNDERSTOOD
  | { kind: "workflow"; intent: "book" | "reschedule" | "cancel"; [fact: string]: unknown };

export type AgentModel = {
  read: (job: ReadJob) => Promise<ReadResult>;
  write: (job: { purpose: string; state: Record<string, unknown> }) => Promise<string>;
};

const HELP_REPLY = `I can help you book, reschedule or cancel home services (plumber, electrician, AC servicing, deep cleaning, carpentry) in Indiranagar, Koramangala, HSR Layout, Jayanagar or Whitefield — with your approval before anything happens.

Try: "Find a plumber this week in HSR Layout under ₹1,500."`;

export const scriptedModel: AgentModel = {
  read: async () => ({ kind: "unknown" as const }),
  write: async () => HELP_REPLY,
};

export default scriptedModel;