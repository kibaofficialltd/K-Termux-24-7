#!/data/data/com.termux/files/usr/bin/env bash
# KIBA 24/7 - backup database + configs
cd "$(dirname "$0")"
mkdir -p data/backups
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="data/backups/kiba-full-$STAMP.tar.gz"
tar -czf "$OUT" data/kiba.db* data/credentials.txt .env 2>/dev/null || tar -czf "$OUT" data/kiba.db* 2>/dev/null
echo "Backup created: $OUT"
# keep last 10 full backups
ls -1t data/backups/kiba-full-*.tar.gz 2>/dev/null | tail -n +11 | xargs -r rm -f
