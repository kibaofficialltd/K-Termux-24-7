#!/data/data/com.termux/files/usr/bin/env bash
# K Termux 24/7 - stop the server gracefully
cd "$(dirname "$0")"
PIDFILE=data/k-termux.pid
if [ ! -f "$PIDFILE" ]; then echo "Not running (no pidfile)."; exit 0; fi
PID=$(cat "$PIDFILE" 2>/dev/null || true)
if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
  rm -f "$PIDFILE"; echo "Not running (stale pidfile removed)."; exit 0
fi
kill "$PID" 2>/dev/null || true
for i in $(seq 1 20); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.5
done
if kill -0 "$PID" 2>/dev/null; then
  echo "Force killing $PID..."
  kill -9 "$PID" 2>/dev/null || true
fi
rm -f "$PIDFILE"
termux-wake-unlock 2>/dev/null || true
echo "K Termux 24/7 stopped."
