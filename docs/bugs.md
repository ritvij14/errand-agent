# Bugs Log

> Real bugs hit while building, fixed on the spot. Deliverable 4 ("three real bugs, each with a regression test") is picked from this log — never reconstructed later. Do not write entries for bugs that have not actually happened.

## Deliverable 4 — the three picked

One per layer: the time parser, the eval suite's reproducibility, and the traces. Full write-ups below. Each regression test is named and passes (`npm test`; rerun alone with `npx vitest run -t "<name>"` in `server/`).

| Bug                                                                        | What broke                                                                                                            | Regression test (red → green)                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [B1](#b1--this-week-mornings-only-found-nothing-when-asked-in-the-evening) | "This week, mornings only" asked at 17:54 found nothing: "now" was written into `earliest` for every day              | `server/src/agent/time-window.test.ts` "a multi-day window said in the evening keeps every day's mornings (no 'now' bound)"; `server/src/agent/search.flow.test.ts` "asked in the evening, 'this week, mornings only' still offers the coming mornings" |
| [B4](#b4--booking-evals-passed-or-failed-by-luck)                          | Booking evals passed or failed by luck: an unforced `book` drew a random outcome from a random-UUID key               | `server/src/evals/runner.test.ts` "every scenario that approves a booking queues its book outcome, so it never depends on a random key (NFR-4)"                                                                                                         |
| [B7](#b7--traces-recorded-no-latency)                                      | Traces recorded no latency (MH-7): every `durationMs` was null; the run's "duration" counted the simulated 10 s pause | `server/src/agent/booking.flow.test.ts` "the trace records real latency for every model and tool call, never the simulated 10 s pause (MH-7)"                                                                                                           |

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
- **Why.** Creating a workflow computed its phase from the _empty starting_ facts (`nextPhase(w.facts)`) instead of the facts just read, so it always said `collecting` — with nothing missing, the reply was empty and the help text filled in.
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

### B5 — A fresh clone failed `npm test`

- **What broke.** Following the README in a fresh `git clone` (U38 QA), `npm test` stopped at the evals: "Cannot open database because the directory does not exist".
- **Why.** Each eval opens `server/data/eval-<id>.db`; `server/data/` is git-ignored, so it only existed in the working copy where the dev server had once created it.
- **Fix.** `server/src/evals/eval.cli.ts`: `mkdir(server/data, { recursive: true })` before the first scenario. (The app's own start already did this since U37's `openAppDatabase`.)
- **Regression check (red → green).** The clean-clone run itself: clone → `npm install` → `npm test` failed, then passed after the fix (`/tmp/errand-verify/clone-test.log`). No unit test — the failure needs a missing folder, which the README run checks.
- **Commit.** `1c73cd6` (U38).

### B6 — "Saturday evening" offered 08:00 slots

- **What broke.** "reschedule my AC servicing to Saturday evening" offered 08:00, 09:00, 10:00 and 17:00. Found while checking the README's example prompts on the dev server (U38).
- **Why.** The time parser only read "tonight" and "this evening". A bare "evening" (or "afternoon") was passed to chrono-node, which reads it as an implied hour, not a fixed one, so the code dropped it. The user's time constraint vanished without a word.
- **Fix.** `server/src/agent/time-window.ts`: "(this) evening(s)(only)" / "tonight" → not before 17:00; "(this) afternoon(s)(only)" → 12:00–17:00.
- **Regression tests (red → green).** `time-window.test.ts` rows "Saturday evening", "evenings only", "tomorrow afternoon" (3 red). The fix then turned `task-switch.flow.test.ts` "'yes' to the switch…" red: its "Saturday afternoon" had only found slots because "afternoon" was ignored. Ganesh Cooltech has no Saturday slot from 12:00 to 17:00, so the reply is now "no free slot in that time", which is correct. The test now says "Saturday evening".
- **Commit.** U39.

### B7 — Traces recorded no latency

- **What broke.** MH-7 asks for latency in every trace; every committed trace event had `durationMs: null`. Found while checking the design note's claims against the deliverable-5 trace.
- **Why.** `trace.record` takes the duration as its 3rd argument, but neither the tool gateway nor the conversation service ever passed one. `run_ended` put the cap budget's time (real plus the 10 s simulated pause) in a data field named `durationMs`, which looked like latency but wasn't.
- **Fix.** `tool-gateway.ts` and `conversations.service.ts` time every tool call, model read/write and the run with the real elapsed timer. `run_ended`'s budget time is renamed `countedMs`.
- **Regression test (red → green).** `booking.flow.test.ts` "the trace records real latency for every model and tool call, never the simulated 10 s pause" (red: `expected null to be type of 'number'`).
- **Commit.** U39.

### B8 — The memory panel ignored preferences saved through chat

- **What broke.** Typing "I live in Koramangala" saved the fact on the server, but **Saved preferences** didn't show it until the window lost and regained focus or the page reloaded. Found by a code scan after U40 (not yet seen in the browser).
- **Why.** `useSendMessage` / `useDecideApproval` reloaded only the conversation queries. Only the panel's own buttons invalidated `["memory"]`.
- **Fix.** `client/src/shared/queries.ts` `refreshConversation` also invalidates `["memory"]`. In the same change, it prefetches the reply's trace by its `runId` (one round trip fewer, not a bug).
- **Regression tests (red → green).** `client/src/screens/Chat.test.tsx` "a chat message that saves a preference shows it in the memory panel without a reload" (red: `/you told me/` not found); "the new reply's trace starts loading with the conversation reload, not after it" (red: trace never called with `r9`).
- **Commit.** post-U40.

_B9–B13 were found by the post-build requirements review (driving the agent through the eval runner with the brief's own example sentences)._

### B9 — Editing an inferred fact in the memory panel kept it labelled "inferred"

- **What broke.** Editing a waiting inferred provider made it active but still labelled "I worked out" — it looked like an inferred fact used without confirmation (MH-6).
- **Why.** `saveStated`'s `ON CONFLICT` updated value and status but never `source`; the route test only edited an already-stated fact.
- **Fix.** `server/src/memory/memory.repo.ts`: the conflict update also sets `source = 'stated'`.
- **Regression test (red → green).** `memory/memory.routes.test.ts` "PUT on an inferred fact: the user's edit makes it stated (MH-6 labels stay honest)".

### B10 — Declining a card, then picking the same slot, said "That slot was just taken"

- **What broke.** After Decline, choosing the same slot again failed; the slot read as taken for up to 10 minutes.
- **Why.** The user's own hold from before the decline stayed live, and `hold_slot`'s free check counted every unexpired hold, the caller's included.
- **Fix.** `server/src/tools/slots.ts` `freeSlots(…, holderId)` skips the caller's own holds; `holdSlot` replaces the caller's old hold on that slot. Other users are still refused.
- **Regression tests (red → green).** `agent/approval.flow.test.ts` "after a decline, picking the same slot again gives a fresh card — the user's own hold doesn't block it"; `tools/write-tools.test.ts` "the same user can hold their own held slot again: the new hold replaces the old one, others stay refused".

### B11 — The brief's "same electrician as last time, but not before 10 a.m." was saved as a preference and the booking lost

- **What broke.** The reply was "Saved: your saved earliest time is not before 10:00."; the electrician request vanished, so "Koramangala" next got "which service?" (MH-1), and a one-off detail became a stated preference (MH-6).
- **Why.** The memory-save read ran before the request read and matched `(never|not) before` anywhere in the message.
- **Fix.** `server/src/agent/model.ts`: a message naming a service is a request, never a memory save; only "never before" is lasting. `time-window.ts` reads "never before" as a bound too.
- **Regression tests (red → green).** `agent/model-v1.test.ts` "a 'not before' inside a booking request is this request's time, never a saved preference (MH-1, MH-6)"; `agent/memory.flow.test.ts` "the brief's 'same electrician as last time, but not before 10 a.m.' starts a booking and saves nothing stated".

### B12 — "My tap won't stop leaking" dropped the request

- **What broke.** "stop", "not that", "don't need" anywhere in a message read as a drop: "plumber in HSR, my kitchen tap won't stop leaking" and "…not that expensive please" got the help reply; "never mind, I want an electrician…" lost the new request.
- **Why.** `DROP_RE` had no position or word limits and ran first.
- **Fix.** `server/src/agent/model.ts` `readDrop`: drops only at the start of the message; "never mind / forget it / cancel that, <request>" carries the request as `rest`, which the workflow applies after dropping.
- **Regression tests (red → green).** `agent/model-v1.test.ts` "drop words inside an ordinary sentence are not a drop (FR-16)", "'never mind, <new request>' drops and carries the new request along"; `agent/task-switch.flow.test.ts` the two "'never mind, <new request>'" tests.

### B13 — A saved "never before 10" was ignored once the user named a day

- **What broke.** After "never before 10", "plumber in HSR this week" offered 08:00 and 09:00 slots.
- **Why.** Memory filled the time window only when the request had none at all.
- **Fix.** `server/src/agent/workflow.ts`: the saved earliest time also bounds a request window without its own earliest; forgetting it keeps the request's days (`syncMemoryFacts`), with a time-specific note (it used to say "Your saved area is gone").
- **Regression tests (red → green).** `agent/memory.flow.test.ts` "a saved 'never before 10' also bounds a request that names only days; forgetting it keeps the days (MH-6, R6)"; "a request's own earliest time wins over the saved one (V-11)" (guard, green from the start).

### B14 — The running app's clock never moved

- **What broke.** In `npm run dev` "now" stayed at the moment the server started: holds and approval cards never expired with real time, "today" never rolled over, and messages / runs / trace events from different minutes got the same time. Only the mock's simulated pauses moved it, a few seconds at a time.
- **Why.** `createClock()` with no fixed time saved `new Date()` once and only changed it through `advanceMs`; its comment said "real time by default". Every test creates its clock with a fixed time, so nothing exercised the app's default.
- **Fix.** `server/src/shared/clock.ts`: with no fixed time the clock returns the real time on every read, and `advanceMs` / `setNow` are ignored, so simulated pauses never push the app ahead of real time (operator's choice: strict real time). The pauses still count toward the 60 s cap through `run-budget.ts`. Deliverable-5 trace re-exported from a live run: `traces/61943514-4f6e-487c-8e2c-c53af40a62fe.json`.
- **Regression tests (red → green).** `shared/clock.test.ts` "the default clock keeps following real time after it is created" (red: moved 0 ms); "the default clock stays on real time: a simulated pause (advanceMs) doesn't push it ahead" (red: 10 000 ms ahead).

### B15 — A provider name could be read as a user command

- **What broke.** Confirm on a slot sends `pickText` ("Book {provider} on {slot}") as a chat message. The scripted model checked drop / memory / details / cancel patterns before matching a pick, so a provider named "Cancel-Free Fixers" started a cancel instead of picking the slot — provider-side free text changing intent (MH-4, § 2.5.7 rule 1). A name like "I Live In Whitefield Fixers" would have reached the memory-save pattern the same way.
- **Why.** Provider names are untrusted free text, but rule 1 was only enforced for reviews; names come back to the server inside the user's own message.
- **Fix.** `server/src/agent/model.ts` `withoutProviderNames`: every shown provider name is blanked before any intent pattern runs; only the pick and the details lookup match names against the raw text.
- **Regression test (red → green).** `agent/provider-details.flow.test.ts` "a provider name that reads like a command is only a name: Confirm on its slot picks it and nothing else" (red: "Cancel-Free Fixers" got no approval card). Found in a design-vs-code review, not a live report; today's seeded names are harmless.

### B16 — The shape check let wrong values through

- **What broke.** § 2.5.7 rule 7 promises types, ranges and allowed values, but the gateway only checked a few fields (ids are text, slots a list, `quotedPrice` a number). A rating of 50, a price of −₹100, an unknown service or booking status, or a slot like "tomorrow, trust me" passed and would have been shown or used.
- **Fix.** `server/src/tools/tool-gateway.ts`: per-tool checks — prices positive whole rupees, ratings 0–5, slots ISO times, service / area / booking status from the fixed lists, every review text a string, `get_booking_status` `booked` only with a booking id.
- **Regression tests (red → green).** `tools/tool-gateway.test.ts` "a search result with a rating outside 0–5 is refused", "… a price that isn't a positive whole number of rupees is refused", "provider details with a service outside the mock world are refused", "a booking with an unknown status or a slot that isn't a time is refused" (all four red before the fix).

### B17 — Only the preferred provider was ever inferred

- **What broke.** § 2.5.8 infers `area` (same area in 2 completed bookings) and `earliest_time` (same "not before X" twice), but only `preferred_provider` was built: a user with two Jayanagar bookings was simply asked "which area?".
- **Fix.** `server/src/agent/workflow.ts` `proposeFromHistory` → `proposeArea` / `proposeEarliestTime` (one proposal per request, provider → area → time; same `awaiting_confirmation` → yes/no path); `decideMemoryConfirm` applies a confirmed earliest time to the window; a detail the user names while the ask waits wins and drops the ask.
- **Regression tests (red → green).** `agent/memory.flow.test.ts` "two completed bookings in one area propose that area…", "the same 'not before 10' in two finished bookings proposes an earliest time…" (both red); guards green from the start: "'no' to the proposed area forgets it…", "an area the user names while the proposal waits wins…", "a request that gives its own earliest time is not asked…". Found in a design-vs-code review.

### B18 — A chat "yes" applied a memory fact the user had already rejected in the panel

- **What broke.** With an inferred area waiting in chat, the user rejected it in the memory panel, then said "yes" in chat: the rejected area filled the booking anyway ("Using your saved area: Jayanagar"). A typed yes also had no way to say *which* memory question it answered.
- **Why.** The chat answer only looked at the workflow's `pending_question`, never at the fact's current status; panel decisions happen outside a run and don't touch the workflow.
- **Fix.** `server/src/agent/workflow.ts` `answerMemoryCard`: decides only when the card's `memoryFactId` is the waiting question and the fact is still `awaiting_confirmation`; otherwise it changes nothing and says so (`MEMORY_CONFIRM_STALE`). The reply carries a `memory_confirm` card (`client/src/components/MemoryConfirmCard.tsx`: Keep / Don't keep), and every yes / no carries its `memoryFactId`.
- **Regression tests (red → green).** `agent/memory.flow.test.ts` "Keep on a card already answered in the memory panel changes nothing and says so — never a booking report" (red: the rejected area was applied), "a 'yes' carrying a different fact's id never confirms the waiting one", "the proposal comes with a memory card naming the waiting fact…"; `client/src/screens/Chat.test.tsx` "Chat — memory card" (4 tests).

### B19 — Traces cut tool results at 4,000 characters, and the reply-writing call had no input

- **What broke.** The gateway stored `JSON.stringify(result).slice(0, 4000)`: a broad search (more providers or days) would leave a truncated, unparseable result in the trace, though § 2.5.9 promises the full structured result. The write `model_call` recorded only its output, not the decision it worded.
- **Fix.** `server/src/tools/tool-gateway.ts` keeps the whole result (review text stays capped at 500); `server/src/conversations/conversations.service.ts` records the write call's `input: { phase, code }`.
- **Regression tests (red → green).** `tools/tool-gateway.test.ts` "a long result is kept whole and readable — never cut mid-way" (red: 4000 chars); `conversations.test.ts` "the trace of that run shows run_started → model_call ×2 → run_ended" now also checks both calls' input (red: no write input). Found in an MH-7 review.

### B20 — The eval table and its coverage gate claimed more than they showed

- **What broke.** (1) Every row's "actual" was `lastOutcome=completed` — the table never showed what the checks observed. (2) `MUST_COVER` mapped "timeout after success" to scenario 10 (the timeout that booked nothing), "slot conflict" also to 8 (hold expired), "price/slot change after approval" also to 5 (a change *before* approval) — so the gate could pass on the wrong scenario. (3) Eval 4 exercised one injection kind while the design lists five.
- **Fix.** `server/src/evals/runner.ts`: each `expect` step records what it saw (`phase=…`, `tools=[…]`, `agent bookings=…` …) into "actual"; `MUST_COVER` names only the scenarios that test each category. `scenarios.ts` eval 4 visits one provider per injection kind.
- **Regression tests (red → green).** `evals/runner.test.ts` "the actual column shows what each expectation observed…" and the coverage test's new cases — removing 9, 12, or 6 + 7 fails that category by name (both red). Eval 4 itself proves the five kinds. Found in an MH-8 review.

## Invariants found broken by tests

_None yet._

## Fixed without a real-world impact

_None yet._
