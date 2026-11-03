# Memory & preferences (MH-6)

> Status: stated + inferred memory + the memory HTTP API + the client panel live (U32–U34).

## What exists

- `memory_fact` table (`migrations/008_memory.sql`) — `id, user_id, key, service, value, source ('stated'|'inferred'), status ('active'|'awaiting_confirmation'|'forgotten'), evidence, created_at, updated_at, confirmed_at, forgotten_at`. STRICT; a forgotten row is kept as a hidden marker (key + value) that blocks re-**inference** of the same value.
- `server/src/memory` — the only code that touches the table. `state` (active fact for a key), `view` (active + awaiting), `saveStated` (insert, or correct in place — including re-stating a forgotten fact, which is the user's choice), `forget`, `blockedByForget` (the marker U33 must respect), `byId` / `inferCandidate` / `confirm` / `reject` (U33), and the HTTP routes (`memory.routes.ts`, mounted in `app.ts`, U34).

## How facts get in (U32)

- Only **explicit, lasting statements** from the user's chat: "I live in HSR", "my area is Koramangala now", "never before 10am". The scripted model reads these as `memory_save` (key `area` / `earliest_time`) — checked before the normal workflow read, but **only when the message names no service**: a message naming a service is a booking request, and its details ("plumber in HSR", "electrician tomorrow, not before 10am") are used for that request and never saved. For time, only "never before" is lasting; "not before 10" is the request's own time (a bare one answers "when?").
- View / forget by chat: "what do you remember about me?" → the user's facts, each labelled "you told me", "I worked out, you kept it" (inferred + confirmed) or "I worked out — say yes to keep it" (still waiting); a preferred provider is named, not shown by id (one `get_provider` through the gateway, B22); "forget my area" → the record becomes `forgotten`; "forget everything (you know about me)" / "forget all my preferences" / "forget me" → `memory_forget` key `all`: every active fact is forgotten and every waiting one rejected (both leave the re-inference marker), and the reply names what went ("Forgotten: area, earliest time, preferred electrician."). Phase and facts of the conversation are untouched by both.

## Inferred facts (U33)

- **Detection** happens when a book request starts, only for a detail the request and active memory leave open, and proposes **at most one value per request** in this order (`proposeFromHistory`, one `list_bookings` call shared by all three):
  1. **`preferred_provider`** — the same provider for the request's service in **2 completed bookings**, or a one-off use via "the same electrician as last time" (`sameAsLast` on the read).
  2. **`area`** (`proposeArea`) — the same area in **2 completed bookings** of any service, most recent first. Ask: "Your last two bookings were in Jayanagar — use Jayanagar again?"
  3. **`earliest_time`** (`proposeEarliestTime`) — the same "not before X" the **user gave** (`time_window.source = user`) in **2 finished (`done`) book workflows** — our own records, since `list_bookings` has no time-preference field. Skipped when the request's window ends before X. Ask: "Your last two bookings were not before 10:00 — keep that as your earliest time?"
  
  Area and earliest time were added after a design-vs-code review found only the provider was inferred.

  For every kind: the user's own history only (structured data, never free text). `memory.inferCandidate` creates the fact as `awaiting_confirmation` with evidence naming the bookings ("electrical work bookings with Namma Wires & Lights on 2026-10-30 and 2026-10-25"); a forgotten value (`blockedByForget`) is never inferred again; an already active fact for the key makes the proposal pointless; a repeated proposal changes nothing.
- **The ask** rides on the request's reply — "Your last two electrical work bookings were with Namma X — keep them coming?" (from "same as last time": "Your last electrical work booking was with Namma X — keep them coming?") — stored as the workflow's `pending_question` `{type: "memory_confirm", factId, key, value, service, label}` (R9 priority 3; never stacked inside a card or a switch ask — the code only asks when both are absent). The reply also carries a **`memory_confirm` card** drawn from that fact (`factId, key, label, ask`), with Keep / Don't keep.
- **Bound to the card, like an approval (R2 pattern).** Keep / Don't keep and a typed yes / no carry the card's `memoryFactId`; `answerMemoryCard` decides only when that id is the workflow's waiting question **and** the fact is still `awaiting_confirmation`. Another card's id → "That suggestion is no longer open — nothing changed."; a fact already answered in the memory panel → the question is cleared and "You already answered that in your memory panel — nothing changed here." (`MEMORY_CONFIRM_STALE`). Before this, a chat yes after a panel Reject still applied the rejected value (B18). A yes with no id (text-only client) answers the waiting memory question, as before.
- **Yes** (`decideMemoryConfirm`) → `active` (+ `confirmed_at`; `source` stays `inferred`), **used immediately**: an area fact fills the workflow and the flow advances; an earliest time bounds the request's window and keeps its days (then the search re-runs); a provider narrows the options on screen to just their slots ("Saved your choice: X. Here are their times…"). **No** → the fact is `forgotten` and the value blocked from re-inference.
- **While an area / time ask waits**, the collecting question doesn't ask for that same detail again. If the user names the detail instead ("in HSR Layout"), their value wins, the ask is dropped and the inferred fact stays unconfirmed — a later "yes" can't swap it in.
- **While awaiting, the fact is never used (I-7):** the search filter and R6 fill read only `status = 'active'` records. The runner checks that every `source = memory` workflow fact points at an active store row (I-6 covers forgotten, I-7 covers not-yet-confirmed).
- **Active preferred providers narrow the search** (`advance`'s searching step): the searched providers are filtered to the saved one, with a "Using your saved choice: X." note; when they have no free slot the reply says so instead of silently widening.

## The memory endpoints (U34 server side)

`GET /api/memory`, `PUT /api/memory/:id`, `POST /api/memory/:id/confirm`, `POST /api/memory/:id/reject`, `DELETE /api/memory/:id` — all guarded by the auth session (401 unauthenticated; 404 for another user's fact, V-7), served through `memory.byId` bound to the signed-in user. PUT validates the value per key (area enum, `HH:MM`, provider id) else 400, and corrects in place, so `source` becomes `stated` — also for an inferred fact (`saveStated` sets `source = 'stated'` on conflict; bug B9). confirm/reject act only on `awaiting_confirmation` facts; DELETE forgets and keeps the row as the re-inference marker. The actions change memory directly — they are not runs. Integration tests: `memory/memory.routes.test.ts` (supertest against the real app and real db).

## How facts are used

- **At workflow start** the missing facts are filled from the user's active memory (`source = memory`, `memoryFactId` on the fact), and the reply carries one line per fill: "Using your saved area: HSR Layout (say if that's changed)." A detail the user gave in the same message is never overwritten. The saved earliest time is a time of day, so it also bounds a request that named only days ("this week" → this week, not before 10:00) — unless the request gave its own earliest time, or its window ends before the saved time. Forgetting it later keeps the request's days and drops only that bound (R6).
- **R6 — re-checked at every run start** (`syncMemoryFacts`): outside `executing` / `verifying`, each memory-sourced fact is compared against its store row. Forgotten → the fact is dropped (and asked again if required; built-on state clears per 2.5.2 rule 2). Corrected → the fact takes the new value, same cascade. A correction said as a lasting statement ("my area is Koramangala now") also corrects the open workflow's detail through the normal `applyToWorkflow` path, so phases stay code-derived.
- **V-11 — request differs from a preference:** the user's area wins **for this request**; the reply adds one light note ("…your saved area stays HSR Layout — 'update my area' if you've moved") and memory is written only by an explicit statement. A user-given fact (`source = user`) is never touched by any memory change or forget.

## Trace

`memory_event` rows: `used` (fill or R6 correction), `forgotten`, `stated` / `corrected` (via the repo's trace callback). `fact_changed` records the value change on the workflow with the honest source (`user` / `memory`).

## Invariants

- **I-6 (U32):** no workflow may still draw a detail from a memory fact marked `forgotten` — checked by the eval runner after every step (memory half of I-8, "no memory change from tool output", lands in U33).

## Evals

- **16** — state area → new conversation uses it with the note → correct → forget → never filled again.
- **19** — saved area HSR, booking in Jayanagar → Jayanagar used for that request only, note shown, memory unchanged (V-11).

## The client panel (U34, FR-12)

- `components/MemoryPanel.tsx` — rendered in the chat sidebar under the conversation list. Each fact shows its display value (area name, "not before 10:00", provider id), the source label ("you told me" / "I worked out"), the evidence line for inferred facts, and its actions:
  - **Edit** → an inline input + Save (`useEditMemory` → `PUT`); the panel's labels are presentational, the server re-validates the value.
  - **Confirm / Reject** for `awaiting_confirmation` facts (`POST` confirm/reject).
  - **Forget** for active ones (`DELETE`; the row stays as the re-inference marker).
- Data flows through `shared/api-client.ts` (`api.memory*`) + `shared/queries.ts` (`useMemory` with staleness 5 s; every mutation invalidates `["memory"]` **and** `["conversation"]` so an open workflow learns the change at its next run (R6)). Every chat reply and approval decision also invalidates `["memory"]` (`refreshConversation`): a chat message can save or forget a fact, and before this the panel only caught up on refocus (bug B8).
- The panel is disabled while any send, decision or memory mutation is pending (2.3).
