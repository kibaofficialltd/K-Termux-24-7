#!/data/data/com.termux/files/usr/bin/env bash
# K Termux 24/7 Ultimate - installer (Termux, no root required)
set -e
cd "$(dirname "$0")"

# 1. Detect Termux
if [ -z "${TERMUX_VERSION:-}" ] && [ ! -d "/data/data/com.termux/files/usr" ]; then
  echo "ERROR: This installer is for Termux on Android."
  echo "Install Termux from F-Droid or GitHub, then run this script inside it."
  exit 1
fi
echo "[1/9] Termux detected: ${TERMUX_VERSION:-unknown}"

# 2. Check / install Node.js
if command -v node >/dev/null 2>&1; then
  echo "[2/9] Node.js found: $(node --version)"
else
  echo "[2/9] Installing Node.js (LTS)..."
  pkg install -y nodejs
fi

NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "WARNING: Node >= 22.5 required (uses built-in SQLite). Trying upgrade..."
  pkg install -y nodejs-lts || true
fi

# 3. Install app dependencies (express + ws only - both pure JS)
echo "[3/9] Installing npm dependencies..."
npm install --no-audit --no-fund

# 4. Create application directories
echo "[4/9] Creating directories..."
mkdir -p data/logs data/backups

# 5. Initialize SQLite + generate secure credentials
echo "[5/9] Initializing database..."
if node src/index.js --check-admin 2>/dev/null; then
  echo "      Admin user already exists - keeping your existing login."
else
  echo ""
  echo "Create your dashboard login (you will use this to sign in):"
  # username
  while true; do
    printf "Username [default: admin]: "
    read -r IN_USER || { echo; echo "No interactive input available. Re-run install.sh in the Termux app."; exit 1; }
    IN_USER="${IN_USER:-admin}"
    if echo "$IN_USER" | grep -qE '^[A-Za-z0-9_-]{3,32}$'; then break; fi
    echo "  Username must be 3-32 characters: letters, numbers, _ or -. Try again."
  done
  # password (hidden input, confirmed twice)
  while true; do
    printf "Password (min 8 characters, input hidden): "
    read -r -s IN_PASS || { echo; echo "No interactive input available. Re-run install.sh in the Termux app."; exit 1; }
    echo
    if [ "${#IN_PASS}" -lt 8 ]; then echo "  Too short - at least 8 characters. Try again."; continue; fi
    printf "Confirm password: "
    read -r -s IN_PASS2 || { echo; echo "No interactive input available. Re-run install.sh in the Termux app."; exit 1; }
    echo
    if [ "$IN_PASS" = "$IN_PASS2" ]; then break; fi
    echo "  Passwords do not match. Try again."
  done
  KTERMUX_ADMIN_USERNAME="$IN_USER" KTERMUX_ADMIN_PASSWORD="$IN_PASS" node src/index.js --init
fi

# 6. Configure startup scripts (Termux:Boot, optional)
if [ -d "$HOME/.termux/boot" ]; then
  bash setup-boot.sh >/dev/null 2>&1 && echo "[6/9] Termux:Boot script installed." || true
else
  echo "[6/9] Termux:Boot not detected (optional). Run: bash setup-boot.sh after installing Termux:Boot"
fi

# 7. Explain Android permissions
echo "[7/9] Android permissions checklist:"
echo "      - Open the Termux app notification and tap 'Acquire wakelock' (or run: termux-wake-lock)"
echo "      - Disable battery optimization for Termux (Android Settings > Apps > Termux > Battery)"
echo "      - Allow 'Run in background' / remove any battery restriction"
echo "      - Install Termux:API app + run: pkg install termux-api (optional, for notifications)"

# 8. Start the dashboard
echo "[8/9] Starting K Termux 24/7..."
bash start.sh

# 9. Verify core modules
sleep 2
echo "[9/9] Verifying..."
if curl -fsS "http://127.0.0.1:7777/api/health" >/dev/null 2>&1; then
  echo ""
  echo "============================================================"
  echo "  K Termux 24/7 Ultimate is running!"
  echo "  Dashboard: http://127.0.0.1:7777/"
  echo "  Credentials: cat data/credentials.txt"
  echo "  Keep-alive: run 'termux-wake-lock' now."
  echo "============================================================"
else
  echo "WARNING: health check did not respond yet. Check: bash status.sh"
  echo "Logs: data/logs/k-termux-server.log"
fi
