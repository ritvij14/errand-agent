# Verify — feature map

One file per user-facing feature: what it is, how to drive it (HTTP through Vite `:5173/api`, and the page), the observable end state that proves it, gotchas.

| Feature | File |
| ------- | ---- |
| Booking: search → pick → approve → booked | [booking.md](booking.md) |
| Cancel: identify → approve → cancelled | [cancel.md](cancel.md) |
| Reschedule: identify → new time → move | [reschedule.md](reschedule.md) |
| Drop / task switch | [task-switch.md](task-switch.md) |
| Provider details / injection | [injection.md](injection.md) |
| Stated memory | [memory.md](memory.md) |
| Trace panel + export | [traces.md](traces.md) |
| Sign up / sign in / sign out | [auth.md](auth.md) |
| Forced failures (demo knob), timeout after success | [demo-failures.md](demo-failures.md) |
| Restart recovery, run caps | [recovery-and-caps.md](recovery-and-caps.md) |
