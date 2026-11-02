# Agent Core — state machine and the model slot (§ 2.5.2)

> Status: **In progress** — U11 (traces core), U16 (time parser) landed; the workflow state machine lands with U17+.

## What exists

- `agent/index.ts` — the model slot (`AgentModel { read, write }`), scripted model v0 (everything `unknown` → help reply). ADR-002.
- `agent/time-window.ts` — the time-window parser (V-6, NFR-7): chrono-node 2 on the controllable clock's IST "now" + our own rules for "this week" (today→Sunday), "mornings only" (latest 12:00), "not before / after / between" bounds, named days (next occurrence; "last Saturday" → TIME_OUT_OF_RANGE), "tomorrow", explicit dates, "anytime" (no constraints). `mergeCorrection(knows, "after 11")` merges partial corrections per R9 (bounds-only keeps dates; date statements keep bounds). Every parse validates the window against the 14-day slot window; a today-including window with no explicit bound defaults to "not before now".

## Invariants

- The parser never invents a window it can't read — unparseable text is an explicit failure the conversation runner turns into a re-ask.
- All IST day/time formatting goes through `Intl` with `Asia/Kolkata`; slot dates are the same keys `tools/slots.ts` produces.
