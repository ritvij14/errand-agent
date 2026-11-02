# Submission Checklist

> One row per graded deliverable (`docs/problem-statement.md`): the artifact, its path, and the condition that makes it acceptable. Tick only when the artifact exists and the check passes. U40 (build plan) confirms the final state.

| #   | Deliverable                                     | Artifact                                                  | Acceptance check                                                                                                                                                                                                                   | Status |
| --- | ----------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Code + README that runs in ≤ 3 commands         | repo root `README.md`                                     | Fresh clone + README's commands → `npm test` green (U38)                                                                                                                                                                           | ☐      |
| 2   | 2-page design note (incl. the 100× paragraph)   | `docs/design-note.md`                                     | ≤ ~1,000 words; state model, approval enforcement, idempotency/recovery, memory, observability, 100× section; every claim matches code + evals (U39)                                                                               | ☐      |
| 3   | Eval table                                      | `docs/evals/eval-table.md` (committed)                    | Every row pass, run date + commit + seed at top; ≥ 15 scenarios covering the brief's 8 must-cover categories incl. injection, timeout-after-success, slot conflict, repeated confirmation, memory, restart, limit exhaustion (U36) | ✅     |
| 4   | Three real bugs, each with a regression test    | `docs/bugs.md`                                            | 3 entries, each with a linked, passing regression test (U40)                                                                                                                                                                       | ☐      |
| 5   | One end-to-end trace with timeout-after-success | `traces/<run id>.json` (exported from a real dev-app run) | File exists; contains `book` → timeout then `get_booking_status` → `booked`; committed alongside the submission per U37 — `traces/5993634e-0780-4a50-9882-c56114f26e3d.json`                                                       | ✅     |
| 6   | 3–5 min recorded demo                           | recording link (operator)                                 | Shows chat + trace side by side: one complete booking, a live handled failure, the timeout-after-success from deliverable 5 (script from U40)                                                                                      | ☐      |

Notes:

- The demo's forced failure uses the dev-only forced-outcome knob (2.5.4 settings, U37) — never in evals.
- Manual browser QA (operator, after U37): the U40 checklist covers every page feature from U14, U26, U31, U34, U35.
