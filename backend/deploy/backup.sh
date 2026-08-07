#!/usr/bin/env bash
# Nightly SQLite backup for the shared team.db (audit: "no automated DB backups").
# Uses SQLite's online .backup (safe while the service is running / WAL mode),
# writes a timestamped copy, and prunes to the most recent N.
#
# Install on the VPS (as root or appuser with write access to data/):
#   chmod +x /opt/v1-agent/backend/deploy/backup.sh
#   crontab -e   # add the line below to run at 02:30 daily:
#   30 2 * * * /opt/v1-agent/backend/deploy/backup.sh >> /opt/v1-agent/backend/data/backups/backup.log 2>&1
#
# Restore is just: stop the service, copy a chosen backup over data/team.db, start it.
set -euo pipefail

DB="${DB_PATH:-/opt/v1-agent/backend/data/team.db}"
BACKUP_DIR="${BACKUP_DIR:-$(dirname "$DB")/backups}"
KEEP="${KEEP:-14}"

mkdir -p "$BACKUP_DIR"

if [ ! -f "$DB" ]; then
  echo "$(date -Is) no database at $DB — nothing to back up"
  exit 0
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/team-$STAMP.db"

# Online backup — consistent snapshot even with the app running (WAL).
sqlite3 "$DB" ".backup '$OUT'"
gzip -f "$OUT"
echo "$(date -Is) backed up -> ${OUT}.gz"

# Prune: keep the newest $KEEP compressed backups.
ls -1t "$BACKUP_DIR"/team-*.db.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
