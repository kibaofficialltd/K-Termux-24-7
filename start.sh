#!/data/data/com.termux/files/usr/bin/env bash
# K Termux 24/7 - start the server in the background
set -e
cd "$(dirname "$0")"

PIDFILE=data/k-termux.pid
if [ -f "$PIDFILE" ]; then
  OLD=$(cat "$PIDFILE" 2>/dev/null || true)
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then
    echo "K Termux already running (pid $OLD). Use restart.sh or stop.sh."
    exit 0
  fi
  rm -f "$PIDFILE"
fi

mkdir -p data/logs
termux-wake-lock 2>/dev/null || true
printf "\n\033[1;38;5;208m★ KIBA OFFICIAL ★ K Termux 24/7 starting...\033[0m\n"
nohup node src/index.js >> data/logs/k-termux-server.out 2>&1 &
echo $! > "$PIDFILE"
echo "K Termux 24/7 started (pid $(cat "$PIDFILE")). Dashboard: http://127.0.0.1:${KTERMUX_PORT:-7777}/"
