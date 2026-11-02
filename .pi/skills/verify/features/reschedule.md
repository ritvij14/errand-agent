# Reschedule — identify → new time → move (same price)

**What it is.** "Move my AC servicing to Saturday" finds the upcoming booking, searches only the booked provider in the booking's area (V-3), shows those times at the booking's price (V-9); tap + Confirm sends "Move to {slot} with {provider}"; the card shows the new slot and the original price; Approve re-reads the booking (R3) and moves it.

## Drive it over HTTP

As alice (seeded `mb-demo-ac`): send "Move my AC servicing to Saturday" → `option_blocks` with one provider; send a slot's `pickText` → `approval_card` `action: "reschedule"`; approve it.

## Proof

- Reply starts with `Moved:` and says the price is unchanged; `mock_booking` has the new `slot`, same `price`, `booked`; `operation` kind `reschedule` `succeeded`; approve-run trace `list_bookings → reschedule`.

## Gotchas

- The mock draws a ~10% `slot_conflict`: the times come back without that slot — pick another.
- Without a time it asks for one first ("When would you like to move …").
