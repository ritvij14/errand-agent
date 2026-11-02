#!/usr/bin/env bash
# Verify harness, optional step: restart the dev servers on a FRESH database. The db
# lives under server/data/ (git-ignored); it is wiped only while nothing is running,
# then the harness starts again — never delete files under a live process.
set -eu
cd "$(dirname "$0")/.."

npm run verify:down >/dev/null 2>&1 || true
rm -rf server/data
mkdir -p server/data
npm run verify:up