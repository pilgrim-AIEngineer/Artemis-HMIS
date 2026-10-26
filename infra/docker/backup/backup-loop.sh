#!/usr/bin/env bash
# Scheduler of the backup container (OPS-01, docs/31 §3):
#   - nightly FULL run (database + /data/files) at BACKUP_AT (hospital time, default 02:00),
#     started late if the container was down at that time;
#   - DB-only run every BACKUP_DB_EVERY_MIN minutes (default 60) so the RPO is bounded between
#     nightly runs. (Continuous WAL archiving arrives with the standby server, OPS-02.)
set -uo pipefail

BACKUP_DIR=${BACKUP_DIR:-/backup}
STATUS_FILE=$BACKUP_DIR/status/status.json
AT=${BACKUP_AT:-02:00}
EVERY=${BACKUP_DB_EVERY_MIN:-60}
RETRY_SECS=600
export TZ=${TZ:-Asia/Kolkata}

log() { printf '%s backup-loop: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
trap 'log "stopping"; exit 0' TERM INT

if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
  log "BACKUP_PASSPHRASE is not set; refusing to run unencrypted backups"
  exit 1
fi

# Day (hospital time) of the last successful full run, from the status file ("" if none).
last_full_day() {
  local ts
  ts=$(jq -r '.targets.local.lastFilesSuccessAt // empty' "$STATUS_FILE" 2>/dev/null) || ts=
  [ -n "$ts" ] && date -d "$ts" +%F 2>/dev/null
  return 0
}

run() { # run KIND
  backup-run.sh --kind "$1"
  local rc=$?
  case $rc in
    0 | 2) return 0 ;;
    *) log "run failed (exit $rc); retry in ${RETRY_SECS}s"; return 1 ;;
  esac
}

last_full=$(last_full_day)
last_db=0
retry_at=0
log "started: full at $AT, db every ${EVERY} min"
while :; do
  now=$(date +%s)
  today=$(date +%F)
  hm=$(date +%H:%M)
  if [ "$now" -ge "$retry_at" ]; then
    if [ -z "$last_full" ] || { [ "$last_full" != "$today" ] && [[ ! "$hm" < "$AT" ]]; }; then
      if run full; then last_full=$today; last_db=$now; else retry_at=$((now + RETRY_SECS)); fi
    elif [ $((now - last_db)) -ge $((EVERY * 60)) ]; then
      if run db; then last_db=$now; else retry_at=$((now + RETRY_SECS)); fi
    fi
  fi
  sleep 30 &
  wait $!
done
