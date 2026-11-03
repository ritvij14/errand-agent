# Agent Core — state machine and the model slot (§ 2.5.2)

> Status: **In progress** — U11 (traces core), U16 (time parser), U17 (collecting), U18 (search + option blocks) landed; picking/holding/approval follow (U19+).

## What exists

- `agent/index.ts` — the model slot (`AgentModel { read, write }`), scripted model v0 (everything `unknown` → help reply). ADR-002.
- `agent/time-window.ts` — the time-window parser (V-6, NFR-7): chrono-node 2 on the controllable clock's IST "now" + our own rules for "this week" (today→Sunday), "mornings only" (latest 12:00), "(this) evening(s)" / "tonight" (earliest 17:00) and "afternoon(s)" (12:00–17:00) — read by our rules because chrono-node treats them as implied hours, which the parser ignores (bug B6), "not before / never before / after / between" bounds, named days (next occurrence; "last Saturday" → TIME_OUT_OF_RANGE), "tomorrow", explicit dates, "anytime" (no constraints). `mergeCorrection(knows, "after 11")` merges partial corrections per R9 (bounds-only keeps dates; date statements keep bounds). Every parse validates the window against the 14-day slot window. The parser never writes "now" into `earliest` — `earliest` applies to _every_ day of the window, and past slots are already dropped by the provider's free-slot calculation (`tools/slots.ts`). Only a single-day window for today with a bound already passed ("at 3pm" said at 17:00) moves to tomorrow.

## Invariants

- The parser never invents a window it can't read — unparseable text is an explicit failure the conversation runner turns into a re-ask.
- All IST day/time formatting goes through `Intl` with `Asia/Kolkata`; slot dates are the same keys `tools/slots.ts` produces.

## Workflow & collecting (U17)

- `agent/model.ts` — the scripted model's reader (V-1): service/area synonyms, budget ("under ₹1,500", "any budget"), time via the parser, drop phrases, plain yes/no, corrections ("make it Saturday", "no … after 11" → a time correction that merges, R9). Unknown service/area/out-of-range time come back as flags, never guessed values.
- `agent/workflow.ts` — `createWorkflowStore(db, clock, model)`: one active workflow per conversation (`005_workflow.sql`, unique index), optimistic `version` saves (stale → refused), `applyUserText` fills facts with `source: user`, asks once for every missing required detail (service, area, time window; budget/preferences optional), moves to `searching` when complete. The ask names known details as the user reads them ("Plumbing in HSR Layout — when?", "Koramangala — which service and when?"), never raw ids. A changed fact clears `candidates` (rule 2). Errors: `UNKNOWN_SERVICE`, `UNKNOWN_AREA`, `TIME_OUT_OF_RANGE` replies list what is available / ask again, valid details are kept. `useRun({ trace, search })` lends the run's trace (so `fact_changed` / `state_transition` land in it) and its gateway's `search_providers`. A save that fails for any reason other than the one-active-workflow unique index is thrown, never reported as a lost race.
- Gotcha: the model read job carries the controllable `clock` (`ReadJob.clock`) — time phrases must resolve against it, never `Date.now()`.

## Search and option blocks (U18)

- `searching` needs no user input, so the store runs it straight away (`advance`): `search_providers(service, area, from, to)` through the run's gateway, where `from`/`to` are the window's dates or the full 14-day window when a date is open (`searchRange`).
- `agent/options.ts` `buildOptions` (pure): time filter (`earliest` ≤ slot local time < `latest`, every day), then budget (`price ≤ budget`; `any` keeps everyone). Providers ordered by earliest slot (then rating, then id, so the order is stable); **every** matching slot is kept, earliest first. No numbers or letters (ADR-007) — a provider can have 56 slots in 14 days, more than a–z.
- Results are saved as the workflow's `candidates` (the blocks themselves), the phase moves to `choosing`, and the `option_blocks` reply part is drawn from those saved candidates — never from model text (§ 2.5.3 step 7).
- `NO_MATCHES`: the phase stays `searching` with empty candidates, and the reply names the filter that emptied the list — time ("no free slot in that time") or budget ("the cheapest is ₹X"). Any later correction re-runs the search (rule 2).
- The conversation runner builds one tool gateway per run (`ConversationsDeps.mock` sets the seed/settings; evals pass the scenario seed) and records the gateway's call count as the run's `tool_calls`.

## Pick and hold (U19)

- **Reading a pick** (`agent/model.ts` `readPick`): when the workflow is `choosing`, the read job carries the shown option blocks (`ReadJob.options`), the way a real model would be shown the list. A message naming a shown provider is a pick; the rest of the text is read as a time (`parseTimeWindow`) and must narrow that provider's slots to exactly one → `{ kind: "pick", providerId, slot }`, otherwise `pick_unclear`. "the second one" / "that one" is always `pick_unclear`. A message naming no shown provider reads normally, so corrections still work with options on screen.
- **`pickText`** (`agent/options.ts`): every slot in `option_blocks` carries the message the page sends on Confirm — "Book {provider} on {Ddd D Mon} at {HH:MM}" (IST). Built next to the reader; `pick.test.ts` proves every pickText reads back to exactly its slot.
- **The store re-checks** that the pick is among the saved candidates (never trusts the reader). Unclear → "Which slot?" with the options re-shown; no list (or a pick not on it) → `NOTHING_TO_PICK`.
- **`holding`** runs straight away: `hold_slot` through the run's gateway (`RunTools.hold`). `slot_unavailable` (NFR-3: an answer, not a glitch) → that slot is removed from the candidates, back to `choosing` (or `searching` again if nothing is left). Success → see `docs/features/approval-gate.md`.
- Rule 2 now also clears `selection` and `hold` when a fact changes. Voiding the open approval on a correction is U20.

## Decisions while a card waits (U20)

- The reader checks decisions first: a **plain** yes / no (whole message) is a decision; a decision word followed by more words is read as a change from the rest of the message (`readDecisionWithChange`: time → a merging time correction, budget → a budget correction, anything unreadable → `unknown`, never an approval). This is why "not this one" declines instead of being taken as a vague pick.
- In `awaiting_approval` the store routes decisions to `decideOn` (see `docs/features/approval-gate.md`) and re-shows the card for anything unclear. Any fact change voids the open approval first (`user_correction`); a drop voids it (`user_dropped`).
- The conversation runner's `runTurn` is shared by message runs (2 model calls) and `approval_decision` runs (1 model call — the write; no read).

## List my bookings and user isolation (U27, FR-5, V-7, I-10)

- **Reading:** "show / list / see / view / what are … bookings" or "my bookings" → `{ kind: "list_bookings" }` (`agent/model.ts` `LIST_BOOKINGS_RE`, checked after plain decisions, before picks). Whose bookings is never read from the text — "show bob's bookings" is the same request as "show my bookings".
- **Answering** (`workflow.ts` `listMyBookings`): one `list_bookings` call through the run's gateway (`RunTools.list`, bound to the signed-in user), reply "You have N bookings — upcoming and past are below." / "You have no bookings yet.", and a `bookings_list` part `{ id, providerName, service, area, slot, slotLabel, price, status }` (`status` is `completed` for a past `booked` slot, from the mock). It's a side question: the request in progress (any phase) is left exactly where it was.
- **I-10** (eval runner `checkIsolation`): no run's tool calls or agent reply contains a booking id that belongs to another user. Eval 23 runs as **bob** (scenario `user` field) asking for alice's bookings; a negative test proves the check fires. Cancel isolation at the tool layer (another user's booking → `not_found`) is tested in `tools/cancel-reschedule.test.ts`; the agent's cancel flow is U28.

## Cancel: identifying the booking (U28, FR-4, R9)

- **Reading:** any message with "cancel" (except "cancel that", a drop) → `{ kind: "cancel" }`.
- **Starting (FR-15):** a cancel or reschedule opens its own workflow (`identifying_booking`). On an unfinished request the code asks before dropping (`askBeforeSwitch`); same as U30's booking ask: "You haven't finished booking the plumber. Drop it and cancel the AC servicing?"
- **Identifying** (`identifyTarget`, pure match in `matchBookings`): the user's own `list_bookings`, upcoming (`booked`) only — a booking id in the text, else the service (`findService`), else a provider name, else all upcoming. One match → a cancel card (approval `action: cancel`, the booking's provider, slot, price and `booking_id`; the workflow keeps `target_booking_id`, and `candidates` holds the target as one provider block so the card and reply can name it). None → `BOOKING_NOT_FOUND`, several → `BOOKING_AMBIGUOUS`: stay in `identifying_booking`, list the upcoming bookings (`bookings_list`) and ask which; the next message is matched the same way.
- **Decline ends it** (R9): workflow `abandoned`, "I kept your booking. Nothing was cancelled." An expired cancel card re-identifies the same booking for a fresh card.

## Reschedule (U29, FR-3, V-3, V-9)

- **Reading:** "reschedule …" or "move my …" → `{ kind: "reschedule", timeWindow? }` (the time in the same message is the new time). Checked after picks, so a reschedule's own pick text never restarts it; "move it to 11" stays a correction.
- **Flow:** `identifying_booking` (same matching as cancel) → the booking's service and area become the workflow's facts → `collecting` asks "When would you like to move your {provider} booking (now {slot}) to?" unless a time was given → `searching` (`searchReschedule`): `search_providers` in the booking's area, kept to the **booked provider only** (V-3), the booking's own slot removed, each block showing the **booking's price** (V-9), pick text "Move to {slot} with {provider}" (`movePickText`) → `choosing` → a pick goes straight to `awaiting_approval` (no hold, `proposeReschedule`) with the booking's price → `executing`.
- The booking is re-read with `list_bookings` whenever a later run needs it (no local copy of bookings); when the search follows identification in the same run it reuses that read.
- **One approval helper:** `openApproval` (save `awaiting_approval` + insert the pending approval in one transaction, trace it, draw the card) serves book, cancel and reschedule.
- A correction never switches the workflow's intent (`applyToWorkflow` keeps `w.intent`); task switching is U30.

## Drop and task switch (U30, FR-15, FR-16, V-10, R9)

- **Reading:** a drop is said at the **start** of the message, never inside a sentence ("my tap won't stop leaking", "not that expensive" are not drops). "never mind" / "forget it" / "forget that" / "cancel that" may carry a new request after them (`{ kind: "drop", rest }`); "stop" / "not that" count only on their own; "(I) don't need …" drops the whole message. "cancel my …" stays the cancel action. A bare drop on no active workflow is `NOT_UNDERSTOOD`.
- **Drop + new request ("never mind, I want an electrician in HSR tomorrow"):** the current workflow is dropped as below, then `rest` is applied as a fresh message in the same run; the reply is the drop wording followed by the new request's reply. With nothing open, `rest` is simply applied.
- **Drop (FR-16):** the open approval is voided (`user_dropped`), the workflow ends `abandoned`, and the wording says what was not done: booking → "Okay, dropped. Nothing was booked."; reschedule → "…Nothing was changed."; cancel → "…Your booking is unchanged." No tool call.
- **Switch ask (FR-15):** a different intent on an unfinished workflow stores `pending_question` `{type: "task_switch", text, intent}` and asks ("… Drop it and …?"). A plain "yes" abandons the old workflow and re-applies the stored text; "no" clears the question and the task continues (the reply restates the current ask). Both replies are traced as `state_transition`.
- **No stacking (R9):** with an approval card open the switch is refused ("approve or decline the card above first") instead of asking; during `executing` / `verifying` the switch waits ("still confirming") and a correction is refused with `CHANGE_REFUSED_IN_FLIGHT`.
- **Bare time/budget answers never switch:** the model reads a lone "Saturday morning" as a book request without a service; only an explicit service in the read counts as a new request (a correction applies it).

## Provider details and injection defence (U31, MH-4, FR-6, § 2.5.7)

- **Reading:** "tell me about provider N" (an ordinal into the shown blocks), "tell me more about {provider name}", or the client's per-provider **Details** button (sends `Tell me more about {name}`). The read is checked before a pick would match, since its phrasing never picks a slot. When no provider resolves from the shown options the user is asked to use the Details link; no tool call.
- **Answer without touching the workflow:** `providerDetails` leaves phase, facts and approvals exactly as they were. The details reply replaces the option blocks only in the message history — the workflow keeps its candidates, and the eval runner's `pick` falls back to stored candidates when options have scrolled off the last reply.
- **The read step never sees reviews (rule 1):** only the user's text and the waiting-for hint reach the model; `get_provider` is called once through the gateway (cap-counted, traced with `suspectedInjection` when any review matched the pattern check, review text cut to 500 chars).
- **Decisions from structured fields only (rules 2–5):** the reply text names name, service, price, rating, verified and warranty — never free text. No code path turns review text into an action; runner I-8 checks that every pending approval is exactly the workflow's own selection/hold/target (used approvals may be superseded by a re-pick or re-hold, so only those are checked).
- **Reviews as quoted data (rule 6):** a `provider_details` part with a "Reviews (from the provider, not checked)" block; the client renders quoted plain text, and reviews flagged `suspectedInjection` get the "⚠ contains instructions — ignored" badge (label only — nothing depends on it).
