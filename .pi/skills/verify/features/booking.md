# Booking — search → pick → approve → booked

**What it is.** A request with service + area + time gets option blocks; tapping a slot and pressing Confirm sends that slot's `pickText` as a chat message (ADR-007); the slot is held and an approval card appears; Approve (button, or a typed "yes" carrying the card id) books it, verified with `get_booking_status` before the reply says "Booked:".

## Drive it over HTTP (what the page does)

Headers on every POST: `Content-Type: application/json`, `Sec-Fetch-Site: same-origin`, plus the session cookie from `POST /api/auth/sign-in` (`alice` / `demo-password-1`).

1. `POST /api/conversations` → `data.id`.
2. `POST /api/conversations/:id/messages` `{ text: "electrician in Jayanagar tomorrow", clientMessageId }` → `parts[type=option_blocks].blocks[].slots[]` each `{ start, label, pickText }`.
3. Tap + Confirm = send `slots[i].pickText` as the text → `parts[type=approval_card]` `{ approvalId, provider, slotLabel, price, status: "pending" }`.
4. Approve: `POST /api/approvals/:approvalId/decision` `{ decision: "approve" }` — or send `{ text: "yes", clientMessageId, approvalId }`.

## The page

Each provider is an accordion (name, ₹price, ★rating); open it, tap a slot (pressed state), Confirm. The card shows provider, slot label and price with Approve / Decline. While a reply is pending, Send, Confirm, Approve and Decline are all disabled.

## Proof (end state)

- Reply starts with `Booked:` and names a booking id.
- `operation` row `succeeded`; `approval` `used` with `decided_via` `button` or `typed`; exactly one agent booking in `mock_booking` for the user (`id NOT LIKE 'mb-demo%'`).
- The approve run's trace: `approval_event approved → operation_event created → tool_call book → tool_call get_booking_status → operation_event succeeded`.

## Gotchas

- `book` outcomes are random in the app (~70% ok); `slot_taken` brings the options back without that slot — pick another. The demo knob to force outcomes arrives in U37.
- Inspect the DB with `/opt/homebrew/opt/sqlite/bin/sqlite3` (system sqlite3 can't read STRICT tables).
- Two parallel requests to one conversation both answer 200 (runs never wait on real time); the second reports the first's result.
