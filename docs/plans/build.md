# errand-agent build plan

Build the graded assignment end to end: a chat agent that books, reschedules and cancels
home-service errands against the mock provider contract, with code-enforced approval, no
double-booking and injection-safe tool output. Built from `docs/problem-statement.md` and
`docs/system-design.md` (Level 1). Executed with the `build-plan` skill; QA on the real
surface via the `verify` skill.

One box is one verifiable unit. Tick a box only when its evidence exists (tests red→green,
QA drive, commit sha). Units run in order; each starts from a green baseline.

## Stage 0 — Baseline

- [ ] **U0 Prove the harness. Run `npm install`, `npm test`, `npm run dev`; confirm the
      verify skill's doctor passes against the scaffold (health + page + sign-in route
      reachable as far as scaffold code allows).** Evidence: command outputs noted in the
      unit reply; fix anything scaffold-level that blocks a green baseline. This also
      proves the `verify` skill against the real app for the first time.

## Stage 1 — Shared foundations

- [ ] **U1 Controllable clock + seeded random (NFR-4, NFR-7).**
      Files: `server/shared` (clock IST, "now" injected — never read from the system;
      seeded random helpers). Tests: fixed-now behavior, IST conversions, determinism of
      drawn values, clock advancing. Proves: every later time-related test is possible.
- [ ] **U2 Error catalogue (2.5.3).**
      Files: `server/shared` errors — HTTP codes {VALIDATION_ERROR…CONVERSATION_BUSY} with
      status + message, and conversation-level codes with user messages and state effects.
      Tests: table-driven, each code → status/message.
- [ ] **U3 SQLite + migrations runner (2.5.12, ADR-003).**
      Files: `server/shared` db module; `server/migrations/` + `schema_migration` table.
      Tests: migrations apply in order, rerun is a no-op, STRICT modes hold, seed data
      survives schema changes. Integration-level (real DB file, no mock DB).

## Stage 2 — Mock provider side

- [ ] **U4 Mock world seed + slot calculation (2.3, 2.5.4).**
      Files: `server/tools` — seed tables (5 services, 5 areas, ~40 providers with
      Bengaluru-style names, ratings, attributes, reviews incl. the 5 hand-written
      injection kinds, seeded bookings); slots calculated from seed (1 h, 08:00–20:00 IST,
      ~4/day/ provider, next 14 days, free = not past/held/booked). Tests: every
      service+area pair has 3–8 providers; slot determinism for provider+date; past/hold/
      booked exclusion with the controllable clock; injection reviews present (5 kinds).
- [ ] **U5a Read tools: `search_providers`, `get_provider`, `list_bookings` (2.5.4).**
      Tests: contract shapes; date_range bounds (14 days); empty-slot providers still
      returned; reviews not in search results; list_bookings returns only the calling
      user's (V-7); statuses booked/cancelled/completed.
- [ ] **U5b Write tools: `hold_slot`, `book`, `get_booking_status`, `cancel`,
      `reschedule` (2.5.4).**
      Tests per contract: hold → `hold_id`/`expires_at`+10 min (clock)/`quoted_price`
      (differs ~20%, ±15%), `slot_unavailable` when not free; book idempotent per key
      (V-checked by mock's per-key final results, timeouts not remembered), 70/15/15 with
      forced outcomes, timeout pause on the clock, `hold_expired`; `get_booking_status`
      reads provider-side records (`booked`/`not_found`/`failed`); cancel first-call-503
      per booking then retry succeeds (V-8), same key after success → `cancelled` again;
      reschedule keeps price (V-9), `slot_conflict` on configured ~10% slots and on
      non-free slots, old slot freed. Determinism: same seed + same inputs + attempt = same
      outcome; forced-outcome queue preempts random drawing.
- [ ] **U6 Tool gateway (2.5.4, 2.5.5, 2.5.7).**
      Files: `server/tools` gateway — 8 methods bound to the signed-in user, one attempt
      per call, cap counting (budget object), trace recording per call, shape validation →
      `PROVIDER_BAD_RESPONSE`, free-text wrapped as untrusted + suspected-injection flag
      (label only), and the hard gate: `book`/`cancel`/`reschedule` refused unless a valid
      matching `approved` approval is handed in. Tests: refusal without approval (the
      MH-2 corner-stone test), refusal on provider/slot/price mismatch, bad shape → named
      error, untrusted wrapping, cap refusal.

## Stage 3 — Agent core

- [ ] **U7 Approval module (2.5.5).**
      Files: `server/approval` + tables. Record fields per LLD; life: created by code from
      state → decided via button or typed yes (same record) → voided on provider/slot/price
      change, correction, task switch, 10-min expiry → single `used` in the operation
      transaction. Typed-yes rules: plain yes only, answers the one waiting approval.
      Tests: each life step incl. void reasons, expiry with clock, single use, "yes but
      11am" → voided.
- [ ] **U8 Booking operations (2.5.6, MH-3).**
      Files: `server/booking` + tables. Operation saved before every call; idempotency key
      `<op id>:<n>`; one operation per approval (unique in DB); book decision table
      (ok → always `get_booking_status` before reporting; timeout → status → retry same
      key ≤3; `slot_taken` → failed back to choosing; `hold_expired` → re-hold, same price
      keeps approval, new price voids it (V-4), new key `_2`); cancel 503 retry; reschedule
      conflict → choosing minus conflicting slot; outcome-unclear → `list_bookings` check;
      repeated "yes" reports existing operation, no second call; restart recovery rules
      (status first; resume book only while hold valid; cancel/reschedule retry within
      10 min of approval). Tests: the decision table row by row, forced outcomes, clock
      shifts, double-booking impossibility.
- [ ] **U9 State machine (2.5.2, MH-1).**
      Files: `server/agent` state module + workflow tables (facts, target, candidates,
      selection, hold, approval link, operation, version). Phases + rules 1–5: ask only
      missing; correction overwrites one detail and clears only what was built from it;
      approval voided by provider/slot/price change; no changes in flight; restart
      recovery first. Booking/reschedule/cancel phase chains per LLD. Applies structured
      values (scripted model U11 feeds it). Tests: per rule, incl. cascade example
      (budget change → candidates+selection+hold+approval cleared, service/area/time kept).
- [ ] **U10 Traces (2.5.9, MH-7).**
      Files: `server/tracing` + tables. Event types + fields per table; `clock_at` vs
      `duration_ms`; allow-list only (no secrets by construction — passwords/tokens/cookies
      never passed in); cleaned results (shape-checked, reviews ≤500 chars + flag); export
      to `traces/<run id>.json`. Tests: event coverage for a scripted mini-run; I-9 secret
      sweep of every stored trace; two-clock values (eval-style 10 s pause).
- [ ] **U11 Scripted model (2.5.2, 2.5.3; V-1, V-6, V-10).**
      Files: `server/agent` model slot. Read: intent, details (incl. time windows from
      chrono-node + our range/qualifier rules on the controllable IST now), choice parsing
      ("2b", name+time, "the second one" → ask), strict yes/no, drop phrases, cancel-vs-drop
      split. Write: reply text per phase + waiting context ("an approval is pending"),
      structured parts stay from state. Tests: phrase-level unit coverage of every pattern
      the Evals rely on; never sees provider reviews.
- [ ] **U12 Memory (2.5.8, MH-6).**
      Files: `server/memory` + tables. Stated (explicit lasting only — "remember", "always",
      "I live in…") vs inferred (same value in 2 completed bookings with evidence) →
      `awaiting_confirmation`, used only after confirm; forget → `forgotten` marker that
      blocks re-inference (V-12); usage fills workflow facts with `source=memory` + one-line
      note; request differing from saved preference → per-request only + light note
      (V-11); view/correct/forget via one memory API. Tests: in/out rules, confirm, forget
      block, I-6/I-7 behavior.
- [ ] **U13 Conversation runner (2.5.3, MH-5, FR-14/15/16).**
      Files: `server/conversations` runner + run tables. Busy marker or
      `CONVERSATION_BUSY` (no waiting line), run rows, recovery first, read → apply →
      advance (tool phases loop through gateway) → write → finish; caps before every model
      call, tool call and wait (6 / 10 / 60 s on the shared clock, waits bounded by time
      left); every ending recorded with its clear message (`cap_*`, `retries_exhausted`,
      `error`, `unknown_error`, `completed`); task-switch ask before dropping. Tests:
      integration over real DB — busy refusal, cap triggers with forced outcomes,
      restart-mid-booking flows, each outcome code's reply contract.

## Stage 4 — HTTP + client

- [ ] **U14 Auth API (2.5.1, FR-1).**
      Files: `server/auth` + routes. Sign-up/sign-in/sign-out/me; Argon2id; token
      `<id>.<secret>`, hashed secret, 10-day sliding sessions; cookie flags (no Secure on
      localhost); CSRF rules (`Sec-Fetch-Site` + parsed JSON body) → `CSRF_REJECTED`;
      per-username token bucket (5 burst, 1/min); explicit failure messages. Tests:
      integration per endpoint — happy path, validation (field-level details), auth, CSRF
      rejection, rate limit, ownership (`NOT_FOUND` for other users' resources).
- [ ] **U15 Conversations / approvals / traces / memory API (2.5.11).**
      Files: `server` route files per `docs/infra/api-contracts.md` (list/create/read, send
      message, pick slot, approval decisions incl. button id path, traces incl. export,
      memory list/correct/confirm/reject/forget). Every run-starting endpoint returns the
      Reply shape; routes hold no business logic. Tests: per endpoint happy/validation/
      auth/ownership, run-through with the runner on real DB.
- [ ] **U16 Chat page (FR-6, FR-9, FR-10, FR-12, FR-13 + deliverable 6 surface).**
      Files: `client/src` — sign-in/up screens; chat with provider-block accordions + slot
      buttons, approval cards drawn from the record, memory panel (view/correct/confirm/
      forget), trace panel (timeline, expandable events, trace links, latest-run auto
      load); Send/Approve disabled while a reply is pending. TanStack Query hooks only,
      no direct fetch in components. Tests: component tests where cheap (render + logic);
      the real proof is a `verify` drive: sign in, booking happy path to approval card
      (quoted price shown), approve via button, trace panel shows tool_call +
      state events, memory panel round-trip.
- [ ] **U17 Eval suite (2.5.10, MH-8, deliverable 3).**
      Files: `server/evals` — offline runner (fresh DB per scenario, fixed seed + clocks,
      forced outcomes, scripted users with `say`/`click`/`advance`/`restart`/
      `send_concurrently`/`expect`), invariants I-1…I-10 checked after every step, all 23
      accepted scenarios, eval table written to `docs/evals/eval-table.md` (run date,
      commit, seed at top; also printed). `npm test` = Vitest + evals; `npm run evals`
      alone. Tests: the 23 scenarios are the tests; plus a couple of runner unit tests.
      Gate: 23/23 pass, every scenario's expected outcomes asserted.
- [ ] **U18 Deliverables wrap-up (deliverables 1–6).**
      README ≤3 commands (install / dev / test); design note ≤2 pages condensed from
      system-design.md; one raw exported trace of a timeout-after-success run + annotated
      excerpt; three-real-bugs log (grown during the build — kept in `docs/bugs.md` as they
      happen, never invented at the end); demo recording script using the verify feature
      map. QA: full suite green from a clean clone; eval table regenerated and committed.

## Standing rules across all units

- Tests before implementation, always; bug fixes start with a failing regression test.
- Assert behavior, not implementation (two-edit test).
- Decisions left open by the design follow its readings table (V-1…V-12); each gets covered
  by the test or eval named there. New ambiguity → decide, write it down, test it.
- `docs/features/<feature>.md` is created the moment work starts on that feature (index in
  AGENTS.md §7); docs refreshed when behavior changes mid-unit.
- Commits: conventional, one unit (or its clean slices) per commit, each passing tests.