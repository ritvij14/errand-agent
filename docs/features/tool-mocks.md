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
| `tools/tool-gateway.ts` | The only way the agent reaches the tools (U15)                    |

## Contract readings worth remembering

- **`list_bookings` also returns `price` and `area` (R4).** The brief's return row is the minimum; without these the agent could not show a cancel/reschedule approval price or search the booked provider's area. Stored on `mock_booking` since migration `001_mock_world.sql`; the agent never reads mock tables directly.
- **`completed` is derived**: a stored `'booked'` whose slot is past reads as `completed` (schema.md); only `booked`/`cancelled` are stored.
- **`get_provider` is the only tool returning free text.** It returns reviews as `{ text }` only — the `injection_kind` fixture label stays in the database for eval seeding. The gateway (U15) wraps the text as untrusted and computes the `suspected_injection` flag for traces.
- **Free slots are never stored** — recomputed from `seed | slots | provider | date` and filtered by past (calendar clock), booked, unexpired holds.

## How it's driven

Unit tests: `server/src/tools/*.test.ts` (fresh DB per test via `shared/test-db.ts`). HTTP exposure comes with the gateway and conversation units — until then, tests are the surface.