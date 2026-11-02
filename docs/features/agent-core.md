# Agent Core — state machine and the model slot (§ 2.5.2)

> Status: **In progress** — U11 (traces core), U16 (time parser) landed; the workflow state machine lands with U17+.

## What exists

- `agent/index.ts` — the model slot (`AgentModel { read, write }`), scripted model v0 (everything `unknown` → help reply). ADR-002.
- `agent/time-window.ts` — the time-window parser (V-6, NFR-7): chrono-node 2 on the controllable clock's IST "now" + our own rules for "this week" (today→Sunday), "mornings only" (latest 12:00), "not before / after / between" bounds, named days (next occurrence; "last Saturday" → TIME_OUT_OF_RANGE), "tomorrow", explicit dates, "anytime" (no constraints). `mergeCorrection(knows, "after 11")` merges partial corrections per R9 (bounds-only keeps dates; date statements keep bounds). Every parse validates the window against the 14-day slot window; a today-including window with no explicit bound defaults to "not before now".

## Invariants

- The parser never invents a window it can't read — unparseable text is an explicit failure the conversation runner turns into a re-ask.
- All IST day/time formatting goes through `Intl` with `Asia/Kolkata`; slot dates are the same keys `tools/slots.ts` produces.

## Workflow & collecting (U17)

- `agent/model.ts` — the scripted model's reader (V-1): service/area synonyms, budget ("under ₹1,500", "any budget"), time via the parser, drop phrases, plain yes/no, corrections ("make it Saturday", "no … after 11" → a time correction that merges, R9). Unknown service/area/out-of-range time come back as flags, never guessed values.
- `agent/workflow.ts` — `createWorkflowStore(db, clock, model)`: one active workflow per conversation (`005_workflow.sql`, unique index), optimistic `version` saves (stale → refused), `applyUserText` fills facts with `source: user`, asks once for every missing required detail (service, area, time window; budget/preferences optional), moves to `searching` when complete. A changed fact clears `candidates` (rule 2). Errors: `UNKNOWN_SERVICE`, `UNKNOWN_AREA`, `TIME_OUT_OF_RANGE` replies list what is available / ask again, valid details are kept. `useTrace(trace)` lends the run's trace so `fact_changed` and `state_transition` land in it.
- Gotcha: the model read job carries the controllable `clock` (`ReadJob.clock`) — time phrases must resolve against it, never `Date.now()`.
