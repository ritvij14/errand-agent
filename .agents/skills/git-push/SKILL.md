---
name: git-push
description: Stage all changes, create a gitmoji commit with LLM-generated message, and push to current branch. Stops if push fails or branch is behind remote.
allowed-tools: Bash(git:*), Read
---

1. Run `git fetch origin` then check if local branch is behind remote — if so, stop and tell the user.
2. Run `git add .`
3. Run `git diff --stat --staged` for a file-level summary.
4. Based on the stat and your memory of the changes, pick an appropriate gitmoji, write a concise commit header (max 72 chars) and short body.
5. Run `git commit -m "<gitmoji> <header>" -m "<body>"`
6. Run `git push origin $(git branch --show-current)` — if it fails, stop and report the error. Do not retry.
