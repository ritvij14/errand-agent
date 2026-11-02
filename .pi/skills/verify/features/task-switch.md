# Drop and task switch (FR-15, FR-16, V-10)

**What it is.** "never mind" anywhere before the change call abandons the request ("Okay, dropped…" with no tool call). A different request (cancel / reschedule / a new booking with an explicit service) on an unfinished task asks first: "You haven't finished … Drop it and …?"; "yes" starts the new one, "no" keeps it. With an approval card open it refuses instead of stacking questions.

## Drive it over HTTP

As alice: "Plumber in Indiranagar" → "cancel my AC servicing" (ask) → "no" (kept) → "move my AC servicing to Saturday" (ask) → "yes" (reschedule slots) → pick → "never mind" (dropped, bookings untouched).

## Proof

- `mock_booking` rows unchanged after the drop; workflow rows show the old `book:abandoned` and the dropped task `abandoned`.

## Gotchas

- A drop while the reply already confirmed a change ("Moved:/Cancelled:") reports `APPROVAL_ALREADY_USED` wording instead — the call already happened.
