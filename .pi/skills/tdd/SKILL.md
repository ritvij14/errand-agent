---
name: tdd
description: Bug-fix TDD loop with red-evidence discipline. Use when fixing a bug, writing a regression test, or when a fix must be proven failing-first.
---

# TDD bug fix

Make the broken behavior executable before changing production code. AGENTS.md mandates this for every bug fix; this skill is the loop.

## Workflow

1. **Understand the bug.** Intended behavior, current behavior, affected path, smallest observable reproduction — from the design section and the failing report, not from memory of the code.
2. **Pick the narrowest executable check.** Prefer the closest test already covering that path (unit → integration → flow). Do not build new harness machinery for a small fix; if no practical test path exists, use the closest useful verification instead (targeted script, HTTP drive per the `verify` skill, log assertion) and say so.
3. **Write the failing test first.** Smallest test that would have caught the bug — it encodes intended behavior, not current behavior. Assert observable behavior per the Testing section (two-edit test).
4. **Run it before fixing.** Confirm it fails *for the intended reason* (message names the broken behavior, not an unrelated import or setup error). If it passes, or fails for another reason, fix the test or the reproduction first — never proceed to the implementation fix.
5. **Fix.** Smallest production change that satisfies intended behavior and nearby contracts. Trace the root cause first (the symptom's source, not its surface) — a guard is a fix only for a state that legitimately occurs.
6. **Rerun.** The regression test passes; `npm test` stays green.

## Guardrails

- Never weaken an existing assertion unless the expected behavior genuinely changed — and say so with the reason in the reply.
- Do not change tests to match a wrong implementation.
- Keep the regression test focused; no unrelated fixture churn or coverage rides along.
- Flaky reproduction → make it deterministic (forced outcomes, controllable clock — never real sleeps) and record what signal is locked down.

## Reply contract — report evidence, not outcome

- The failing-before test (name + file) and the failure it produced.
- The passing-after run and any nearby validation performed.
- If failing-before could not be demonstrated (e.g. UI-only defect), why, and the closest executable regression check used instead.

Prefer no new test over a bad test. A bad test mostly tests mocks, encodes implementation details, depends on timing or unrelated global state, or would be deleted right after proving the fix.