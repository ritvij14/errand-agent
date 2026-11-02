# Cancel — identify → approve → cancelled

**What it is.** "cancel my AC servicing" finds the user's upcoming booking (their own `list_bookings`; by id, service or provider), shows a cancel card; Approve re-reads the booking (R3), sends `cancel` — the first call always gets a 503 (`glitch`, V-8) and is retried with the same key — and replies "Cancelled: …".

## Drive it over HTTP

As alice (seeded upcoming `mb-demo-ac`, AC servicing): `POST /api/conversations/:id/messages` `{ text: "cancel my AC servicing" }` → `approval_card` with `action: "cancel"`, `bookingId`. Then `POST /api/approvals/:approvalId/decision` `{ decision: "approve" }`.

## Proof

- Reply starts with `Cancelled:`; `mock_booking.status = 'cancelled'`; `operation` kind `cancel`, `succeeded`, attempts 2.
- Trace: `list_bookings → cancel:glitch → cancel` with the same idempotency key.
- A second Approve → "Already cancelled … I didn't send it again."

## Gotchas

- Only upcoming (`booked`) bookings can be cancelled; "cancel my booking" with several asks which (`BOOKING_AMBIGUOUS`).
- A request already in progress must be dropped first ("never mind") until U30's task switch.
- The seed's 503 is served once per booking: after one cancel attempt on a booking, the next call goes straight through.
