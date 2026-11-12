#!/data/data/com.termux/files/usr/bin/env bash
# K Termux 24/7 - keep the phone awake for exactly N seconds
# Usage:
#   bash wake.sh 60         -> awake for 1 minute
#   bash wake.sh 3600       -> awake for 1 hour
#   bash wake.sh 86400      -> awake for 1 day
#   bash wake.sh 2592000    -> awake for 30 days (max: 2678400 = 31 days)
#   bash wake.sh cancel     -> cancel the timer and unlock now
cd "$(dirname "$0")"
PORT="${KTERMUX_PORT:-7777}"

if [ "$1" = "cancel" ]; then
  if curl -sf -X POST "http://127.0.0.1:$PORT/api/wake/cancel" -H 'Content-Type: application/json' -d '{}' >/dev/null 2>&1; then
    echo "Wake timer cancelled - phone can sleep normally now."
    exit 0
  fi
  termux-wake-unlock 2>/dev/null && echo "Wake lock released (manual mode)."
  exit 0
fi

SEC="${1:-3600}"
if ! echo "$SEC" | grep -qE '^[0-9]+$'; then
  echo "Usage: bash wake.sh <seconds> | cancel"
  echo "Examples: 60 = 1 min | 3600 = 1 hour | 86400 = 1 day | 2592000 = 30 days"
  echo "Max: 2678400 (31 days)"
  exit 1
fi

if curl -sf -X POST "http://127.0.0.1:$PORT/api/wake" -H 'Content-Type: application/json' -d "{\"seconds\":$SEC}" 2>/dev/null; then
  exit 0
fi

# Server not running -> fallback: indefinite wake lock (no auto-unlock)
termux-wake-lock 2>/dev/null && echo "Server not running - wake lock taken WITHOUT a timer."
echo "Start the server first (bash start.sh) to use timed wake."
