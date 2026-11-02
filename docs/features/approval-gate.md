# Approval Gate (MH-2, § 2.5.5)

> Status: **Building** — U19 creates `pending` approvals and draws the card from them; U20 decides, voids and expires them. Gate 1 / Gate 2 execution checks come with U21.

## What exists

- `server/src/approval/` — public API in `index.ts`:
  - `approvalRepo(db)`: `createPending`, `getById`, `getOpen(workflowId)` (pending or approved), `decide(id, approved|declined, via)` (only from `pending`), `voidOpen(id, reason)`. `APPROVAL_MAX_AGE_MS` = 10 min (the hold's lifetime).
  - `approvalCardPart(record, providerName)` builds the `approval_card` part from the record's fields (`approvalId, action, provider {id, name}, slot, price, bookingId?, status`). The provider name is the only field not on the record; it comes from the saved option blocks.
- **Creation** (`agent/workflow.ts` `holdSelection`): after `hold_slot` succeeds, the workflow save (`hold`, phase `awaiting_approval`) and the approval insert run in **one transaction**. Input comes from the saved selection and hold only — never from model output or tool arguments. `price` is the hold's `quotedPrice` (V-2); when it differs from the search price the reply says so.
- **Decisions** (`agent/workflow.ts` `decideOn`), one rule set for both inputs:
  - Button: `POST /api/approvals/:id/decision` `{ decision: "approve" | "decline" }` → a run with trigger `approval_decision` (busy check, trace, 1 model call — the write). Not the user's approval → `NOT_FOUND` (404) before any run; bad decision → `VALIDATION_ERROR` (400).
  - Typed: only a **plain** yes / no (the whole message is the decision word — `agent/model.ts` `PLAIN_YES` / `PLAIN_NO`). The message's `approvalId` (sent by the page) picks the card; without one it answers the waiting card. "yes but 11am" / "no, after 11" are read as a **change** (the rest of the message), never a decision.
  - Approve → `approved` + `decided_via`, workflow → `executing` (U21 executes from there; until then the reply is "Approved.").
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

## Not yet

- The gates before any `book` call (U21). Until U21 the tool gateway refuses `book` / `cancel` / `reschedule` outright, so an approved booking waits in `executing`.
