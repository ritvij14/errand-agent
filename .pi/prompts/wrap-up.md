---
description: Review changed documentation before Pi finishes; invoked automatically after edits or manually with /wrap-up.
---

Complete the following in order:

1. **Documentation review** — only if `.pi/session-changed` exists (files were modified this session):

   a. List every file edited or created this session.

   b. For each changed file, review the relevant existing feature doc in `docs/features/` or infrastructure doc in `docs/infra/`. Update documentation only when the change makes it incomplete or inaccurate, recording what changed, why, and non-obvious implementation decisions. For documentation-only changes, review the changed document itself; do not create unrelated feature docs or duplicate the same content elsewhere.

   c. If any architectural decision was made (technology choice, pattern adoption, structural change), add an entry to `docs/infra/decisions.md` with full reasoning.

   d. After all documentation changes and checks are finished, run `rm -f .pi/session-changed` to clear the review requirement. Do not clear it if the review is blocked or incomplete. Make no further file edits after clearing it without reviewing those edits too.

2. Confirm: "Session wrapped. Docs updated: [list]." If existing docs needed no changes, say so. If review could not be completed, report the blocker instead of claiming the session is wrapped.
