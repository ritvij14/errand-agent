# Memory & preferences (MH-6)

> Status: stated memory live (U32). Inferred memory (U33), the memory panel and its API (U34) come next.

## What exists

- `memory_fact` table (`migrations/008_memory.sql`) — `id, user_id, key, service, value, source ('stated'|'inferred'), status ('active'|'awaiting_confirmation'|'forgotten'), evidence, created_at, updated_at, confirmed_at, forgotten_at`. STRICT; a forgotten row is kept as a hidden marker (key + value) that blocks re-**inference** of the same value.
- `server/src/memory` — the only code that touches the table. `state` (active fact for a key), `view` (active + awaiting), `saveStated` (insert, or correct in place — including re-stating a forgotten fact, which is the user's choice), `forget`, `blockedByForget` (the marker U33 must respect).

## How facts get in (U32)

- Only **explicit, lasting statements** from the user's chat: "I live in HSR", "my area is Koramangala now", "never before 10am". The scripted model reads these as `memory_save` (key `area` / `earliest_time`) — checked before the normal workflow read, so a one-off "plumber in HSR" still reads as a booking request and is never saved.
- View / forget by chat: "what do you remember about me?" → the user's facts, each labelled ("you told me" / "I worked out"); "forget my area" → the record becomes `forgotten`. Phase and facts of the conversation are untouched by both.
- Inferred facts (same value across 2 completed bookings) are U33; the panel and its endpoints are U34.

## How facts are used

- **At workflow start** the missing facts are filled from the user's active memory (`source = memory`, `memoryFactId` on the fact), and the reply carries one line per fill: "Using your saved area: HSR Layout (say if that's changed)." A detail the user gave in the same message is never overwritten.
- **R6 — re-checked at every run start** (`syncMemoryFacts`): outside `executing` / `verifying`, each memory-sourced fact is compared against its store row. Forgotten → the fact is dropped (and asked again if required; built-on state clears per 2.5.2 rule 2). Corrected → the fact takes the new value, same cascade. A correction said as a lasting statement ("my area is Koramangala now") also corrects the open workflow's detail through the normal `applyToWorkflow` path, so phases stay code-derived.
- **V-11 — request differs from a preference:** the user's area wins **for this request**; the reply adds one light note ("…your saved area stays HSR Layout — 'update my area' if you've moved") and memory is written only by an explicit statement. A user-given fact (`source = user`) is never touched by any memory change or forget.

## Trace

`memory_event` rows: `used` (fill or R6 correction), `forgotten`, `stated` / `corrected` (via the repo's trace callback). `fact_changed` records the value change on the workflow with the honest source (`user` / `memory`).

## Invariants

- **I-6 (U32):** no workflow may still draw a detail from a memory fact marked `forgotten` — checked by the eval runner after every step (memory half of I-8, "no memory change from tool output", lands in U33).

## Evals

- **16** — state area → new conversation uses it with the note → correct → forget → never filled again.
- **19** — saved area HSR, booking in Jayanagar → Jayanagar used for that request only, note shown, memory unchanged (V-11).
