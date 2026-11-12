#!/data/data/com.termux/files/usr/bin/env bash
# KIBA 24/7 - install Termux:Boot autostart script
# Requires the Termux:Boot app (install it once and open it at least once).
cd "$(dirname "$0")"
BOOTDIR="$HOME/.termux/boot"
if [ ! -d "$BOOTDIR" ]; then
  echo "Termux:Boot not detected ($BOOTDIR missing)."
  echo "1) Install the 'Termux:Boot' app (F-Droid/GitHub, same source as Termux)"
  echo "2) Open it once, then re-run this script."
  exit 1
fi
mkdir -p "$BOOTDIR"
cat > "$BOOTDIR/kiba-24-7.sh" <<EOF
#!/data/data/com.termux/files/usr/bin/env bash
termux-wake-lock
cd "$(pwd)"
bash start.sh
EOF
chmod +x "$BOOTDIR/kiba-24-7.sh"
echo "Boot script installed: $BOOTDIR/kiba-24-7.sh"
echo "KIBA will start after device reboot (requires Termux:Boot app installed + opened once)."
