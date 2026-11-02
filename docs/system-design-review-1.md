# System Design Review 1

> **Status:** Findings resolved in docs — each row in § 7 points at the design change and the unit/test that proves it (`docs/plans/build.md` U02, U03; later units build it).
> **Purpose:** Assess whether `AGENTS.md` and `docs/system-design.md` define a correct, complete, submission-ready solution to `docs/problem-statement.md`.
> **Review perspective:** Senior-engineering review of requirement coverage, correctness, failure handling, verification, and scale limits.

## Scope and Evidence

Primary documents reviewed in full:

- [`../AGENTS.md`](../AGENTS.md)
- [`system-design.md`](system-design.md)
- [`problem-statement.md`](problem-statement.md) — the governing assignment brief

Supporting Markdown documents followed because the system design delegates contracts or deliverable content to them:

- [`infra/schema.md`](infra/schema.md)
- [`infra/api-contracts.md`](infra/api-contracts.md)
- [`system-design-production.md`](system-design-production.md)

No implementation code was inspected, no tests were executed, and no runtime behavior was verified. Findings are document contradictions, missing design guarantees, or submission-planning gaps—not confirmed implementation bugs. Line references identify the versions read for this review and may move after edits.

## Overall Assessment

**The design covers the assignment broadly, but it is not internally consistent enough to implement verbatim. Resolve the approval lifecycle first.**

All eight must-haves have corresponding design sections. The main weakness is not missing headings: several guarantees stop working when the documented rules interact.

The architectural direction is appropriate for the assignment:

- Explicit state and code-controlled actions are the right foundation.
- Approval records and persisted operations address the right safety concerns.
- Separating provider records from agent records makes recovery meaningful.
- Keeping reviews out of intent parsing is stronger than relying on an injection-detection prompt.
- SQLite, an in-process mock API, and a scripted model are reasonable submission choices.

### Priorities

| Priority | Meaning |
| --- | --- |
| P0 | An internal contradiction prevents the documented execution path from working as written. |
| P1 | A must-have is at risk because of an unsafe rule, incomplete contract, or missing guarantee. |
| P2 | A transition, documentation, or submission-readiness gap needs resolution. |

---

## 1. Critical Contradictions and Approval Risks

### R1. Approval becomes unusable before the tool call

**Priority:** P0  
**Classification:** Definite contradiction  
**Affected requirements:** MH-2, MH-3

The documented sequence is:

1. Mark approval `used` and create the operation in one transaction.
2. Call the tool through the gateway.
3. The gateway refuses the call unless the approval is `approved`, explicitly not used.

**Evidence:** `docs/system-design.md:580–585`, `docs/system-design.md:621–622`.

Following both rules means the first legitimate booking, cancellation, or reschedule is rejected. Retries and restart recovery have the same problem.

**Required correction:** Distinguish authorization to create an operation from authorization to execute that existing operation. Creation should require `approved`. Execution and retries should require a matching persisted operation linked to the approval it consumed. Do not fix this by simply allowing any `used` approval through the gateway.

### R2. A repeated typed “yes” can approve a different price

**Priority:** P1  
**Classification:** Missing guarantee  
**Affected requirements:** MH-2, MH-3

Button approval carries an approval ID. Typed approval only carries message text and is applied to whichever approval is currently waiting.

**Evidence:** `docs/system-design.md:540–545`; `docs/infra/api-contracts.md:135–138`.

Example failure sequence:

1. The user sees a ₹1,000 card and sends “yes”.
2. Execution discovers an expired hold; the new quote is ₹1,200.
3. The server creates a replacement approval, but the response is lost.
4. The user repeats “yes”, still thinking about ₹1,000.
5. The server applies it to the ₹1,200 approval.

An exact matching approval record does not prove that the user saw that record.

**Required correction:** Bind typed confirmation to the approval/version shown in the client. Give messages stable request IDs so retransmitting the same message cannot authorize a new action.

### R3. Conversation locks do not protect the same booking across conversations

**Priority:** P1  
**Classification:** Missing guarantee  
**Affected requirement:** MH-2

Different conversations may run concurrently, but locking is only per conversation.

**Evidence:** `docs/system-design.md:114`, `docs/system-design.md:381`, `docs/system-design.md:585`.

Example failure sequence:

1. Conversation A displays approval to cancel the 9 a.m. booking.
2. Conversation B reschedules that booking to 11 a.m.
3. The user approves A’s old cancellation card.
4. `cancel(booking_id, key)` cancels the now-11 a.m. booking.

The provider and slot stored in A’s workflow can still match A’s approval while no longer matching the actual booking.

**Required correction:** Serialize changes to an existing booking and revalidate its current details before execution. A change made through another conversation must invalidate or reject an older approval.

This is a local correctness issue, not something to defer until production scaling.

### R4. Cancellation and rescheduling require data the documented tools do not expose

**Priority:** P1  
**Classification:** Incomplete contract  
**Affected requirement:** MH-2

The design requires cancellation/rescheduling approval to show the original booking price. However:

- `list_bookings` returns ID, provider, service, slot, and status—not price.
- The agent deliberately keeps no booking copy.
- The provider database stores price, but the agent must not read those tables directly.

**Evidence:** `docs/system-design.md:504`, `docs/system-design.md:566`, `docs/system-design.md:610`; `docs/infra/schema.md:242–250`.

There is a related gap: rescheduling searches by `service, area, date_range`, but the documented booking result does not contain the original service area. Rescheduling only collects the new time.

**Evidence:** `docs/system-design.md:344–346`.

**Required correction:** Document where the original price and required search area come from, including for seeded bookings. Resolve this within an explicit reading of the fixed contract; do not quietly add fields or bypass the provider API.

### R5. The unknown-error reply can falsely say nothing was booked

**Priority:** P1  
**Classification:** Definite unsafe rule  
**Affected requirements:** MH-3, MH-5

The prescribed unknown-error message includes:

> “Nothing new was booked.”

**Evidence:** `docs/system-design.md:414`.

That can be false if the provider committed the booking and an exception then occurred during verification, persistence, tracing, or reply generation. Appending “I’ll confirm your booking when you next message” does not repair the contradiction.

**Required correction:** Derive failure wording from the operation’s verified status:

- Confirmed absent: “Nothing was booked.”
- Confirmed successful: report the booking.
- Unknown: “I couldn’t confirm whether it went through. Don’t book again yet.”

Likewise, a cap exit should not promise automatic follow-up when the only documented continuation is another message or a server restart (`docs/system-design.md:411`). Tell the user the concrete next step instead.

---

## 2. Reliability Guarantees Requiring More Design Work

### R6. Forgetting memory does not address copies already loaded into workflows

**Priority:** P1  
**Classification:** Missing guarantee  
**Affected requirement:** MH-6

Memory is copied into workflow facts when a workflow starts. Forgetting then marks the memory row `forgotten` and blocks future inference.

**Evidence:** `docs/system-design.md:307–310`, `docs/system-design.md:731`, `docs/system-design.md:748`.

A workflow can load the remembered area, the user can forget that area through the memory panel, and the workflow can continue using its saved copy. The tombstone prevents future loading; it does not remove an existing copy.

Panel changes also happen outside runs, so they can race with workflow execution.

**Evidence:** `docs/infra/api-contracts.md:185`.

**Required correction:** Preserve which memory record supplied each fact. Define how correction/forgetting affects every active workflow that used it, including what happens if execution is already in progress. Independently supplied details for the current request should not be erased accidentally.

### R7. The provider’s own crash consistency is not specified

**Priority:** P1  
**Classification:** Missing guarantee  
**Affected requirement:** MH-3

The agent-side transaction is explicit. The equivalent provider-side transaction is not. The provider has separate booking and idempotency tables.

**Evidence:** `docs/infra/schema.md:242–264`.

If it saves a booking and crashes before saving the idempotency result, the booking exists but `get_booking_status(key)` may return `not_found`. Recovery can then make the wrong decision.

**Required correction:** Explicitly require booking creation and its authoritative idempotency result to commit atomically. Apply the same principle to cancellation and rescheduling.

Re-holding also changes an operation’s key/request. Define the transaction for that change and durably record the previous key’s terminal outcome.

**Evidence:** `docs/system-design.md:604–617`, `docs/system-design.md:630`.

Test crashes between these writes—not merely recovery from a conveniently prepared `in_flight` row.

### R8. Simulated elapsed time is not sufficient proof of a hard wall-clock cap

**Priority:** P1  
**Classification:** Incomplete enforcement design  
**Affected requirement:** MH-5

The cap uses the controllable clock. Checks happen before model calls, tool calls, and waits; mock pauses are shortened to fit.

**Evidence:** `docs/system-design.md:72`, `docs/system-design.md:394–402`.

That handles simulated waits. It does not yet explain deadline enforcement if a model call stalls, an asynchronous operation takes unexpectedly long, or execution continues after a deadline.

**Required correction:** Distinguish calendar time for slots and hold expiry from monotonic elapsed time for execution deadlines. Both can be injected for testing. Define timeout/cancellation behavior for awaited work and checks after it returns. Include a test of an actually delayed operation, not only an advanced fake clock.

### R9. Some state transitions are incomplete or ambiguous

**Priority:** P2  
**Classification:** Definite transition gap plus missing decisions  
**Affected requirements:** MH-1, MH-2

| Case | Problem |
| --- | --- |
| Declining cancellation approval | Every decline goes back to `choosing` with search results, but cancellation has neither a slot-selection phase nor search results. |
| Multiple yes/no questions | Task-switch confirmation, inferred-memory confirmation, and action approval can all need an answer. One pending action approval does not mean there is only one question that “yes” could answer. |
| Partial time correction | A time window contains dates and daily bounds. “Make it after 11” should not discard an already-known Saturday date. The update/merge contract is not defined at that level. |

**Evidence:** `docs/system-design.md:317`, `docs/system-design.md:348–352`, `docs/system-design.md:578`, `docs/system-design.md:726`, `docs/system-design.md:749`.

**Required correction:** Define intent-specific decline transitions, one explicit pending question, and partial updates for composite facts.

---

## 3. Evaluation and Document-Completeness Issues

### R10. The limit-exhaustion scenario does not reach the configured caps

**Priority:** P1  
**Classification:** Definite inconsistency in the test plan  
**Affected requirements:** MH-5, MH-8

Scenario 21 says endless forced timeouts should stop at a cap.

**Evidence:** `docs/system-design.md:873`.

Under the documented ordinary booking path:

- Three booking attempts produce approximately 30 seconds of timeout pauses plus 1.5 seconds of waits.
- Three status checks plus the final status check produce approximately seven tool calls in total, including the booking attempts.
- A normal message run uses two model calls.

This is below the 10-tool-call and 60-second caps. It should stop because retries are exhausted, not because a cap was reached.

**Evidence:** `docs/system-design.md:398–400`, `docs/system-design.md:523–524`, `docs/system-design.md:628–631`.

**Required correction:** Create deterministic cases for model-call, tool-call, and time exhaustion separately. Keep retry exhaustion as a distinct scenario.

Two additional eval corrections matter:

- **Scope invariant I-1 to agent-created bookings.** As written, seeded historical bookings and bookings created to represent another customer taking a slot have no agent approval and would violate it (`docs/system-design.md:838`).
- **Specify hold-expiry timing.** Advancing 11 minutes before approving should exercise expired pending approval, not automatically prove re-holding after an already-approved operation. Those are different cases (`docs/system-design.md:581`, `docs/system-design.md:858–860`).

### R11. The documents disagree on important implementation conventions

**Priority:** P2  
**Classification:** Definite documentation drift

| Topic | Conflict | Consequence |
| --- | --- | --- |
| Timestamp units | Auth examples use Unix seconds; the authoritative schema says milliseconds. | Expiry calculations can be wrong by 1,000×. |
| `npm test` | `AGENTS.md` describes the server Vitest suite; system design requires Vitest and evals. | The documented submission command may omit mandatory evaluation. |
| Artifact storage | `AGENTS.md` says trace/artifact storage is undecided; system design specifies trace JSON export and an eval-table path. | Future work receives conflicting instructions. |

**Evidence:** `docs/system-design.md:231–238`; `docs/infra/schema.md:18`; `AGENTS.md:46`, `AGENTS.md:254`; `docs/system-design.md:799`, `docs/system-design.md:883–884`.

**Required correction:** Standardize timestamps and make `AGENTS.md` reflect the final test and artifact contracts. Keeping evals separate from Vitest is fine; the ambiguity is whether the top-level command runs both.

### R12. Submission evidence is less complete than feature planning

**Priority:** P2  
**Classification:** Readiness gap, not a claim that implementation is missing

The brief requires more than working features. The reviewed documents leave these exposed:

| Deliverable | Gap |
| --- | --- |
| Three real bugs | No defined place/process to capture what broke, why, the fix, and its regression test while building. Reconstructing this at the end invites weak evidence. |
| 100× discussion | The design delegates it to a production section that is currently TBD. The paragraph is mandatory even though production infrastructure is not. |
| Recorded demo | Side-by-side chat/trace is planned, but the full 3–5 minute acceptance checklist is not consolidated: complete booking, live handled failure, and recording link. |

**Evidence:** `docs/problem-statement.md:58–62`; `docs/system-design.md:940`; `docs/system-design-production.md:29–31`.

**Required correction:** Add a submission checklist with exact artifact locations and acceptance conditions. Do not write the “three real bugs” until they actually happen.

---

## 4. Scale Limits: What to Fix Now Versus Document for Later

Do not turn this assignment into a distributed system. Most infrastructure limits are acceptable for a local submission. The required improvement is to explain them accurately.

| Limit | What becomes problematic | Recommendation |
| --- | --- | --- |
| In-memory conversation locks | A second Node process has separate locks and can execute the same conversation concurrently. | Keep one process now and document the restriction. Use shared/durable coordination only if multiple processes become necessary. |
| Synchronous SQLite work | More concurrent requests and trace writes can delay the event loop and contend for the database writer. | Measure at 100× before choosing a replacement. Short transactions and appropriate indexes come first. |
| Full history and full-result traces | Conversation reads return all messages; traces retain complete slot lists and nothing is deleted. Storage, response size, and UI rendering grow continuously. | Accept for the demo; define pagination and retention as future changes. |
| No cross-conversation/user-wide execution budget | One user can create many conversations and bypass the practical protection of one-run-per-conversation. | Document the local assumption; add user-wide concurrency/resource limits before broader exposure. |

**Evidence:** `docs/system-design.md:114–116`, `docs/system-design.md:792`; `docs/infra/api-contracts.md:123–133`, `docs/infra/api-contracts.md:210–215`.

The “few KB per run” estimate is optimistic: one broad search can return hundreds of slots, and those details can appear in tool traces, model inputs, and saved message parts.

A Markdown review cannot establish which resource fails first at 100×. The design note should name the assumed load and likely limits rather than claim SQLite necessarily fails at a particular user count.

The cross-conversation booking and memory correctness issues in R3 and R6 still need resolution for the local design; they are not merely future scaling concerns.

## 5. Decisions to Keep

These are not submission defects:

- **Scripted model:** Explicitly permitted by the brief. A live LLM is unnecessary.
- **SQLite and one server process:** Appropriate for the local scope.
- **Hold before approval:** Necessary to approve the actual quoted price.
- **Structural injection protection:** Correct; the warning badge should remain informational.
- **Deferring nice-to-haves:** Correct until every must-have is demonstrated.

Custom auth, sign-up, accordions, and editable panels add work beyond the core assignment. They are valid product decisions, but should not take priority over recovery tests and submission evidence.

## 6. Recommended Resolution Order

1. Resolve approval consumption and gateway authorization (R1).
2. Close stale-confirmation and cross-conversation booking risks (R2–R3).
3. Specify required booking data, truthful outcomes, durable recovery, memory invalidation, and real deadlines (R4–R8).
4. Repair transitions, the eval plan, and document contradictions (R9–R11).
5. Complete the submission-evidence checklist and 100× note (R12 and §4).

**First concrete correction:** Rewrite `docs/system-design.md` §2.5.5 to define exactly how the first tool call, retries, and restart recovery are authorized after approval changes from `approved` to `used`.

## 7. Resolution Table

Each finding's design change, in `docs/system-design.md` unless noted, and the plan unit that builds its proof.

| Finding | Resolution | Section | Proof (unit · test / eval) |
| ------- | ---------- | ------- | -------------------------- |
| R1 | Execution authorization moves from the approval's status to the persisted operation | 2.5.4 gateway last bullet; 2.5.5 The check (two gates); 2.5.6 step 1 | U15 · gateway refuses writes without a persisted operation; U21 · book executes only through it |
| R2 | Typed yes carries the shown card's `approvalId`; every send carries a `clientMessageId` that replays | 2.5.3 run rows (client message ids); 2.5.5 rule 1; api-contracts message + pick bodies | U12 · resent id starts no run; U20 · yes on an old card id doesn't approve the new one |
| R3 | One `in_flight` operation per booking (DB); re-check the booking before cancel / reschedule executes | 2.5.5 The check (Gate-2 re-check); schema operation.booking_id + unique index | U28 · booking changed elsewhere → approval voided, no call; eval R3-cross-conversation |
| R4 | `list_bookings` returns `price` + `area` (written reading of the fixed contract) | 2.5.4 list_bookings row; schema mock_booking.area | U07 · returned fields; U19/U28/U29 · approval cards carry price, search by area |
| R5 | Failure wording derived from the operation's checked status; caps name the concrete next step | 2.5.3 run-end table (cap rows, unknown_error, retries_exhausted) | U25 · wording matches checked status; evals 21a–21d |
| R6 | Memory-sourced workflow facts keep the fact id and are re-checked at run start | (U03) 2.5.2 / 2.5.8 | U03 · doc; U32 · forget stops use in an open workflow; eval 19 |
| R7 | Provider commits booking + idempotency result atomically; key change is one transaction | 2.5.6 provider-side atomicity + key-change transaction; schema mock tables | U08 · fault between writes leaves neither; U22 · key-change atomicity |
| R8 | Calendar clock (slots, holds) vs injected elapsed timer (run deadline); awaited work raced | (U03) 2.5.3 caps | U03 · doc; U04 · two clocks; U25 · real delayed op stops at deadline; eval 21c |
| R9 | Decline by intent; one explicit pending question; partial time correction merges | (U03) 2.5.2 + 2.5.5 | U03 · doc; U16 · merge rows; U20/U30 · decline transitions |
| R10 | Cap scenarios split into deterministic cases; retry exhaustion separate; I-1 scoped; hold-expiry timing explicit | (U03) 2.5.10 + caps | U25 · evals 21a–21d; U17 · I-1 scope (U03 doc) |
| R11 | Milliseconds everywhere; `npm test` = Vitest + evals; artifact paths fixed | (U03) schema/api-contracts + AGENTS.md 2 and 6 | U03 · docs; U05 · ms timestamps; U13 · root test runs evals |
| R12 + § 4 | Submission checklist + bugs log; 100× note goes in the design note | (U03) new docs/submission-checklist.md, docs/bugs.md | U37–U40 · artifacts exist with acceptance checks |

R6 and R8–R11 + R12 are folded into the design by U03 (docs), and built and proven by the units named above.
