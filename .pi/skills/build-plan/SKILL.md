---
name: build-plan
description: Decompose work from the design docs into independently verifiable units and drive them autonomously to done. Use for /build-plan, "plan this and build it", "continue the build", or "build the next unit".
---

# Build plan — sequence verifiable units and drive them without blocking

You own the plan and its execution. One unit is one change that ends in state you can check. Never advance to the next unit while the current one is red.

## If a plan already exists

An active plan lives in `docs/plans/*.md`. Resume it instead of re-planning:

1. Read the plan file. Find the first unchecked unit.
2. Prove the baseline is actually green — run the checks named in the previous unit's evidence. Do not trust ticked boxes alone (a box records evidence, the checks are the proof).
3. Continue that unit: tests first, then implementation, then its QA, then tick the box with the evidence pointer, then commit.
4. Do not re-derive or redo completed units. If a ticked unit's behavior is now broken, that is a bug: fix it with a failing regression test first, inside the current unit's commit if related or a separate `fix:` commit.

## Planning a new plan (only when no plan file covers the work)

1. Read, in this order: `AGENTS.md`, `docs/problem-statement.md`, the relevant sections of `docs/system-design.md` and any open `docs/system-design-review-*.md` findings (plus `docs/infra/schema.md`, `docs/infra/api-contracts.md` and `docs/infra/testing.md` when the work touches data, HTTP or tests), and the feature doc(s) listed for the affected modules.
2. Split the work into units. One unit is one change the design can name: a module, an endpoint, a slice of behavior with its own tests. A unit that would need more than ~1 day or touch more than one feature's internals is two units.
3. Order units so each one's tests run against a real, already-green baseline. Dependencies must run before dependents. Settle open design questions (doc-only units) before code. Build a thin end-to-end skeleton and the eval runner early, then add behavior in vertical slices that each bring their own eval scenarios. Deliverable polish comes last.
4. For each unit write: Depends on, Covers (MH / FR / V / review R references), Build (files and behavior), Tests, Evals (scenario ids), QA, You see (one observable result), Docs.
5. Write the plan to `docs/plans/<topic>.md` as a checklist. Present it to the user with the unit count and the first unit. Execution starts on the user's explicit go — once. After that the plan itself is the mandate.

## Unit anatomy (every unit, no exceptions)

1. **Read before change.** The design section, existing code, and `docs/infra/testing.md` if this unit adds tests.
2. **Red.** Write the failing tests first and run them. Confirm each new test fails for the intended reason. For a bug fix, the failing test reproduces the bug first.
3. **Green.** Implement the smallest change that satisfies the tests and the design section. Keep corrections surgical.
4. **Regression gate.** `npm test` (Vitest, then evals once the runner exists), `npm run lint`, and both workspace typechecks green before commit. No skipped or weakened assertions; if a test's expectation changes, the design or old test was wrong — say so in the reply.
5. **Behavior, not implementation.** Every test asserts what a user or caller can observe: returned values, errors, state readable back, effects on other tables or tools. Apply the two-edit test: breaking the behavior must fail the test, refactoring the internals must not. Rewrite or delete tests that only pin implementation.
6. **QA on the real surface.** For user-visible behavior, drive the real app per the `verify` skill and save evidence in `/tmp/verify-<unit>/`. Client units add React Testing Library tests; the manual browser checklist is deferred to the plan's final handoff unit (operator decision, 2026-11-02). A pure module with no runtime surface says so — its tests are the proof. Tests alone are not unit verification.
7. **Docs.** Create or update the feature doc in `docs/features/` if new behavior shipped, and refresh anything it makes stale. A documentation discrepancy is urgent — fix docs before moving on. Log any real bug hit in `docs/bugs.md` the moment it is fixed (deliverable 4).
8. **Commit.** Conventional commits, one commit per unit (or a few clean sequential ones that each pass tests).
9. **Tick.** Mark the plan box `[x]` with the evidence pointer (commit sha, test file, artifact path).

## Autonomy rules while executing a plan

- **Proceed, then present.** Reversible execution questions do not stop the run. Decide, act, and put the decision plus its reasoning in the unit's reply. This overrides the "ask MCQs when not sure" convention inside an executed plan.
- **Pause only for:** genuine product or preference calls no design section or reading settles (e.g. an ambiguity where the design says "pick a reasonable reading and write it down" — pick is allowed; only real product forks stop), irreversible or destructive actions, and contradictions between the brief and the design (report, do not reinterpret).
- **Ambiguity protocol.** If the design left a choice open, pick a reasonable reading, write it down in the design doc's readings table (or the unit's reply), and cover it with a test. The design's V-1…V-12 table is the template.
- **Failure protocol.** A test that stays red after a focused fix: re-read the design section, check assumptions, try the corrected fix. After three distinct approaches on one unit, stop and report the diagnosis and the three attempts — do not loop, do not weaken tests.
- **State every turn.** Which unit is in progress, what passed, what is next.

## Reply contract

Per unit: what shipped (module/endpoint/behavior), the proof (tests red→green counts, QA evidence, commit sha), design decisions taken under the ambiguity protocol, and the next unit by name. Per plan run: units done / remaining.