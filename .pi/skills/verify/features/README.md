# Verify — feature map

One file per user-facing feature: what it is, how to drive it (HTTP through Vite `:5173/api`, and the page), the observable end state that proves it, gotchas.

| Feature | File |
| ------- | ---- |
| Booking: search → pick → approve → booked | [booking.md](booking.md) |
| Cancel: identify → approve → cancelled | [cancel.md](cancel.md) |
| Reschedule: identify → new time → move | [reschedule.md](reschedule.md) |
