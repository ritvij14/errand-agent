import type { Clock } from "../shared/clock.js";
import { readUserMessage } from "./model.js";
import type { ReadResult } from "./model.js";

// The model slot (ADR-002): the agent core always talks to this interface. Phase 1
// ships the scripted model; a recorded model (phase 2) or OpenRouter (phase 3)
// would implement the same shape. Code drives; the model only reads and writes text.

export type { ReadResult } from "./model.js";

export type ReadJob = {
  text: string;
  waitingFor: string; // what the agent is waiting for (approval, options, nothing)
  clock: Clock; // the controllable clock (NFR-7), so time phrases resolve to "now"
};

export type AgentModel = {
  read: (job: ReadJob) => Promise<ReadResult> | ReadResult;
  write: (job: { purpose: string; state: Record<string, unknown> }) => Promise<string> | string;
};

const HELP_REPLY = `I can help you book, reschedule or cancel home services (plumber, electrician, AC servicing, deep cleaning, carpentry) in Indiranagar, Koramangala, HSR Layout, Jayanagar or Whitefield — with your approval before anything happens.

Try: "Find a plumber this week in HSR Layout under ₹1,500."`;

export const scriptedModel: AgentModel = {
  read: (job) => readUserMessage(job.text, job.clock),
  write: () => HELP_REPLY,
};

export default scriptedModel;