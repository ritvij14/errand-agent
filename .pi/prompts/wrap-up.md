---
description: End-of-session wrap-up. Complete doc review before closing the session.
---

Complete the following in order:

1. **Documentation review** — only if `.pi/session-changed` exists (files were modified this session):

   a. List every file edited or created this session.

   b. For each changed file, identify which feature it belongs to and open the corresponding doc in `docs/features/`. Update it with:
   - **What** changed (brief description)
   - **Why** it changed (the motivation or problem being solved)
   - **How** it was implemented (key decisions, patterns used, anything non-obvious)

   c. If any architectural decision was made (technology choice, pattern adoption, structural change), add an entry to `docs/infra/decisions.md` with full reasoning.

   d. Run: `rm -f .pi/session-changed` to clear the review requirement.

2. Confirm: "Session wrapped. Docs updated: [list]."
