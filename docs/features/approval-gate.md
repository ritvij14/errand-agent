# Approval Gate (MH-2, § 2.5.5)

> Status: **Building** — U19 creates `pending` approvals and draws the card from them; U20 decides, voids and expires them; U21 adds the two gates (R1).

## What exists

- `server/src/approval/` — public API in `index.ts`:
  - `approvalRepo(db)`: `createPending`, `getById`, `getOpen(workflowId)` (pending or approved), `decide(id, approved|declined, via)` (only from `pending`), `voidOpen(id, reason)`. `APPROVAL_MAX_AGE_MS` = 10 min (the hold's lifetime).
  - `approvalCardPart(record, providerName)` builds the `approval_card` part from the record's fields (`approvalId, action, provider {id, name}, slot, price, bookingId?, status`). The provider name is the only field not on the record; it comes from the saved option blocks.
- **Creation** (`agent/workflow.ts` `holdSelection`): after `hold_slot` succeeds, the workflow save (`hold`, phase `awaiting_approval`) and the approval insert run in **one transaction**. Input comes from the saved selection and hold only — never from model output or tool arguments. `price` is the hold's `quotedPrice` (V-2); when it differs from the search price the reply says so.
- **Decisions** (`agent/workflow.ts` `decideOn`), one rule set for both inputs:
  - Button: `POST /api/approvals/:id/decision` `{ decision: "approve" | "decline" }` → a run with trigger `approval_decision` (busy check, trace, 1 model call — the write). Not the user's approval → `NOT_FOUND` (404) before any run; bad decision → `VALIDATION_ERROR` (400).
  - Typed: only a **plain** yes / no (the whole message is the decision word — `agent/model.ts` `PLAIN_YES` / `PLAIN_NO`). The message's `approvalId` (sent by the page) picks the card; without one it answers the waiting card. "yes but 11am" / "no, after 11" are read as a **change** (the rest of the message), never a decision.
  - Approve → `approved` + `decided_via`, then at once **Gate 1** uses it up: `approved → used` in the same transaction that creates the operation and moves the workflow to `executing` (see `docs/features/booking-lifecycle.md`).
  - Decline → `declined`, back by intent (R9): a booking returns to `choosing` with the same candidates and facts; selection and hold clear. (Cancel-intent decline → `failed` lands with U28.)
  - A card that is not the waiting one (old id, voided, declined) → `APPROVAL_STALE`, the current card is shown again (R2). Already approved → `APPROVAL_ALREADY_USED`.
  - Waiting over 10 minutes → voided `expired`, the same slot is re-held, and the reply shows the fresh card with `APPROVAL_STALE`.
  - Anything unclear while a card waits → the card is shown again ("approve or decline").
- **Voids**: a changed fact while a card waits → `user_correction` (then the change applies and the search re-runs); "never mind" / "cancel that" → `user_dropped` and the workflow is `abandoned`; `expired` as above. `task_switched` lands with U30; booking-changed-elsewhere with U28/U29.
- **Trace**: `approval_event` with `event` = `created` / `approved` / `declined` / `voided` (+ `via`, `voidReason`, action, provider, slot, price).

## Invariants

- At most one `pending`/`approved` approval per workflow (`one_open_approval` partial unique index).
- The card always equals the record (tested: `pick.flow.test.ts`, eval 5 `cardMatchesApproval`).
- Only the waiting card's own id, while `pending` and fresh, can be decided (`approval.flow.test.ts`).

## The R1 rule — two gates

- **Gate 1** (`booking/gates.ts` `startBookOperation`): only an `approved` approval equal to the request creates an operation, and that marks it `used`. A `used` approval can never authorize a new operation; the unique `approval_id` on operations backs this in the database.
- **Gate 2** (`booking/gates.ts` `authorizeWrite`, injected into the tool gateway): a `book` call runs only for a persisted `in_flight` operation whose approval is `used` and whose request equals the call. An `approved`-but-unused approval can never authorize a tool call.
- Repeated approvals report the existing operation (wording lands with U23); cancel / reschedule gates with U28 / U29.
- **`used → voided`** happens only in one place: a re-hold after `hold_expired` found a new price (`price_changed`) or no slot (`slot_changed`) before anything was booked (evals 6, 7). The user must approve the new details on a new card.
