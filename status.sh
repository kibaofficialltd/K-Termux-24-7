#!/data/data/com.termux/files/usr/bin/env bash
cd "$(dirname "$0")"
PIDFILE=data/k-termux.pid
PORT="${KTERMUX_PORT:-7777}"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "Process: running (pid $(cat "$PIDFILE"))"
else
  echo "Process: NOT running"
fi
if curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null; then
  echo ""
  echo "API: responding on port $PORT"
else
  echo "API: no response on port $PORT"
fi
echo "Recent log:"
tail -n 5 data/logs/k-termux-server.log 2>/dev/null || true
