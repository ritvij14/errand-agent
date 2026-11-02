import { createElapsed, type Elapsed } from "./elapsed.js";

// One run's caps (NFR-1, § 2.5.3): checked BEFORE every model call, tool call and wait,
// and re-checked after awaited work returns (R8). Time is the elapsed timer plus the
// simulated pauses and waits of this run — never the calendar clock, so an eval's
// clock advance can't satisfy a cap and a simulated pause can't skip one.

export type Caps = { modelCalls: number; toolCalls: number; elapsedMs: number };
export const CAPS: Caps = { modelCalls: 6, toolCalls: 10, elapsedMs: 60_000 };

export type CapCode = "cap_model_calls" | "cap_tool_calls" | "cap_time";

/** A cap would be crossed. Thrown so the run unwinds at once; the runner turns it into the run's ending. */
export class CapHit extends Error {
  constructor(readonly cap: CapCode) {
    super(cap);
    this.name = "CapHit";
  }
}

export type RunBudget = {
  beforeModelCall: () => void;
  beforeToolCall: () => void;
  /** a simulated pause or wait: returns the ms actually waited — never past the time left */
  wait: (ms: number) => number;
  checkTime: () => void;
  /** awaited work raced against the time left; the deadline is re-checked when it returns */
  race: <T>(work: Promise<T> | T) => Promise<T>;
  used: () => { modelCalls: number; toolCalls: number; elapsedMs: number };
};

export const createRunBudget = (opts?: { caps?: Caps; elapsed?: Elapsed; toolCalls?: number }): RunBudget => {
  const caps = opts?.caps ?? CAPS;
  const elapsed = opts?.elapsed ?? createElapsed();
  let modelCalls = 0;
  let toolCalls = opts?.toolCalls ?? 0;
  let simulatedMs = 0;
  const elapsedMs = () => elapsed.ms() + simulatedMs;
  const timeLeft = () => caps.elapsedMs - elapsedMs();
  const checkTime = () => {
    if (timeLeft() <= 0) throw new CapHit("cap_time");
  };

  return {
    beforeModelCall: () => {
      checkTime();
      if (modelCalls >= caps.modelCalls) throw new CapHit("cap_model_calls");
      modelCalls += 1;
    },
    beforeToolCall: () => {
      checkTime();
      if (toolCalls >= caps.toolCalls) throw new CapHit("cap_tool_calls");
      toolCalls += 1;
    },
    wait: (ms) => {
      checkTime();
      const waited = Math.min(ms, timeLeft());
      simulatedMs += waited;
      return waited;
    },
    checkTime,
    race: async (work) => {
      checkTime();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CapHit("cap_time")), Math.max(0, timeLeft()));
      });
      try {
        const result = await Promise.race([Promise.resolve(work), deadline]);
        checkTime();
        return result;
      } finally {
        clearTimeout(timer);
      }
    },
    used: () => ({ modelCalls, toolCalls, elapsedMs: Math.round(elapsedMs()) }),
  };
};
