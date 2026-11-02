# Booking Lifecycle (MH-3, § 2.5.6)

> Status: **Building** — U21 executes and verifies a booking; U22 handles every row of the § 2.5.6 decision table; U23 repeated yes and overlapping messages. Restart recovery (U24) follows.

## What exists

- `server/src/booking/` — public API in `index.ts`:
  - `operationRepo(db)` over `operation` (`007_operation.sql`): one row per approved action, saved **before** the tool is called. `approval_id` and `idempotency_key` are UNIQUE — the database itself refuses a second operation for an approval.
  - `startBookOperation(db, clock, approvalId, request, alsoInTransaction)` — **Gate 1** (R1). In one transaction: the approval must be `approved`, action `book`, and equal the request (provider, slot, price, hold id); it is marked `used`; the operation is inserted `in_flight` with key `<op id>:1` and request `{ holdId }` (exactly what `book` is sent); the workflow moves to `executing` (the callback). Any failure rolls all of it back.
  - `authorizeWrite(db, userId)` — **Gate 2**, injected into the tool gateway (`CreateGatewayOpts.authorizeWrite`), so `tools` never imports `booking`. `book` runs only when the key belongs to this user's `in_flight` book operation, its approval is `used`, and the hold id equals the operation's request. No authorizer → every write is refused (`UNAUTHORIZED_WRITE`). Cancel / reschedule are always refused until their units.
  - `executeBook(db, clock, tools, op, beforeVerify)` — the § 2.5.6 decision table. Every `book` result except `slot_taken` / `hold_expired` is checked with `get_booking_status(key)` before anything is decided (the first check moves the workflow to `verifying`):
    - `booked` (same booking id when `book` returned one) → `succeeded` `{ bookingId }` — this covers timeout-after-success.
    - `not_found` after a timeout → wait on the clock (`retryWaitsMs`: 0.5 s, then 1 s) and call `book` again with the **same key**, up to `MAX_BOOK_ATTEMPTS` = 3 (NFR-2). The check after the third attempt is the "one last" status check; still not booked → `failed` `{ error, checkedStatus }`.
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

## Evals

- 1 happy path; 6 price change after approval; 7 slot gone after approval; 8 same-price re-hold (V-4, trace `book:hold_expired → hold_slot:ok → book:ok → get_booking_status:booked`); 9 timeout after success (`book:timeout → get_booking_status:booked`); 10 timeout, retry same key; 11 `slot_taken` → pick another → booked; 13 yes, yes, click → one booking; 14 yes during the approve run → `CONVERSATION_BUSY`, one booking.
- Every scenario that approves a booking forces its `book` outcome: keys contain the random operation id, so an unforced `book` draws a different result each run (B4). `runner.test.ts` guards this.

## Not yet

- Restart recovery of `in_flight` operations (U24).
