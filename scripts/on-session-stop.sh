#!/bin/bash
ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT_DIR" || exit 1

FLAG_FILE=".pi/session-changed"
[ ! -f "$FLAG_FILE" ] && exit 0

{
echo "=== changed files ==="
git status --short
echo "Run the end-of-session wrap-up if significant source changes need documenting. Skip if trivial, but always rm -f .pi/session-changed."
} >&2
exit 2
