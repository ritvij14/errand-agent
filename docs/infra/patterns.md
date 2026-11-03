# Patterns

> **Living catalogue of how recurring problems are solved in this codebase.**
> This is different from `decisions.md` (which records _why_ things were built a certain way)
> and different from conventions in AGENTS.md (which are rules).
> This is _how_ — with actual code examples from this codebase.
>
> **When to add a pattern:**
>
> - You solve the same class of problem for the second time
> - You spend more than 10 minutes figuring out the right way to do something
> - A code review surfaces "this should be done like X" — write X down here
>
> **When NOT to add a pattern:**
>
> - One-off solutions specific to a single feature
> - Things already covered by the conventions in AGENTS.md
> - Generic programming patterns not specific to this codebase
>
> Last updated: [YYYY-MM-DD]

---

## Index

- [Cross-Feature Access](#cross-feature-access) — How to access another feature's data or logic without breaking module boundaries
- [Two Clocks and Seeded Chance](#two-clocks-and-seeded-chance) — How time and randomness are injected and kept separate

---

## Cross-Feature Access

**Problem this solves:**
Feature A needs data or logic from Feature B. Without a convention, imports reach into internal files, creating tight coupling that makes both features hard to change independently.

**When to use it:**
Any time you need to access another feature's types, data, or functions from outside that feature.

**When NOT to use it:**
Within the same feature — internal imports are fine.

**Implementation:**

```typescript
// Each feature exposes a public API via its index/barrel file:
// src/[feature]/index.ts

// ✅ Correct — import from the public API
import { getUserById } from "@/users";

// ❌ Wrong — reaching into internal files
import { getUserById } from "@/users/services/user.service";
```

**Key things to note:**

- If the feature doesn't have an index.ts / barrel file, create one before importing
- Only export what other features actually need — keep the public surface small
- This is enforced as a convention in AGENTS.md Section 4 (Conventions → Module Boundaries)

**Example usage in this codebase:**
[Add when first cross-feature import is created]

---

## [Pattern Name — e.g. Paginated List Query]

**Problem this solves:**
[One sentence — what recurring situation requires this pattern]

**When to use it:**
[The specific conditions under which this pattern applies]

**When NOT to use it:**
[Any cases where this looks applicable but isn't]

**Implementation:**

```typescript
// Actual code from this codebase, not pseudocode
// Copy this and adapt — don't reinvent it
[code];
```

**Key things to note:**

- [Non-obvious detail about this implementation]
- [A gotcha — something that will break if you miss it]
- [Why it's done this way rather than the obvious alternative]

**Example usage in this codebase:**
`src/[feature]/[file].ts` — [brief description of where this is used]

---

## [Pattern Name — e.g. Background Job with Retry]

**Problem this solves:**
[One sentence]

**When to use it:**
[Conditions]

**When NOT to use it:**
[Exceptions]

**Implementation:**

```typescript
[code];
```

**Key things to note:**

- [Detail]
- [Gotcha]

**Example usage in this codebase:**
`src/[feature]/[file].ts`

---

<!-- Add new patterns below as they emerge -->
<!-- Minimum bar: if you had to figure it out once, write it down so nobody has to figure it out again -->

## Two Clocks and Seeded Chance

**Problem this solves:**
The system must be offline-reproducible (NFR-4, NFR-7) yet also prove a real hard deadline (R8) — one clock can't do both jobs honestly.

**The two clocks, kept separate:**

- **Calendar clock** — `server/src/shared/clock.ts` (`createClock`). Real time by default — and then always real time: `setNow` / `advanceMs` are ignored, so simulated pauses never push the app ahead (B14). Created with a fixed `now` (tests and evals), it stays fixed and `setNow` / `advanceMs` move it. Everything calendar-shaped goes through it: slots, hold expiry, timestamps (unix milliseconds, R11), trace `clock_at`.
- **Elapsed timer** — `server/src/shared/elapsed.ts` (`createElapsed`). Monotonic since start (real or injected tick). Only run deadlines and durations. Clock-advance can never satisfy a cap, and a simulated pause can never hide real elapsed time (`clock_at` jumps, `duration_ms` stays near 0).

**Seeded chance** — `server/src/shared/random.ts` (`randomDraw`): one draw = hash of `seed | tool | inputs... | attempt`, so adding any call anywhere never shifts another call's outcome, and still, a retry (new attempt number) can draw a different outcome than its first try (otherwise a timed-out call would time out forever).

**When to use it:** every place the code needs "now", "how long has this run been going", or a random outcome. Never `Date.now()` or `Math.random()` directly.
