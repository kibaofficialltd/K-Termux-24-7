#!/data/data/com.termux/files/usr/bin/env bash
# KIBA 24/7 - start the server in the background
set -e
cd "$(dirname "$0")"

PIDFILE=data/kiba.pid
if [ -f "$PIDFILE" ]; then
  OLD=$(cat "$PIDFILE" 2>/dev/null || true)
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then
    echo "KIBA already running (pid $OLD). Use restart.sh or stop.sh."
    exit 0
  fi
  rm -f "$PIDFILE"
fi

mkdir -p data/logs
termux-wake-lock 2>/dev/null || true
nohup node src/index.js >> data/logs/kiba-server.out 2>&1 &
echo $! > "$PIDFILE"
echo "KIBA 24/7 started (pid $(cat "$PIDFILE")). Dashboard: http://127.0.0.1:${KIBA_PORT:-7777}/"
