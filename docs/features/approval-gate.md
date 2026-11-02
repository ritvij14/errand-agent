# Approval Gate (MH-2, § 2.5.5)

> Status: **Building** — U19 creates `pending` approvals and draws the card from them. Decisions (approve / decline / void / expiry) come with U20; Gate 1 / Gate 2 execution checks with U21.

## What exists

- `server/src/approval/` — public API in `index.ts`:
  - `approvalRepo(db).createPending(input, now)` inserts a `pending` record (`006_approval.sql`). Input comes from the workflow's saved **selection** and **hold** only — never from model output or tool arguments.
  - `approvalCardPart(record, providerName)` builds the `approval_card` reply part from the record's fields (`approvalId, action, provider {id, name}, slot, price, bookingId?, status`). The provider name is the only field not on the record; it comes from the saved option blocks.
- Where it is created: `agent/workflow.ts` `holdSelection` — after `hold_slot` succeeds, the workflow save (`hold`, phase `awaiting_approval`) and the approval insert run in **one transaction**, so a workflow never waits on an approval that doesn't exist (or vice versa).
- `price` is the hold's `quotedPrice` (V-2). When it differs from the search price, the reply says so ("The provider quoted ₹X … (the search showed ₹Y)").
- A trace `approval_event` `{ event: "created", approvalId, action, providerId, slot, price }` is recorded in the run's trace.

## Invariants

- At most one `pending`/`approved` approval per workflow (`one_open_approval` partial unique index).
- The card always equals the record (tested: `pick.flow.test.ts`, eval 5 `cardMatchesApproval`).

## Not yet

- Decisions and voiding (U20), the gates before any `book` call (U21). Until U21 the tool gateway refuses `book` / `cancel` / `reschedule` outright.
