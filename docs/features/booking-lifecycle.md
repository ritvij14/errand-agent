# Booking Lifecycle (MH-3, § 2.5.6)

> Status: **Building** — U21 executes and verifies a booking; U22 handles every row of the § 2.5.6 decision table; U23 repeated yes and overlapping messages; U24 restart recovery.

## What exists

- `server/src/booking/` — public API in `index.ts`:
  - `operationRepo(db)` over `operation` (`007_operation.sql`): one row per approved action, saved **before** the tool is called. `approval_id` and `idempotency_key` are UNIQUE — the database itself refuses a second operation for an approval.
  - `startBookOperation(db, clock, approvalId, request, alsoInTransaction)` — **Gate 1** (R1). In one transaction: the approval must be `approved`, action `book`, and equal the request (provider, slot, price, hold id); it is marked `used`; the operation is inserted `in_flight` with key `<op id>:1` and request `{ holdId }` (exactly what `book` is sent); the workflow moves to `executing` (the callback). Any failure rolls all of it back.
  - `authorizeWrite(db, userId)` — **Gate 2**, injected into the tool gateway (`CreateGatewayOpts.authorizeWrite`), so `tools` never imports `booking`. `book` runs only when the key belongs to this user's `in_flight` book operation, its approval is `used`, and the hold id equals the operation's request. No authorizer → every write is refused (`UNAUTHORIZED_WRITE`). Cancel / reschedule are always refused until their units.
  - `executeBook(db, clock, tools, op, beforeVerify)` — the § 2.5.6 decision table. Every `book` result except `slot_taken` / `hold_expired` is checked with `get_booking_status(key)` before anything is decided (the first check moves the workflow to `verifying`):
    - `booked` (same booking id when `book` returned one) → `succeeded` `{ bookingId }` — this covers timeout-after-success.
    - `not_found` after a timeout → wait on the clock (`retryWaitsMs`: 0.5 s, then 1 s, through the run's `budget.wait`) and call `book` again with the **same key**, up to `MAX_BOOK_ATTEMPTS` = 3 (NFR-2). The check after the third attempt is the "one last" status check; still not booked → `failed` `{ error: "retries_exhausted", checkedStatus }`, kind `retries_exhausted` → the run ends `retries_exhausted` (U25, eval 21d).
    - `slot_taken` → `failed` (`kind: "slot_taken"`).
    - `hold_expired` → returned with the operation still `in_flight`, so the workflow can re-hold.
  - `operationRepo.nextKey(id, holdId, previousOutcome)` — the key change (R7): one UPDATE sets `hold_seq + 1`, key `<op id>:<n>`, the new request, attempts 0, and records the previous key's terminal outcome in `result`.
- Workflow (`agent/workflow.ts`): approving runs Gate 1 and advances `executing → verifying → done | failed`.
  - `slot_taken` → back to `choosing` without that slot (`showRemaining`); the approval stays `used` (NFR-3).
  - `hold_expired` → `reHold`: re-hold the same provider + slot. Same price → `nextKey` (`:2`) and book again without asking (V-4). New price → operation `failed`, approval **voided** `price_changed` (`approvalRepo.voidUsed`: `used → voided`, only when nothing was booked), a new pending card at the new price. Slot gone → operation `failed`, approval voided `slot_changed`, back to the options. Re-holds are capped at 3 keys. The success reply always starts with **"Booked:"** (provider, slot label, quoted price, booking id) — the eval invariant I-3 keys on that prefix. A failure says "Nothing was booked — I checked with the provider…" (wording from the checked status, R5), including after a timeout; a timeout that did book (`timeout_booked`) is reported as booked.
- Trace: `operation_event` `created` / `succeeded` / `failed` with the key and result, next to the `tool_call`s for `book` and `get_booking_status`.

## Invariants (checked by the eval runner after every step)

- **I-1** every agent-created provider booking (one with a provider idempotency record; seeded `mb-demo*` and `u-someone-else` bookings excluded, R10) has an operation whose approval is `used` and matches provider, slot and price; no booking exists outside an operation.
- **I-2** at most one provider booking per operation.
- **I-3** a "Booked:" reply's run has a `get_booking_status` tool call that returned `booked`, before the operation's `succeeded` event.
- Negative tests prove I-1 and I-3 fire (`evals/runner.test.ts`).

## Repeated yes (U23)

- The approval is `used` after the first yes and the database allows one operation per approval, so a second yes or a click finds that operation and reports it — `reportUsed` in `agent/workflow.ts`, no tool call (eval 13). A message sent while the approve run is in progress is refused with `CONVERSATION_BUSY` (eval 14; see `conversations.md` for why parallel HTTP requests run one after the other here).

## Restart recovery (U24)

- An `in_flight` operation means the server stopped between saving and finishing. `workflowStore.recover(conversationId)` (`agent/workflow.ts` `recoverOperation`) handles a workflow still `executing` / `verifying`, **status first**:
  - `booked` → operation `succeeded` (`recovered: true`), workflow `done`, reply "Your booking went through: … Booking id: X."
  - `not_found` and the workflow's hold still valid (`hold.expiresAt` > now) → resume: `executeOperation` books again with the **same key** (the approval still covers it).
  - anything else (`not_found` with the hold expired, or `failed`) → operation `failed`, the slot is held again, and a **new pending card** asks for approval ("Nothing was booked — …"); if the slot is gone the options come back. Never books long after the user's yes.
- **When:** (1) server start — `conversationService.recoverInFlight()` (called from `src/index.ts` before listening) gives every in-flight operation its own `recovery` run (own trace, tool client bound to the operation's user); (2) the start of any run in that conversation, before the new input is read (§ 2.5.2 rule 5) — the outcome is saved as its own agent message ahead of the user's message.
- **Crash points for tests and evals** (forced `book` outcomes only): `server_crash_before_commit` throws before the provider does anything; `server_crash_after_commit` commits the booking + idempotency record, then throws — the R7 case.
- A run that dies this way keeps no `ended_at` / outcome (it was cut off). Invariant I-5 only checks runs that ended.

## Cancel (U28, FR-4, V-8, R3)

- `executeCancel` (`booking/execute.ts`): **R3 re-check first** — `list_bookings` must still show the booking `booked` at the approved provider and slot; otherwise the operation fails `booking_changed` and the workflow voids the approval, with no cancel call. Then `cancel` with the key; a transient failure (the mock's designed first-call 503, `error: "glitch"`, V-8) waits (`budget.wait`) and retries with the **same key**, up to 3 attempts. An unclear end (non-transient error or attempts used) is settled by reading the booking: `cancelled` → `succeeded`, else `failed` with the checked status (R5). A restart after a cancel call was sent (`attempts > 0`) and the booking reads `cancelled` → `succeeded`.
- **Decision:** the design names two moments for the R3 re-check (Gate 1 and Gate 2). They fall in the same run moments apart, so it runs **once, right before the first `cancel` call** — the later of the two — rather than costing two `list_bookings` calls.
- Workflow: "Cancelled: {provider} on {slot}. Booking id: X." only when it happened; `booking_changed` → "That booking changed since you approved…", `failed`; not confirmed → "Nothing was cancelled — … still {status}".
- **Restart / unknown error:** a cancel operation in flight is re-run by `recover` while its approval is under 10 minutes old; older → `settleCancelByList` (read the booking: cancelled → report it, else failed, ask again). `afterUnknownError` words cancels from the same read.

## Reschedule (U29, FR-3, V-3, V-9)

- Cancel and reschedule share one execution, `executeChange` (`booking/execute.ts`): R3 re-check → call with the key → transient failures retried on the same key → a real answer returned → an unclear end settled by `list_bookings`. Per kind only the rules differ: cancel needs the booking `booked` at the approved provider + slot and "happened" = `cancelled`; reschedule needs it `booked` at the approved provider + **price** (V-9) and "happened" = `booked` at the new slot; `slot_conflict` is a real answer (no retry).
- Gate 1 `startRescheduleOperation`: the approval's `booking_id` and `slot` (the **new** slot) must equal the request; the operation sends `{ bookingId, newSlot }`. Gate 2 compares every field of the operation's own request, for all three tools.
- Workflow: "Moved: {provider} to {slot}, price unchanged at ₹X." only when it happened; `slot_conflict` → back to the same provider's other times (`showRemaining`), the approval stays used, the operation `failed`.
- Restart / unknown error: same as cancel (`settleChangeByList` reads whether the booking is at the new slot).

## Evals

- 1 happy path; 6 price change after approval; 7 slot gone after approval; 8 same-price re-hold (V-4, trace `book:hold_expired → hold_slot:ok → book:ok → get_booking_status:booked`); 9 timeout after success (`book:timeout → get_booking_status:booked`); 10 timeout, retry same key; 11 `slot_taken` → pick another → booked; 13 yes, yes, click → one booking; 14 yes during the approve run → `CONVERSATION_BUSY`, one booking; 12 reschedule: only the booked provider (`optionsBlockCount: 1`), `slot_conflict` → other times → moved at the same price; 15 cancel: 503 → same key → cancelled once (trace `list_bookings → cancel:glitch → cancel:ok`); 15b another conversation cancelled it first → the old approval voided, only `list_bookings` called; 20a/b/c restart mid-booking (booked → reported; `not_found` + hold valid → resumed, same key; `not_found` + hold expired → asks again, nothing booked) using the runner's `restart` step (fresh service on the same database + startup recovery).
- Every scenario that approves a booking forces its `book` outcome: keys contain the random operation id, so an unforced `book` draws a different result each run (B4). `runner.test.ts` guards this.

## Not yet

- A cap hit mid-booking (U25, evals 21b, 21c) leaves the operation `in_flight` on purpose; the next run's recovery resolves it.
