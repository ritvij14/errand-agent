#!/usr/bin/env bash
# Verify harness, step 1 (see .pi/skills/verify/SKILL.md): start the dev servers, wait
# until they are genuinely usable, and remember the PID of the process *this script
# started* so the matching verify-down.sh tears down exactly that.
set -eu
cd "$(dirname "$0")/.."

# .nvmrc wins: the shell's default node may be older than what the repo pins (crypto.argon2Sync).
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use >/dev/null

STATE=/tmp/errand-verify
mkdir -p "$STATE"
LOG="$STATE/dev.log"

if [ -f "$STATE/pids" ] && kill -0 "$(cat "$STATE/pids")" 2>/dev/null; then
  echo "already running (pid $(cat "$STATE/pids")); run scripts/verify-down.sh first"
  exit 1
fi

npm run dev >"$LOG" 2>&1 &
echo $! >"$STATE/pids"

# Doctor: Express answers, the page is served, sign-in works (3 steps per the skill).
for i in $(seq 1 40); do
  if curl -sf http://localhost:3001/api/health >/dev/null \
    && [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:5173/)" = "200" ] \
    && [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:5173/api/auth/sign-in \
      -H 'Content-Type: application/json' -H 'Sec-Fetch-Site: same-origin' \
      -d '{"username":"alice","password":"demo-password-1"}')" = "200" ]; then
    echo "ready: express + vite + auth up (log: $LOG)"
    exit 0
  fi
  sleep 0.5
done

echo "doctor FAILED after 20 s — express/vite/auth did not come up (log: $LOG)"
exit 1