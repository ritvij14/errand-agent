// The elapsed-time timer (R8): monotonic wall-clock since start, used for the run
// deadline (NFR-1) — deliberately not the calendar clock, so clock-advance can't
// satisfy a cap and simulated pauses can't hide real elapsed time.

export type Elapsed = {
  ms: () => number;
};

export const createElapsed = (opts?: { nowMs?: () => number }): Elapsed => {
  const tick = opts?.nowMs ?? (() => performance.now());
  const start = tick();
  return {
    ms: () => Math.max(0, tick() - start),
  };
};