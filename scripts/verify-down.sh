#!/usr/bin/env bash
# Verify harness, step 3: tear down exactly the servers verify-up.sh started (the skill
# forbids killing by process name or port scan). Nothing else is touched.
set -eu
STATE=/tmp/errand-verify

if [ ! -f "$STATE/pids" ]; then
  echo "nothing to tear down"
  exit 0
fi

PID="$(cat "$STATE/pids")"
# The stored pid is the shell that ran `npm run dev`; its whole process group (spawned
# concurrently tree: tsx watch + vite) gets TERM, then KILL as the fallback.
PGID="$(ps -o pgid= -p "$PID" | tr -d ' ')"
if [ -n "$PGID" ]; then
  kill -TERM "-$PGID" 2>/dev/null || true
  sleep 1
  kill -KILL "-$PGID" 2>/dev/null || true
fi
rm -f "$STATE/pids"
echo "torn down (was pid $PID, group $PGID)"