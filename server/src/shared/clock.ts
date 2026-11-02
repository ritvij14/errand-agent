// The controllable calendar clock (NFR-7): real time by default, a fixed/advanceable
// time in tests and evals. Calendar decisions (slots, holds, timestamps) go through
// this; run-deadline time goes through elapsed.ts — the two are separate by design (R8).

export type Clock = {
  now: () => Date;
  setNow: (d: Date) => void;
  advanceMs: (ms: number) => Date;
};

export const createClock = (opts?: { now?: Date }): Clock => {
  let current = opts?.now ?? new Date();
  return {
    now: () => new Date(current.getTime()),
    setNow: (d: Date) => {
      current = d;
    },
    advanceMs: (ms: number) => {
      current = new Date(current.getTime() + ms);
      return new Date(current.getTime());
    },
  };
};

const IST_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

// ISO-like IST stamp, e.g. "2026-11-07, 14:30" — deterministic, readable in traces.
export const isoInIst = (d: Date): string => IST_FORMAT.format(d);