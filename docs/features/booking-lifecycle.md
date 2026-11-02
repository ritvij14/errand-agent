# Booking Lifecycle (MH-3, § 2.5.6)

> Status: **Building** — U21 executes and verifies a booking (happy path, truthful failures). Retries / slot_taken / hold_expired (U22), repeated yes and concurrency (U23), restart recovery (U24) follow.

## What exists

- `server/src/booking/` — public API in `index.ts`:
  - `operationRepo(db)` over `operation` (`007_operation.sql`): one row per approved action, saved **before** the tool is called. `approval_id` and `idempotency_key` are UNIQUE — the database itself refuses a second operation for an approval.
  - `startBookOperation(db, clock, approvalId, request, alsoInTransaction)` — **Gate 1** (R1). In one transaction: the approval must be `approved`, action `book`, and equal the request (provider, slot, price, hold id); it is marked `used`; the operation is inserted `in_flight` with key `<op id>:1` and request `{ holdId }` (exactly what `book` is sent); the workflow moves to `executing` (the callback). Any failure rolls all of it back.
  - `authorizeWrite(db, userId)` — **Gate 2**, injected into the tool gateway (`CreateGatewayOpts.authorizeWrite`), so `tools` never imports `booking`. `book` runs only when the key belongs to this user's `in_flight` book operation, its approval is `used`, and the hold id equals the operation's request. No authorizer → every write is refused (`UNAUTHORIZED_WRITE`). Cancel / reschedule are always refused until their units.
  - `executeBook(db, clock, tools, op, beforeVerify)` — calls `book`, moves the workflow to `verifying`, then **always** calls `get_booking_status(key)`. Only `booked` (with the same booking id when `book` returned one) → operation `succeeded` `{ bookingId }`. Anything else → `failed` `{ error, checkedStatus }`.
- Workflow (`agent/workflow.ts`): approving runs Gate 1 and advances `executing → verifying → done | failed`. The success reply always starts with **"Booked:"** (provider, slot label, quoted price, booking id) — the eval invariant I-3 keys on that prefix. A failure says "Nothing was booked — I checked with the provider…" (wording from the checked status, R5), including after a timeout; a timeout that did book (`timeout_booked`) is reported as booked.
- Trace: `operation_event` `created` / `succeeded` / `failed` with the key and result, next to the `tool_call`s for `book` and `get_booking_status`.

## Invariants (checked by the eval runner after every step)

- **I-1** every agent-created provider booking (one with a provider idempotency record; seeded `mb-demo*` and `u-someone-else` bookings excluded, R10) has an operation whose approval is `used` and matches provider, slot and price; no booking exists outside an operation.
- **I-2** at most one provider booking per operation.
- **I-3** a "Booked:" reply's run has a `get_booking_status` tool call that returned `booked`, before the operation's `succeeded` event.
- Negative tests prove I-1 and I-3 fire (`evals/runner.test.ts`).

## Not yet

- Retries with the same key, `slot_taken` → back to options, `hold_expired` → re-hold with key `_2` (U22). Repeated yes reporting the operation's status (U23). Restart recovery of `in_flight` operations (U24).
