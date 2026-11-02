# Stated memory (MH-6, U32)

**What it is.** "I live in HSR" saves a preference (per user). It fills missing workflow details in any later conversation — "Using your saved area: HSR Layout (say if that's changed)" — and a request that names a different area wins for that request only, with one note. "forget my area" marks it forgotten; the open workflow drops it at its next run (R6) and asks for the area again. "what do you remember about me?" lists what's saved.

## Drive it over HTTP

As alice: conversation 1 "I live in HSR"; conversation 2 "book an electrician" (note, no area asked); "forget my area"; "tomorrow morning" → "electrician — which area?".

## Proof

- `memory_fact` has one `area hsr_layout` row, `forgotten`; the workflow's area fact is gone; the reply asked for the area. A request area the user gave (`source: "user"`) survives any forget.

## Gotchas

- Stated saves are keyed on lasting phrasing — "plumber in HSR" is never saved.
- Correcting by chat ("my area is Koramangala now") also corrects an open workflow's detail.

## Inferred preferred provider (U33)

- Setup outside the app: `INSERT INTO mock_booking (id, user_id, provider_id, service, area, slot, price, status, cancel_503_served, created_at, updated_at) VALUES ('mb-qa2', 'u-demo-alice', 'mp-002', 'electrician', 'koramangala', '2026-10-30T09:00:00+05:30', 500, 'booked', 0, 0, 0)` (mp-002 = the demo history's electrician). Two completed electrician bookings for alice now exist.
- "book an electrician in koramangala this week" → "Your last two electrical work bookings were with Namma Wires & Lights — keep them coming?" with 8 options (not narrowed). "yes" → "Saved your choice…" and the options narrow to mp-002 only.
- "no" instead → `memory_fact` `forgotten`; further requests never re-propose (the marker blocks it).

## Gotchas (inferred)

- Seeded eval bookings must be named `mb-demo-*` or I-1 reports them as agent-made.
- `memory_fact.service` is only for `preferred_provider`; forgetting it without naming a service matches any.
