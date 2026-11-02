# Agent Core — state machine and the model slot (§ 2.5.2)

> Status: **In progress** — U11 (traces core), U16 (time parser), U17 (collecting), U18 (search + option blocks) landed; picking/holding/approval follow (U19+).

## What exists

- `agent/index.ts` — the model slot (`AgentModel { read, write }`), scripted model v0 (everything `unknown` → help reply). ADR-002.
- `agent/time-window.ts` — the time-window parser (V-6, NFR-7): chrono-node 2 on the controllable clock's IST "now" + our own rules for "this week" (today→Sunday), "mornings only" (latest 12:00), "not before / after / between" bounds, named days (next occurrence; "last Saturday" → TIME_OUT_OF_RANGE), "tomorrow", explicit dates, "anytime" (no constraints). `mergeCorrection(knows, "after 11")` merges partial corrections per R9 (bounds-only keeps dates; date statements keep bounds). Every parse validates the window against the 14-day slot window. The parser never writes "now" into `earliest` — `earliest` applies to *every* day of the window, and past slots are already dropped by the provider's free-slot calculation (`tools/slots.ts`). Only a single-day window for today with a bound already passed ("at 3pm" said at 17:00) moves to tomorrow.

## Invariants

- The parser never invents a window it can't read — unparseable text is an explicit failure the conversation runner turns into a re-ask.
- All IST day/time formatting goes through `Intl` with `Asia/Kolkata`; slot dates are the same keys `tools/slots.ts` produces.

## Workflow & collecting (U17)

- `agent/model.ts` — the scripted model's reader (V-1): service/area synonyms, budget ("under ₹1,500", "any budget"), time via the parser, drop phrases, plain yes/no, corrections ("make it Saturday", "no … after 11" → a time correction that merges, R9). Unknown service/area/out-of-range time come back as flags, never guessed values.
- `agent/workflow.ts` — `createWorkflowStore(db, clock, model)`: one active workflow per conversation (`005_workflow.sql`, unique index), optimistic `version` saves (stale → refused), `applyUserText` fills facts with `source: user`, asks once for every missing required detail (service, area, time window; budget/preferences optional), moves to `searching` when complete. A changed fact clears `candidates` (rule 2). Errors: `UNKNOWN_SERVICE`, `UNKNOWN_AREA`, `TIME_OUT_OF_RANGE` replies list what is available / ask again, valid details are kept. `useRun({ trace, search })` lends the run's trace (so `fact_changed` / `state_transition` land in it) and its gateway's `search_providers`. A save that fails for any reason other than the one-active-workflow unique index is thrown, never reported as a lost race.
- Gotcha: the model read job carries the controllable `clock` (`ReadJob.clock`) — time phrases must resolve against it, never `Date.now()`.

## Search and option blocks (U18)

- `searching` needs no user input, so the store runs it straight away (`advance`): `search_providers(service, area, from, to)` through the run's gateway, where `from`/`to` are the window's dates or the full 14-day window when a date is open (`searchRange`).
- `agent/options.ts` `buildOptions` (pure): time filter (`earliest` ≤ slot local time < `latest`, every day), then budget (`price ≤ budget`; `any` keeps everyone). Providers ordered by earliest slot (then rating, then id, so the order is stable); **every** matching slot is kept, earliest first. No numbers or letters (ADR-007) — a provider can have 56 slots in 14 days, more than a–z.
- Results are saved as the workflow's `candidates` (the blocks themselves), the phase moves to `choosing`, and the `option_blocks` reply part is drawn from those saved candidates — never from model text (§ 2.5.3 step 7).
- `NO_MATCHES`: the phase stays `searching` with empty candidates, and the reply names the filter that emptied the list — time ("no free slot in that time") or budget ("the cheapest is ₹X"). Any later correction re-runs the search (rule 2).
- The conversation runner builds one tool gateway per run (`ConversationsDeps.mock` sets the seed/settings; evals pass the scenario seed) and records the gateway's call count as the run's `tool_calls`.
