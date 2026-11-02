# Bugs Log

> Real bugs hit while building, fixed on the spot. Deliverable 4 ("three real bugs, each with a regression test") is picked from this log — never reconstructed later. Do not write entries for bugs that have not actually happened.

## Bugs

_Format per entry: what broke · why · where fixed · the regression test that first failed (red) then passed (green) · commit._

### B1 — "This week, mornings only" found nothing when asked in the evening

- **What broke.** At 17:54 IST, "plumber in HSR Layout this week, mornings only" returned "nobody has a free slot" — every day of the week came back empty. Found by the U18 QA drive on the real clock; the fixed test clock (09:15) hid it.
- **Why.** The time parser (U16) wrote the current time into `earliest` for any window starting today, as a "nothing in the past" guard. But `earliest` applies to every day of the window, so the window became 17:54–12:00: impossible. At 09:15 it silently cut the 09:00 slots on every later day too.
- **Fix.** `server/src/agent/time-window.ts`: no "now" bound at all — past slots are already dropped by the provider's free-slot calculation. The "earlier time today → tomorrow" shift now only applies to single-day windows.
- **Regression tests (red → green).** `time-window.test.ts` "a multi-day window said in the evening keeps every day's mornings"; `search.flow.test.ts` "asked in the evening, 'this week, mornings only' still offers the coming mornings".
- **Commit.** U18.

### B2 — A complete request in one message stayed in `collecting`

- **What broke.** "plumber in HSR Layout this week" (every required detail at once) got the generic help reply instead of moving on; only requests split over two messages advanced.
- **Why.** Creating a workflow computed its phase from the *empty starting* facts (`nextPhase(w.facts)`) instead of the facts just read, so it always said `collecting` — with nothing missing, the reply was empty and the help text filled in.
- **Fix.** `server/src/agent/workflow.ts`: `nextPhase({ ...w.facts, ...facts })`.
- **Regression test (red → green).** `workflow.test.ts` "a request with every required detail in one message leaves collecting at once"; `search.flow.test.ts` "a complete request returns numbered provider blocks…".
- **Commit.** U18.

### B3 — Workflow insert errors were reported as a lost race

- **What broke.** Inserting a workflow whose conversation row didn't exist failed on the foreign key, but the store answered `{ ok: false }` — the same as losing the one-active-workflow race — so the caller saw a vague `unknown_error` and the real cause vanished (it cost a debugging detour in U17).
- **Why.** `saveWorkflow` caught every insert error as the race.
- **Fix.** `server/src/agent/workflow.ts`: only a `UNIQUE` failure is the race; anything else is thrown.
- **Regression test (red → green).** `search.flow.test.ts` "a save that fails for a reason other than the one-active-workflow race is raised".
- **Commit.** U18.

### B4 — Booking evals passed or failed by luck

- **What broke.** Eval 14 failed once with "That slot was taken…" though nothing in it asks for `slot_taken`; run again, it could pass.
- **Why.** The mock draws a `book` outcome from seed + idempotency key + attempt (§ 2.5.4), and the key is `<operation id>:<n>` — a random UUID. So any scenario that approved a booking without queuing a `book` outcome got a fresh random result each run (`okProb` 0.7), breaking NFR-4 (reproducible evals). The design's draw rule is kept: random outcomes in the app are intended.
- **Fix.** `server/src/evals/scenarios.ts`: evals 13 and 14 queue `book → ok`; every booking scenario now forces its outcome.
- **Regression test (red → green).** `evals/runner.test.ts` "every scenario that approves a booking queues its book outcome…" (red: `['13','14']`). Evals then passed 5 runs in a row.
- **Commit.** U23.
- **Same cause, found again in U25.** `approval.flow.test.ts` "the Approve button approves the card's record…" failed once in a full run: its approve hit a random `slot_taken`, which (since U22) sends the workflow back to `choosing`. Its setup now forces every `book` to `ok` — that file is about the decision, not the booking result. Three full runs green after.

## Invariants found broken by tests

_None yet._

## Fixed without a real-world impact

_None yet._