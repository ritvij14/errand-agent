# errand-agent build plan

Build the graded assignment in 40 small units. Each unit is one commit that ends in a state anyone can check.
The plan covers `docs/problem-statement.md` (the brief), `docs/system-design.md` (Level 1, binding) and the open findings in `docs/system-design-review-1.md` (R1–R12).
Run it with the `build-plan` skill. QA on the running app uses the `verify` skill.

## How to read this

- One `###` section is one unit. Units are listed in execution order. **Depends on** names the units that must be done first.
- **Covers** names the design sections, brief items (MH / FR / NFR / V) and review findings (R) the unit proves.
- **Tests** are written first and seen failing (red), then made to pass (green). They assert behavior a caller can observe, never internals.
- **Evals** are scenario numbers from `docs/system-design.md` § 2.5.10. From U13 on, a unit that lists evals adds them to the eval runner as part of its red step. The eval suite grows with the build instead of arriving at the end.
- **QA** is how the unit is proven on the real surface. Tests alone are not verification. A unit with no runtime surface says so, and its tests are the proof.
- **You see** is the one observable result that tells you the unit works.
- Tick a unit's box only when its evidence exists: commit sha, test files, eval rows, and the `/tmp/verify-<unit>/` artifacts.

## Rules for every unit

1. **TDD.** Tests first, red for the intended reason, then the smallest change that turns them green.
2. **KISS, YAGNI, DRY.** Build only what the unit's Covers line demands. No speculative options. One rule lives in one place.
3. **Regression gate before commit.** `npm test` (server Vitest, client Vitest once U14 lands, then evals once U13 lands), `npm run lint`, `npm run typecheck -w server` and `-w client`. All green.
4. **QA.** Server units drive the running API per the `verify` skill and save curl transcripts to `/tmp/verify-<unit>/`. Client units add React Testing Library tests plus an API drive. The manual browser click-through is deferred to U40 (operator decision, 2026-11-02).
5. **Docs.** Create or update the unit's feature doc in `docs/features/` and its status in `AGENTS.md` § 7. Update `docs/system-design.md`, `docs/infra/schema.md` or `docs/infra/api-contracts.md` when a decision is taken. Add a `.pi/skills/verify/features/` page when a user-facing feature lands.
6. **Real bugs.** Any real bug hit during a unit goes into `docs/bugs.md` the moment it is fixed: what broke, why, the fix, the regression test. Deliverable 4 is picked from this log, never invented later.
7. **Commit.** One conventional commit per unit (`feat:`, `fix:`, `docs:`, `chore:`). Then tick the box with the evidence.

## Phase 0. Baseline and design corrections

### U01 Prove the baseline harness

- [x] Done. Evidence: gate green (install, test 4/4, lint, both typechecks — `typecheck` script added to `client/package.json` — build), doctor steps 1–2: `:3001/api/health` 200 `{"status":"ok"}`, `:5173/` 200; `/tmp/verify-U01/doctor.txt`. Verify-skill feature-map path fixed to `.pi/skills/verify/features/`.
- **Depends on.** None.
- **Covers.** Scaffold health; `verify` skill's first real run.
- **Build.** Run `npm install`, `npm test`, `npm run lint`, both typechecks, `npm run build`, `npm run dev`. Fix only what blocks a green baseline. Fix the stale `.agents/skills/verify/features/` path in `.pi/skills/verify/SKILL.md` to `.pi/skills/verify/features/`.
- **Tests.** Existing scaffold tests stay green.
- **QA.** Verify doctor steps 1–2: `GET /api/health` is 200 on :3001, and the page is 200 on :5173. Step 3 (sign-in) is not reachable yet; record that.
- **You see.** Every command above exits 0, and the doctor transcript is in `/tmp/verify-U01/`.
- **Docs.** None beyond the skill path fix.

### U02 Resolve the approval and booking review findings in the design docs

- [ ] Done. Evidence:
- **Depends on.** None.
- **Covers.** R1, R2, R3, R4, R5, R7.
- **Build.** Edit `docs/system-design.md` §§ 2.5.3, 2.5.5, 2.5.6, 2.5.4, plus `docs/infra/schema.md` and `docs/infra/api-contracts.md`, so that:
  - R1. Creating an operation needs an `approved` approval. Executing and retrying need a persisted operation linked to the approval it used, with a matching request. The gateway checks the second rule.
  - R2. A typed yes carries the id of the approval card the user was shown. Every message carries a client message id, and a resent id replays the stored reply without a new run.
  - R3. At most one in-flight operation per existing booking (database rule). Before cancel or reschedule executes, `list_bookings` re-checks the booking's provider, slot and status against the approval. A mismatch voids the approval.
  - R4. A written Reading on where a booking's price and area come from for cancel and reschedule approvals and searches. Default reading: `list_bookings` returns `price` and `area` as part of each booking record, stated openly as a reading of the fixed contract.
  - R5. Failure wording comes from the operation's checked status: confirmed absent, confirmed booked, or unknown ("don't book again yet"). Cap replies name the concrete next step.
  - R7. The provider side writes a booking and its idempotency result in one transaction. The same holds for cancel and reschedule. A re-hold's key change is one transaction that records the old key's final result.
- **Tests.** None (docs only).
- **QA.** A resolution table at the end of `docs/system-design-review-1.md`: each R points to the changed section and to the unit and test or eval that will prove it. `grep` shows "Nothing new was booked" is gone, and § 2.5.5 no longer requires `approved` at the gateway.
- **You see.** Every R1–R5 and R7 row in the resolution table has a section link and a proving unit.
- **Docs.** This unit is docs.

### U03 Resolve the remaining review findings and set up submission tracking

- [ ] Done. Evidence:
- **Depends on.** U02.
- **Covers.** R6, R8, R9, R10, R11, R12, review § 4, the demo knob gap.
- **Build.** Edit the design docs and `AGENTS.md` so that:
  - R6. Workflow facts loaded from memory keep the memory fact id. At each run start, outside `executing` and `verifying`, a forgotten fact is cleared and asked again, and a corrected fact is updated with its cascade. Facts the user gave in the conversation are never touched.
  - R8. Calendar time (slots, holds) and elapsed time (run deadline) are separate injected clocks. Awaited work is raced against the time left and re-checked after it returns.
  - R9. Decline goes back by intent: book and reschedule go to `choosing`, cancel ends the workflow. The workflow holds one explicit pending question (approval, task switch, inferred memory, or which booking). A time correction merges into the known window instead of replacing it.
  - R10. The cap scenarios split into three deterministic cases (model calls, tool calls, time). Retry exhaustion stays its own case. I-1 is scoped to agent-created bookings. Hold expiry before approval and after approval become two distinct scenario steps.
  - R11. Timestamps are milliseconds everywhere. `npm test` runs Vitest and then the evals. Artifact paths are `traces/<run id>.json` and `docs/evals/eval-table.md`.
  - R12 and § 4. Create `docs/bugs.md` (empty log with the four headings) and `docs/submission-checklist.md` (each of the 6 deliverables with its file path and acceptance check). Note in the design that the design note carries the 100× section.
  - Demo knob gap. A dev-only way to force the next tool outcome in the app, so the demo can show a timeout-after-success live (deliverables 5 and 6). It is off by default. Evals keep using their own forced-outcome queue.
- **Tests.** None (docs only).
- **QA.** The resolution table now covers all 12 findings. `AGENTS.md` § 2 and § 6 agree with the design on `npm test` and artifact storage.
- **You see.** `docs/bugs.md` and `docs/submission-checklist.md` exist, and the review's resolution table has no empty row.
- **Docs.** This unit is docs.

## Phase 1. Shared foundations

### U04 Clock, elapsed timer and seeded random

- [ ] Done. Evidence:
- **Depends on.** U01, U03.
- **Covers.** NFR-4, NFR-7, R8.
- **Build.** `server/src/shared`: a controllable IST calendar clock (set, advance), an injectable elapsed timer, and seeded random drawn from seed plus labelled inputs (seed + tool + inputs + attempt).
- **Tests.** Fixed now reads back. Advancing moves now. IST formatting and day boundaries. Same seed and inputs give the same draw. A different attempt number gives an independent draw.
- **QA.** No runtime surface. The tests are the proof.
- **You see.** `npm test` shows the clock and random suites green.
- **Docs.** Start `docs/features/agent-core.md` (shared section) or note in `docs/infra/patterns.md` how time and chance are injected.

### U05 SQLite, migrations runner and test database helper

- [ ] Done. Evidence:
- **Depends on.** U01, U03.
- **Covers.** ADR-003, § 2.5.12, R11 (milliseconds).
- **Build.** `server/src/shared` database module. Numbered SQL files in `server/migrations/`, a `schema_migration` table, migrations applied at server start. A helper that opens a fresh database file per test. UUID v4 ids.
- **Tests.** Migrations apply in order. A rerun is a no-op. Tables are STRICT. A fresh test database starts empty.
- **QA.** Start the dev server. Query `schema_migration` with `sqlite3`. Save the output.
- **You see.** The database file exists and lists the applied migrations.
- **Docs.** `docs/infra/schema.md` migration history.

## Phase 2. Mock provider API (the fixed contract)

### U06 Mock world seed and slot calculation

- [x] Done. Evidence: 10 tests red→green (`server/src/tools/mock-world.test.ts`, suite 30/30); QA `/tmp/verify-U06/seed-summary.txt` — 44 providers (roughly 40), 25/25 pairs in 3–8, 5 injection kinds, demo bookings with price+area. Commit `+ U06 sha`.
- **Depends on.** U04, U05.
- **Covers.** § 2.3, § 2.5.4 mock world data and free slots, NFR-4.
- **Build.** `server/src/tools` mock tables. 5 services, 5 areas, about 40 made-up Bengaluru-style providers, prices in range, ratings, attributes, 3–6 reviews each, the 5 hand-written injection reviews spread over providers, seeded past and upcoming bookings for fixed demo user ids. Free slots calculated from seed + provider + date.
- **Tests.** Every service and area pair has 3–8 providers. Prices sit in their service range. All 5 injection kinds exist. Slots for a provider and date repeat exactly. Past, held and booked slots are not free (controllable clock). 14-day window from now.
- **QA.** No API yet. A `sqlite3` count of providers per service and area pair, saved.
- **You see.** The seed summary shows 25 pairs, each with 3–8 providers.
- **Docs.** Start `docs/features/tool-mocks.md`.

### U07 Read tools: search_providers, get_provider, list_bookings

- [ ] Done. Evidence:
- **Depends on.** U06.
- **Covers.** Brief tool table rows 1–3, § 2.5.4, V-7 (provider side), R4 reading.
- **Build.** The three tools returning `{ ok, data }` per contract. `search_providers` has no reviews, keeps providers with empty slot lists, and enforces the 14-day range. `list_bookings` returns only that user's bookings, with statuses `booked`, `cancelled`, `completed`, and the R4 fields.
- **Tests.** Contract shapes. Range bounds. Reviews present in `get_provider` only. Another user's bookings are never returned. A past slot reports `completed`.
- **QA.** No runtime surface yet. The tests are the proof.
- **You see.** Read-tool suite green.
- **Docs.** `docs/features/tool-mocks.md`.

### U08 Write tools: hold_slot, book, get_booking_status, with forced outcomes

- [x] Done. Evidence: 13 write-tool tests red→green (suite 53/53). Key reds caught real bugs first: quoted-price-vs-search (probabilistic, so the test now pins range + some-differ), hold expiry measured from hold creation (clock pause test), the R7 fault-injection rollback, slot_taken really moves the slot to another user, key replay. Commit `+ U08 sha`.
- **Depends on.** U07.
- **Covers.** Brief tool table rows 4–6, § 2.5.4 randomness and settings, NFR-4, R7.
- **Build.** `hold_slot` (10-minute expiry on the clock, quoted price differs on about 20% of holds by up to ±15%, `slot_unavailable`). `book` (70 / 15 / 15 split, timeout with half actually booked, timeout pause on the clock, `hold_expired`, same key returns the same final result, timeouts not remembered). `get_booking_status` reads provider records. A forced-outcome queue per tool used before random draws. Booking plus key result written in one transaction.
- **Tests.** Each outcome through the forced queue. Same key never creates a second booking. `timeout_booked` creates the booking and still returns a timeout. Status reports `booked`, `not_found`, `failed` correctly. A fault injected between the two writes leaves neither (R7). Same seed and inputs give the same outcome.
- **QA.** No runtime surface yet. The tests are the proof.
- **You see.** Write-tool suite green, including the atomicity test.
- **Docs.** `docs/features/tool-mocks.md`.

### U09 Write tools: cancel and reschedule

- [x] Done. Evidence: 9 cancel/reschedule tests red→green (suite 62/62, both typechecks + lint). V-8 503-retry, replay-after-success, user isolation, price kept + old slot freed, seeded + non-free slot_conflict remembered per key, R7 fault-injection on both writes.
- **Depends on.** U08.
- **Covers.** Brief tool table rows 7–8, V-8, V-9 (provider side), R7.
- **Build.** `cancel` fails with 503 on the first call per booking, then succeeds. The same key after success returns `cancelled`. Another user's booking returns `not_found`. `reschedule` keeps the price, frees the old slot, and returns `slot_conflict` on configured slots (about 10% by seed) and on slots that are not free. Each write is one transaction.
- **Tests.** One test per behavior above, plus a forced-outcome override for each.
- **QA.** No runtime surface yet. The tests are the proof.
- **You see.** All 8 tools have green suites.
- **Docs.** `docs/features/tool-mocks.md` complete for the contract.

## Phase 3. Walking skeleton

### U10 Auth API, error catalogue and demo users

- [x] Done. Evidence: 13 auth integration tests red→green (`server/src/auth.test.ts`; suite 73/73, lint + typecheck clean). QA `/tmp/verify-U10/doctor.txt`: doctor step 3 passes — sign-in 200 with session cookie, me works, CSRF 403, WRONG_PASSWORD/NO_SUCH_USERNAME codes, alice/bob/charlie seeded beside the 44-provider mock world.
- **Depends on.** U05.
- **Covers.** FR-1, § 2.5.1, § 2.5.3 HTTP error catalogue, ADR-005.
- **Build.** `server/src/auth`: sign-up, sign-in, sign-out, me. Argon2id via `crypto.argon2`. Token `<id>.<secret>` with the hashed secret stored. 10-day sliding auth sessions. Cookie flags. CSRF check (`Sec-Fetch-Site` plus parsed JSON). Per-username token bucket. 2–3 demo users seeded on first start with the ids U06 uses. `server/src/shared` error catalogue and error middleware returning `{ error, code, details }`.
- **Tests.** Integration per endpoint: happy path, field-level validation, wrong password, unknown username, taken username, CSRF rejected, rate limited, expired session, `me` without a cookie. The session secret is never stored in plain text.
- **QA.** Verify doctor step 3 now passes. Curl sign-up, sign-in, me, sign-out, and one CSRF-rejected call.
- **You see.** Sign-in returns 200 with a `session` cookie. A POST without `Sec-Fetch-Site` returns 403 `CSRF_REJECTED`.
- **Docs.** Start `docs/features/auth.md`. Update `docs/infra/api-contracts.md` if anything drifted.

### U11 Traces core

- [x] Done. Evidence: 5 trace tests red→green (`server/src/tracing/tracing.test.ts`; suite 78/78). Allow-list per type (secrets dropped by construction), clock_at vs duration_ms (R8 story), model-call tokens/cost null + not_available. Migration `003_trace_events.sql`. Commit `+ U11 sha`.
- **Depends on.** U04, U05.
- **Covers.** MH-7, § 2.5.9 shape, event allow-list, no secrets.
- **Build.** `server/src/tracing`: record events for a run with `seq`, `type`, `clock_at`, `duration_ms` and only each type's listed fields. Read a run's events in order. Tokens and cost recorded as null with `not_available`.
- **Tests.** Events read back in order. Fields outside the allow-list are dropped. `clock_at` follows the calendar clock while `duration_ms` follows the elapsed timer.
- **QA.** No runtime surface yet. The tests are the proof.
- **You see.** Trace suite green.
- **Docs.** Start `docs/features/traces.md`.

### U12 Conversation runner skeleton and conversations API

- [x] Done. Evidence: 8 conversation tests red→green (`server/src/conversations.test.ts`; suite 84/84, lint+tsc clean). QA `/tmp/verify-U12/drive.txt`: sign-in → create conversation → help reply → trace (run_started, model_call ×2, run_ended) → clientMessageId replay without a new run → 401/404/VALIDATION_ERROR. Module map in docs/features/conversations.md.
- **Depends on.** U10, U11.
- **Covers.** § 2.4 main flow, § 2.5.3 steps of one run, FR-14 (skeleton), R2 (client message ids).
- **Build.** Rename `server/src/chat` to `server/src/conversations` and delete the scaffold echo route and its test. Conversations: create, list, read, send message. A run row per message with trigger, outcome and call counters. Busy marker returning `CONVERSATION_BUSY`. A model slot with the scripted model's first reply, the `NOT_UNDERSTOOD` help text. Runs trace `run_started`, `model_call`, `run_ended`. `GET /api/runs/:id/trace`. A repeated client message id replays the stored reply.
- **Tests.** Integration over a real database: create and list own conversations only, another user's conversation returns `NOT_FOUND`, an empty message returns `VALIDATION_ERROR`, a second message during a run returns `CONVERSATION_BUSY`, every run ends with an outcome and a non-empty reply, a resent client message id creates no new run.
- **QA.** Sign in, create a conversation, send "hello", read the reply, fetch its trace. Save the transcript.
- **You see.** The reply lists what the agent can do, and the trace shows `run_started` → `model_call` ×2 → `run_ended`.
- **Docs.** Start `docs/features/conversations.md`. `AGENTS.md` § 3 drops the "still `server/chat`" note.

### U13 Eval runner skeleton and eval table

- [x] Done. Evidence: 3 runner tests red→green (`server/src/evals/runner.test.ts`; suite 86/86). Root `npm test` = Vitest then evals (`npm run evals`); `docs/evals/eval-table.md` regenerated with date, commit, seed; E0 pass. Invariants I-4, I-5, I-9 checked after every step.
- **Depends on.** U09, U12.
- **Covers.** MH-8, § 2.5.10 how a scenario runs, eval table, R11 (`npm test` runs evals).
- **Build.** `server/src/evals`: scenario steps `say`, `click`, `advance`, `restart`, `send_concurrently`, `expect`. A fresh database, fixed seed and fixed clocks per scenario. Forced outcomes queued into the mock. Invariants checked after every step, starting with I-4, I-5 and I-9. The table goes to the terminal and `docs/evals/eval-table.md` with run date, commit and seed. `npm run evals`. Root `npm test` runs Vitest and then evals, and fails if either fails.
- **Tests.** Runner tests: a deliberately failing scenario makes the run exit non-zero, and a broken invariant is reported with its id. Scenario E0: "hello" gets a help reply with outcome `completed`.
- **QA.** Run `npm test` from the root and see both stages. The table file is regenerated.
- **You see.** `docs/evals/eval-table.md` shows E0 as pass.
- **Docs.** Start `docs/features/eval-suite.md`.

### U14 Client skeleton: sign-in, conversations, plain chat

- [x] Done. Evidence: 4 RTL tests green (2 SignIn field-error/submission/pending, fetch-boundary structural check); root `npm test` = server Vitest → evals → client. QA `/tmp/verify-U14/proxy.txt`: page 200, `/api` proxied through :5173, client build clean.
- **Depends on.** U12.
- **Covers.** FR-1 (page), § 2.4 chat page, AGENTS.md client rules.
- **Build.** Add Vitest and React Testing Library to `client`. One API client module that sends the CSRF headers. TanStack Query hooks. Sign-in and sign-up screens with inline field errors, a conversation list with a new-conversation button, and a chat view with text messages. Send is disabled while a reply is pending. Root `npm test` includes client tests.
- **Tests.** RTL: field errors render from server `details`. Send is disabled while pending. Messages render in order. Components never call `fetch` directly.
- **QA.** Curl the same endpoints through Vite (`:5173/api/...`) to prove the proxy path. `npm run build -w client` passes.
- **You see.** Client tests run inside root `npm test`.
- **Docs.** Start `docs/features/web-frontend.md`.

### U15 Tool gateway

- [x] Done. Evidence: 8 gateway tests red→green (`server/src/tools/tool-gateway.test.ts`; suite 94/94, lint+tsc clean). Cornerstone test: `book` refused `UNAUTHORIZED_WRITE` even with a live hold. QA: no HTTP surface yet — the gateway suite is the proof.
- **Depends on.** U09, U11.
- **Covers.** § 2.5.4 tool gateway, § 2.5.7 rules 5, 7 and 8 and the warning label, V-7, R1 (fail closed).
- **Build.** `server/src/tools` gateway with the 8 methods bound to the signed-in user. One attempt per call. Counts against the run's tool budget. Records a `tool_call` trace event. Checks result shape, so a bad shape becomes `PROVIDER_BAD_RESPONSE`. Wraps provider strings as untrusted and flags suspected injection. `book`, `cancel` and `reschedule` fail closed until U21 adds the execution check.
- **Tests.** `list_bookings` always gets the bound user's id. A malformed mock result becomes `PROVIDER_BAD_RESPONSE`. Every call writes one trace event. A call over the budget is not made. Write tools are refused (the cornerstone MH-2 test that stays forever). Review text is cut to 500 characters and flagged.
- **QA.** No HTTP surface yet. The tests are the proof.
- **You see.** Gateway suite green, including "write tool without authorization is refused".
- **Docs.** `docs/features/tool-mocks.md` gateway section.

## Phase 4. Booking path (MH-1, MH-2, MH-3, MH-5)

### U16 Time-window parser

- [x] Done. Evidence: 17 parser tests red→green (`server/src/agent/time-window.test.ts`; suite 111/111 + E0). Table rows per V-6; "this week" = today→this Sunday (§2.3); partial merge per R9 (bounds-only keeps dates, dates keep bounds); past phrases → TIME_OUT_OF_RANGE.
- **Depends on.** U04.
- **Covers.** V-6, NFR-7, R9 (partial time merge).
- **Build.** chrono-node 2 on the calendar clock's now in IST, plus our rules for "this week", "mornings only", "not before 10 a.m.", "between 9 and 11am", "Saturday". A merge function that applies a partial correction ("after 11") to a known window. `TIME_OUT_OF_RANGE` for past or beyond 14 days.
- **Tests.** Table-driven with a fixed now, one row per phrase above, plus merge rows and out-of-range rows.
- **QA.** No runtime surface. The tests are the proof.
- **You see.** Parser table green.
- **Docs.** `docs/features/agent-core.md` parser section.

### U17 Collect details: ask only what is missing

- [x] Done. Evidence: 18 new tests (V-1 phrase table `agent/model-v1.test.ts`, collecting/cascade/version/trace `agent/workflow.test.ts`; suite 130/130). Eval 2 passes (table 2/2). QA `/tmp/verify-U17/drive.txt`: "I need a plumber" → one question for area and time → answer → `searching`, budget never asked. Migration `005_workflow.sql`.
- **Depends on.** U13, U16.
- **Covers.** MH-1, FR-7, FR-8, § 2.5.2 rules 1–2, V-1, R9.
- **Build.** Workflow record with facts, version check and pending question. Scripted model reading intent, service, area, budget, `any`, preferences and corrections. The `collecting` phase asks once for every missing required detail. A correction overwrites one fact and clears only what was built from it. `UNKNOWN_SERVICE`, `UNKNOWN_AREA`, `TIME_OUT_OF_RANGE` replies. `fact_changed` and `state_transition` trace events.
- **Tests.** Model phrase table (V-1). State machine: a known fact is never asked again, `any` counts as known, a correction keeps other facts, a stale version save is rejected.
- **Evals.** 2.
- **QA.** API drive: "I need a plumber" → asked area and time in one question → answer both → no re-ask.
- **You see.** Eval 2 passes, and the trace shows `collecting` with the facts filling in.
- **Docs.** `docs/features/agent-core.md`.

### U18 Search and option blocks

- [x] Done. Evidence: `agent/options.test.ts` (6 unit), `agent/search.flow.test.ts` (6 flow), regression tests for B1–B3 (`docs/bugs.md`); suite 144/144, evals 3/3. QA `/tmp/verify-U18/drive.txt` on the real clock: full request → 3 numbered blocks (≤₹1,500, mornings, from tomorrow), ₹100 → `NO_MATCHES` naming the budget and the cheapest price, ₹2,000 → re-search with 4 blocks; one `search_providers` tool call per run in the trace.
- **Depends on.** U15, U17.
- **Covers.** FR-9, § 2.5.2 `searching` and `choosing`, rule 2 cascade, `NO_MATCHES`.
- **Build.** `searching` calls `search_providers` through the gateway. Filter by budget, time window and preferences. Option blocks part grouped by provider, providers ordered by earliest slot (numbers/letters later dropped by ADR-007). `NO_MATCHES` names the filter that removed everything. A correction after options redoes the search.
- **Tests.** Grouping and ordering. Budget filter. `NO_MATCHES` names the right filter. Correcting the budget keeps service, area and time.
- **Evals.** 3.
- **QA.** API drive: "plumber in HSR Layout this week, mornings only, under ₹1,500" returns an option-blocks part.
- **You see.** Eval 3 passes, and the reply carries numbered provider blocks.
- **Docs.** `docs/features/agent-core.md`, `docs/infra/api-contracts.md` parts if changed.

### U19 Pick, hold and the approval card

- [ ] Done. Evidence:
- **Depends on.** U18.
- **Covers.** FR-9 picking, FR-10 (card), § 2.5.5 approval record and creation, V-2.
- **Build.** A pick is a normal message (ADR-007): provider name plus day and time, matched against the shown candidates. Options carry every matching slot, no numbers or letters. "the second one" alone asks which, and with no list it is `NOTHING_TO_PICK`. `holding` calls `hold_slot`, and `slot_unavailable` goes back to `choosing`. `server/src/approval` creates a `pending` record from state, never from model text. The approval-card part is drawn from the record and shows the quoted price.
- **Tests.** Pick parsing. Hold failure goes back to options. The card's fields equal the record's fields. The card shows the quoted price when it differs from the search price.
- **Evals.** 5.
- **QA.** API drive through a pick to a card. Compare the card part with the approval row in `sqlite3`.
- **You see.** Eval 5 passes, and the card price equals the hold's quoted price.
- **Docs.** Start `docs/features/approval-gate.md`.

### U20 Approval decisions

- [ ] Done. Evidence:
- **Depends on.** U19.
- **Covers.** MH-2, FR-10, § 2.5.5 typed-yes rules and life of an approval, R2, R9 (decline by intent, pending question).
- **Build.** `POST /api/approvals/:id/decision` (button). Typed plain yes answers only the card id the message carries. "Yes but 11am" voids and applies the change. Decline in a book flow goes back to `choosing` with facts kept. Voiding on provider, slot or price change, correction or task switch. A pending approval older than 10 minutes becomes `APPROVAL_STALE` with fresh details. `approval_event` trace events. Nothing executes yet; an approved book waits for U21.
- **Tests.** Each life step and void reason. A yes carrying an old card id does not approve the new card (R2). Another user's approval returns `NOT_FOUND`. Expiry on the advanced clock.
- **QA.** API drive: approve by button, then a second flow approves by typed yes. Read both approval rows back.
- **You see.** The approval row moves `pending` → `approved`, with `decided_via` set correctly.
- **Docs.** `docs/features/approval-gate.md`.

### U21 Execute a booking and verify it

- [ ] Done. Evidence:
- **Depends on.** U20.
- **Covers.** MH-2 (gateway check), MH-3, FR-11, § 2.5.6 operation record and keys, R1.
- **Build.** `server/src/booking` operations table. One transaction marks the approval used, creates the operation (`in_flight`, key `<op id>:1`) and moves the workflow to `executing`. The gateway executes `book` only for a persisted operation linked to its used approval with a matching request (R1). A successful `book` is always confirmed with `get_booking_status` before the reply says booked. Eval invariants I-1 (agent-created bookings only), I-2 and I-3 switch on.
- **Tests.** The gateway refuses `book` without an operation, with a mismatched request, and with an approval that was never used. A second operation for the same approval is refused by the database. A booked reply only follows a `booked` status.
- **Evals.** 1.
- **QA.** API drive of the full happy path. `list_bookings` through a test helper, or `sqlite3` on the `mock_` table, shows exactly one booking.
- **You see.** Eval 1 passes: booked, verified, reported once.
- **Docs.** Start `docs/features/booking-lifecycle.md`. Update `approval-gate.md` with the R1 rule.

### U22 Booking failure paths

- [ ] Done. Evidence:
- **Depends on.** U21.
- **Covers.** MH-3, NFR-2, NFR-3, V-4, R7 (key change).
- **Build.** Timeout → status `booked` → succeeded. Timeout → `not_found` → wait 0.5 s then 1 s on the clock → retry with the same key, up to 3 attempts. `slot_taken` → back to options. `hold_expired` → re-hold: the same price keeps the approval with key `:2`, a new price voids it, and a gone slot goes back to options. The key change is one transaction. Retry exhaustion gives a truthful reply from the checked status.
- **Tests.** One per row of the § 2.5.6 decision table using forced outcomes.
- **Evals.** 6, 7, 8, 9, 10, 11.
- **QA.** The eval rows prove the forced failures, because the app's demo knob only arrives in U37. Add one dev-server happy-path drive.
- **You see.** Evals 6–11 pass, and the eval-9 trace shows `book → timeout` then `get_booking_status → booked`.
- **Docs.** `docs/features/booking-lifecycle.md`.

### U23 Repeated yes and concurrent messages

- [ ] Done. Evidence:
- **Depends on.** U22.
- **Covers.** MH-3 (repeated yes), § 2.3 overlapping messages, § 2.5.6 repeated yes, R2.
- **Build.** A yes or click on a used approval reports the operation's status (`APPROVAL_ALREADY_USED`) and makes no call. `send_concurrently` gets `CONVERSATION_BUSY`. A resent client message id replays the stored reply.
- **Tests.** Typed yes ×2 plus a click gives one `book` call. A concurrent request is refused, not queued.
- **Evals.** 13, 14.
- **QA.** API drive: two parallel curl requests to the same conversation. One gets 409.
- **You see.** Evals 13–14 pass, with exactly one provider booking.
- **Docs.** `docs/features/booking-lifecycle.md`, `docs/features/conversations.md`.

### U24 Restart recovery

- [ ] Done. Evidence:
- **Depends on.** U22, U13.
- **Covers.** MH-3 restarts, NFR-5, § 2.5.2 rule 5, § 2.5.6 restart recovery, R7.
- **Build.** At server start, every `in_flight` operation gets its own `recovery` run with its own trace, caps and user-bound client. The same check runs at the start of any run in that conversation. `book`: status first, resume only while the hold is valid. The outcome is appended as an agent message.
- **Tests.** A fault injected after the provider commits but before the operation is saved recovers to exactly one booking (R7). The three recovery variants.
- **Evals.** 20 (all three variants).
- **QA.** Dev server: force an in-flight operation, kill the server, start it, read the conversation. Save the transcript.
- **You see.** After restart the chat shows "Your booking went through: id X", and there is one booking.
- **Docs.** `docs/features/booking-lifecycle.md`.

### U25 Caps and truthful endings

- [ ] Done. Evidence:
- **Depends on.** U23, U24.
- **Covers.** MH-5, NFR-1, FR-14, § 2.5.3 caps and endings, V-5, R5, R8, R10.
- **Build.** Caps checked before every model call, tool call and wait: 6 / 10 / 60 s. The deadline uses the elapsed timer, and awaited work is raced against the time left (R8). Every ending is recorded with its reply. Wording comes from the operation's checked status (R5). `unknown_error` keeps details in the trace only. `limit_hit` trace events.
- **Tests.** A real delayed operation (a short test cap with a slow stub) stops at the deadline. Unknown-error wording for absent, booked and unknown operations. The longest normal path fits inside the caps (V-5).
- **Evals.** 21 split into 21a model-call cap, 21b tool-call cap, 21c time cap, and 21d retries exhausted (R10).
- **QA.** Eval rows plus one dev-server drive of a capped run read back from its trace.
- **You see.** Each cap scenario ends with its own outcome code and a clear message.
- **Docs.** `docs/features/conversations.md`, `docs/system-design.md` V-5 result.

### U26 Chat page booking UI

- [ ] Done. Evidence:
- **Depends on.** U14, U21.
- **Covers.** FR-9 page, FR-10 page, § 2.4 chat page.
- **Build.** Option blocks as accordions with slot buttons; tap selects, Confirm auto-sends "Book {provider} on {day} at {time}" as a chat message (ADR-007). An approval card drawn from the part with Approve and Decline. Approve and Send are disabled while a reply is pending. The typed yes carries the shown card id.
- **Tests.** RTL: accordion open and close, tap + Confirm sends the exact pick message, Confirm disabled until a slot is tapped, card shows the part's provider, slot and price, buttons disabled while pending.
- **QA.** `npm run build -w client`. API drive of the same path through `:5173/api`.
- **You see.** Client tests green for blocks and cards.
- **Docs.** `docs/features/web-frontend.md`, `.pi/skills/verify/features/booking.md`.

## Phase 5. Other intents and untrusted output

### U27 List my bookings and user isolation

- [ ] Done. Evidence:
- **Depends on.** U15, U17.
- **Covers.** FR-5, V-7, I-10.
- **Build.** "Show my bookings" intent returning a bookings-list part through the bound gateway. Naming another user changes nothing.
- **Tests.** Integration: user A cannot see or cancel user B's booking (`not_found`).
- **Evals.** 23. I-10 switches on.
- **QA.** API drive as two demo users.
- **You see.** Eval 23 passes.
- **Docs.** `docs/features/agent-core.md`.

### U28 Cancel flow

- [ ] Done. Evidence:
- **Depends on.** U27, U22.
- **Covers.** FR-4, V-8, R3, R4, R9 (decline ends the cancel).
- **Build.** `identifying_booking` with `BOOKING_NOT_FOUND` and `BOOKING_AMBIGUOUS`. An approval card with the booking's price. Re-check the booking with `list_bookings` before execute (R3). At most one in-flight operation per booking. The 503 retry uses the same key. If the outcome is unclear, check `list_bookings`.
- **Tests.** Booking changed since approval: the approval is voided and no cancel call is made. Two conversations cannot both cancel the same booking. Decline ends the workflow with no call.
- **Evals.** 15, plus a new R3 scenario (cross-conversation change voids the old approval).
- **QA.** API drive cancelling a seeded upcoming booking.
- **You see.** Eval 15 passes, and the trace shows `cancel → 503` then `cancel → cancelled`.
- **Docs.** `docs/features/booking-lifecycle.md`.

### U29 Reschedule flow

- [ ] Done. Evidence:
- **Depends on.** U28.
- **Covers.** FR-3, V-3, V-9, R3, R4.
- **Build.** Identify the booking, collect the new time, search the booked provider only in the booking's area, then choose. The approval uses the booking's price. `slot_conflict` goes back to options without that slot. Re-check before execute.
- **Tests.** Only the booked provider's slots are offered. The approval shows the original price. A conflict removes the slot.
- **Evals.** 12.
- **QA.** API drive: "Move my AC servicing to Saturday" for a demo user.
- **You see.** Eval 12 passes, and the booking moves with its price unchanged.
- **Docs.** `docs/features/booking-lifecycle.md`.

### U30 Drop a request and switch tasks

- [ ] Done. Evidence:
- **Depends on.** U28.
- **Covers.** FR-15, FR-16, V-10, R9 (pending question).
- **Build.** "never mind", "stop", "forget it", "cancel that" → `abandoned`, "Okay, dropped. Nothing was booked." "cancel my AC servicing" → cancel flow. Unclear → ask. A new request mid-workflow asks before dropping, using the pending question. During `executing` the switch waits.
- **Tests.** Model phrase table for drop versus cancel. Task-switch yes and no. A correction in flight returns `CHANGE_REFUSED_IN_FLIGHT`.
- **Evals.** 22.
- **QA.** API drive of a drop and a task switch.
- **You see.** Eval 22 passes with no tool call on the drop.
- **Docs.** `docs/features/agent-core.md`.

### U31 Provider details and injection defence

- [ ] Done. Evidence:
- **Depends on.** U18, U26.
- **Covers.** MH-4, FR-6, § 2.5.7 rules 1–8, I-8.
- **Build.** "tell me about provider 2" and a Details link call `get_provider`. A provider-details part with reviews in a "Reviews (from the provider, not checked)" block and the warning label. The read step never sees reviews. Client renders reviews as plain text with the label.
- **Tests.** Each of the 5 injection kinds leaves intent, approvals and memory unchanged. RTL: the label renders and review text is not interpreted as HTML.
- **Evals.** 4. I-8 switches on.
- **QA.** API drive of a provider with an injection review. The trace shows `suspected_injection: true`.
- **You see.** Eval 4 passes, and no approval or memory row changed.
- **Docs.** `docs/features/agent-core.md`, `.pi/skills/verify/features/injection.md`.

## Phase 6. Memory (MH-6)

### U32 Stated memory: save, use, view, correct, forget

- [ ] Done. Evidence:
- **Depends on.** U18.
- **Covers.** MH-6, FR-12 (chat), § 2.5.8, V-11, R6.
- **Build.** `server/src/memory`. Stated facts only from explicit lasting statements. Active facts fill workflow facts with the memory fact id and a one-line note. A differing request applies to this request only, with a light note. Chat view, correct and forget. At run start, forgotten or corrected memory updates the workflow facts it supplied (R6).
- **Tests.** A one-off area is not saved. "I live in HSR" is saved as stated. Forget stops use in the next run of an open workflow. A user-given fact survives a forget.
- **Evals.** 16, 19. I-6 switches on.
- **QA.** API drive across two conversations of one user.
- **You see.** Evals 16 and 19 pass.
- **Docs.** Start `docs/features/memory-preferences.md`.

### U33 Inferred memory and confirmation

- [ ] Done. Evidence:
- **Depends on.** U32, U22.
- **Covers.** MH-6 inferred facts, V-12, I-7, R9 (pending question).
- **Build.** The same value in 2 completed bookings, or "same as last time", creates an `awaiting_confirmation` fact with evidence. The agent asks when it would be useful. Yes makes it active. No forgets it. A forgotten value is never inferred again.
- **Tests.** Not used before confirmation. Forget blocks re-inference. Evidence text names the bookings.
- **Evals.** 17, 18. I-7 switches on.
- **QA.** API drive with a demo user who has two past electrician bookings.
- **You see.** Evals 17 and 18 pass.
- **Docs.** `docs/features/memory-preferences.md`.

### U34 Memory API and memory panel

- [ ] Done. Evidence:
- **Depends on.** U33, U14.
- **Covers.** FR-12 (panel), `docs/infra/api-contracts.md` memory endpoints.
- **Build.** `GET /api/memory`, `PUT /api/memory/:id`, confirm, reject, `DELETE`, all calling the same memory code as chat. A memory panel with stated and inferred labels and edit, confirm and forget buttons.
- **Tests.** Integration per endpoint: happy path, validation, another user's fact returns `NOT_FOUND`. RTL: labels and buttons.
- **QA.** API drive of each endpoint, then a chat run proves the change took effect.
- **You see.** A fact forgotten in the panel is not used in the next chat run.
- **Docs.** `docs/features/memory-preferences.md`, `.pi/skills/verify/features/memory.md`.

## Phase 7. Trace panel and export

### U35 Trace panel and trace export

- [ ] Done. Evidence:
- **Depends on.** U26, U11.
- **Covers.** MH-7, FR-13, § 2.5.9 viewing and exporting, deliverable 5 tooling, I-9.
- **Build.** The trace panel loads the latest run after each reply, shows a timeline coloured by type, expands an event's fields, and switches runs via each reply's trace link. `npm run trace:export -- <run id>` writes `traces/<run id>.json`. The I-9 sweep covers HTTP flows as well as evals.
- **Tests.** RTL: timeline renders events in order and expands fields. Export writes the run's events and nothing else. Another user's trace returns `NOT_FOUND`. No password, token or cookie appears in any stored trace.
- **QA.** API drive plus an export of a real run, inspected with `jq`.
- **You see.** `traces/<run id>.json` exists and holds the full event list.
- **Docs.** `docs/features/traces.md`, `.pi/skills/verify/features/traces.md`.

## Phase 8. Gate and deliverables

### U36 Eval suite gate

- [ ] Done. Evidence:
- **Depends on.** U25, U29, U30, U31, U33, U35.
- **Covers.** MH-8, deliverable 3, R10.
- **Build.** Fill any gap so all 23 accepted scenarios plus the R3 and 21a–21d additions run. Invariants I-1 to I-10 are checked after every step. A coverage check fails the run if any of the brief's 8 must-cover categories has no scenario.
- **Tests.** The eval suite itself. A removed scenario category fails the coverage check.
- **QA.** Root `npm test` from a clean state. Commit the regenerated table.
- **You see.** `docs/evals/eval-table.md` shows every row passing, with date, commit and seed at the top.
- **Docs.** `docs/features/eval-suite.md`, `docs/submission-checklist.md` deliverable 3 ticked.

### U37 Demo readiness

- [ ] Done. Evidence:
- **Depends on.** U36.
- **Covers.** Deliverables 5 and 6 setup, § 2.3 reset command, the U03 demo knob.
- **Build.** `npm run reset` wipes and reseeds. The dev-only forced-outcome knob from U03. Produce a real timeout-after-success run in the dev app and export its raw trace to the path named in `docs/submission-checklist.md`. Complete the `verify` feature map.
- **Tests.** The knob is off unless set. Reset leaves a seeded world and demo users.
- **QA.** Dev-server drive of a timeout-after-success booking, then its export.
- **You see.** A committed raw trace file containing `book → timeout` followed by `get_booking_status → booked`.
- **Docs.** `docs/submission-checklist.md` deliverable 5 (raw file) ticked.

### U38 README and clean-clone check

- [ ] Done. Evidence:
- **Depends on.** U37.
- **Covers.** Deliverable 1.
- **Build.** README runs and tests the project in 3 commands or fewer (install, dev, test), plus demo users and the eval command.
- **Tests.** None (docs).
- **QA.** Clone into `/tmp`, run exactly the README commands, and save the output.
- **You see.** A fresh clone passes `npm test` with the README's commands alone.
- **Docs.** `README.md`, `AGENTS.md` § 6 kept in sync.

### U39 Design note with the annotated trace

- [ ] Done. Evidence:
- **Depends on.** U37.
- **Covers.** Deliverable 2, deliverable 5 excerpt, R12, review § 4.
- **Build.** `docs/design-note.md`, at most 2 pages: state model, approval enforcement, idempotency and recovery, memory, observability, the annotated timeout-after-success excerpt, and what breaks first at 100× and what we would change.
- **Tests.** None (docs).
- **QA.** Page count checked by exporting to PDF or by word count (about 1,000 words). Every claim matches code and evals.
- **You see.** The note ends with the 100× section.
- **Docs.** This unit is docs.

### U40 Bugs write-up, demo script and the manual QA checklist

- [ ] Done. Evidence:
- **Depends on.** U38, U39.
- **Covers.** Deliverables 4 and 6, the operator's deferred manual check.
- **Build.** Pick three real bugs from `docs/bugs.md`, each with its regression test linked. A 3–5 minute demo script: one full booking plus a live injection and a live timeout-after-success, with chat and trace side by side. A manual browser checklist for the operator covering every page feature from U14, U26, U31, U34 and U35.
- **Tests.** Each listed regression test is named and passes.
- **QA.** The operator runs the manual checklist and records the demo. This is the only operator step in the plan.
- **You see.** `docs/submission-checklist.md` has every deliverable ticked except the recording link, which the operator adds.
- **Docs.** `docs/bugs.md`, `docs/submission-checklist.md`.
