# Tool Mocks — the provider side (§ 2.5.4)

> Status: **In progress** — U06–U09 build it from `docs/plans/build.md`.

## What it is

An in-process mock of the brief's fixed provider-tool contract: 5 services, 5 Bengaluru areas, ~44 providers (every service + area pair has 3–8), prices in the service's range, 3–6 reviews per provider including the five hand-written injection fixtures, seeded demo bookings, and seed-derived free slots (8:00–20:00 IST, 1 h, ~4/provider/day, next 14 days, past/booked/held excluded).

## Modules

| File                    | Owns                                                             |
| ----------------------- | ---------------------------------------------------------------- |
| `tools/mock-world.ts`   | Services, areas, price ranges, `seedMockWorld(db, {seed, clock})` |
| `tools/slots.ts`        | `slotWindow(clock)`, `seededHours`, `freeSlots`                   |
| `tools/read-tools.ts`   | `searchProviders`, `getProvider`, `listBookings`                  |
| `tools/write-tools.ts`  | `holdSlot`, `book`, `getBookingStatus`, `cancel`, `reschedule` (U08, U09) |
| `tools/settings.ts`     | App vs eval settings: seed, probabilities, pauses (U08)           |
| `tools/tool-gateway.ts` | The only way the agent reaches the tools — one object per run bound to userId + trace + tool budget. Caps (U25): the run's budget (`CreateGatewayOpts.budget`) is checked before every call — over 10 → `CapHit` stops the run before the call is made (formerly a soft `CAP_TOOL_CALLS` result) — and re-checked after it returns; the mock's timeout pause goes through `budget.wait`. Shape checks → `PROVIDER_BAD_RESPONSE`. get_provider's reviews cut to 500 chars + `suspectedInjection` per review and on the trace event. `book` / `cancel` / `reschedule` fail closed with `UNAUTHORIZED_WRITE` unless the injected `authorizeWrite` (Gate 2, booking operations) allows that exact call (R1, MH-2); `cancel` (U28) and `reschedule` (U29) are wired |

## Contract readings worth remembering

- **`list_bookings` also returns `price` and `area` (R4).** The brief's return row is the minimum; without these the agent could not show a cancel/reschedule approval price or search the booked provider's area. Stored on `mock_booking` since migration `001_mock_world.sql`; the agent never reads mock tables directly.
- **`completed` is derived**: a stored `'booked'` whose slot is past reads as `completed` (schema.md); only `booked`/`cancelled` are stored.
- **`get_provider` is the only tool returning free text.** It returns reviews as `{ text }` only — the `injection_kind` fixture label stays in the database for eval seeding. The gateway (U15) wraps the text as untrusted and computes the `suspected_injection` flag for traces.
- **Free slots are never stored** — recomputed from `seed | slots | provider | date` and filtered by past (calendar clock), booked, unexpired holds.
- **Forced `book` outcomes**: `ok`, `timeout`, `timeout_booked`, `slot_taken`, and (U22) `hold_expired` — which ages the hold out on the spot so the provider answers exactly as for a real expiry. (U24) `server_crash_before_commit` / `server_crash_after_commit` play *our* server dying mid-call: the call throws before anything happens, or after the booking and its idempotency record are committed (R7). Forced only — never drawn. (U29) `reschedule` forced `ok` (no random conflict) / `slot_conflict`. (U25) `throw_before_commit` / `throw_after_commit` throw a plain error instead — an unforeseen failure the run must word truthfully (R5); `get_booking_status` forced `throw` makes the status unreadable.
- **Forced outcomes for `hold_slot`** (NFR-4, U19): `price_changed` quotes `round(price × 1.1)` (a visible change inside the ±15% band); `slot_unavailable` refuses a free slot and holds nothing. Evals queue them with the runner's `force` step.
- **Public API** is `tools/index.ts` (gateway, settings, seed, `slotWindow`, types); other features import only from there.

## How it's driven

Unit tests: `server/src/tools/*.test.ts` (fresh DB per test via `shared/test-db.ts`). HTTP exposure comes with the gateway and conversation units — until then, tests are the surface.