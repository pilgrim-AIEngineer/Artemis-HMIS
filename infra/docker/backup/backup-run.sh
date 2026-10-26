#!/usr/bin/env bash
# One backup run (OPS-01, docs/31 §3).
#
#   backup-run.sh [--kind full|db] [--tag TAG] [--save-as NAME]
#
# - Dumps the database (pg_dump -Fc + roles) into $BACKUP_DIR/staging and records row counts.
# - Pushes the dump (and, for --kind full, $FILES_DIR) to every enabled restic repository:
#     local  $BACKUP_DIR/restic          always
#     usb    $USB_DIR/restic             when BACKUP_USB_ENABLED=1 and the disk's marker file exists
#     s3     $BACKUP_S3_REPOSITORY       when set (S3-compatible; credentials in AWS_* env)
# - Writes $BACKUP_DIR/status/status.json (read by /api/health and the ops.backupCheck job).
# - --save-as NAME keeps a copy of this run's dump in $BACKUP_DIR/NAME/ (used by update.sh).
#
# Exit codes: 0 ok, 1 dump or local backup failed, 2 only USB/S3 failed (recorded in status),
# 3 another run holds the lock. Secrets only come from the environment, never from arguments.
set -uo pipefail

BACKUP_DIR=${BACKUP_DIR:-/backup}
FILES_DIR=${FILES_DIR:-/data/files}
USB_DIR=${USB_DIR:-/usb}
STAGING=$BACKUP_DIR/staging
STATUS_DIR=$BACKUP_DIR/status
STATUS_FILE=$STATUS_DIR/status.json
LOCK_WAIT=${BACKUP_LOCK_WAIT:-900}
KEEP_ARGS=(--keep-hourly "${BACKUP_KEEP_HOURLY:-48}" --keep-daily "${BACKUP_KEEP_DAILY:-14}"
  --keep-weekly "${BACKUP_KEEP_WEEKLY:-8}" --keep-monthly "${BACKUP_KEEP_MONTHLY:-12}")
# Business tables whose counts the restore drill compares (append-only in this product: rule 4).
TABLES=${BACKUP_MANIFEST_TABLES:-"patient encounter bill payment number_series audit_log document message_outbox app_user"}

kind=full
tag=
save_as=
while [ $# -gt 0 ]; do
  case $1 in
    --kind) kind=${2:?}; shift 2 ;;
    --tag) tag=${2:?}; shift 2 ;;
    --save-as) save_as=${2:?}; shift 2 ;;
    *) echo "backup-run: unknown argument $1" >&2; exit 64 ;;
  esac
done
case $kind in full | db) ;; *) echo "backup-run: --kind must be full or db" >&2; exit 64 ;; esac
case $save_as in '' | *[!A-Za-z0-9._-]*) [ -z "$save_as" ] || { echo "backup-run: bad --save-as" >&2; exit 64; } ;; esac

if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
  echo "backup-run: BACKUP_PASSPHRASE is not set; refusing to create unencrypted backups" >&2
  exit 1
fi
export RESTIC_PASSWORD=$BACKUP_PASSPHRASE
export RESTIC_CACHE_DIR=${RESTIC_CACHE_DIR:-$BACKUP_DIR/.restic-cache}

log() { printf '%s backup-run: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

mkdir -p "$STAGING" "$STATUS_DIR"
exec 9>"$BACKUP_DIR/run.lock"
if ! flock -w "$LOCK_WAIT" 9; then
  log "another backup run holds the lock"
  exit 3
fi

# ---- status file ---------------------------------------------------------------------------
[ -s "$STATUS_FILE" ] && jq -e . "$STATUS_FILE" >/dev/null 2>&1 || echo '{"version":1,"updatedAt":null,"targets":{}}' >"$STATUS_FILE"

# Short, single-line, no URLs (they can carry bucket names): shown on the public health endpoint.
sanitize() { tr '\n' ' ' | sed -E 's#[a-zA-Z0-9+.-]+://[^ ]+#<url>#g; s/  +/ /g' | cut -c1-200; }

# status_set TARGET DB_OK FILES_OK ERROR SNAPSHOT
status_set() {
  local tmp="$STATUS_FILE.tmp.$$"
  jq --arg n "$1" --arg now "$(now_iso)" --argjson db "$2" --argjson files "$3" \
    --arg err "$4" --arg snap "$5" '
    .version = 1 | .updatedAt = $now |
    .targets[$n] = ((.targets[$n] // {lastAttemptAt: null, lastDbSuccessAt: null,
        lastFilesSuccessAt: null, lastError: null, snapshotId: null})
      | .lastAttemptAt = $now
      | (if $db then .lastDbSuccessAt = $now else . end)
      | (if $files then .lastFilesSuccessAt = $now else . end)
      | .lastError = (if $err == "" then null else $err end)
      | (if $snap != "" then .snapshotId = $snap else . end))' \
    "$STATUS_FILE" >"$tmp" && mv "$tmp" "$STATUS_FILE"
}

# usb_disk TARGET_STATE_JQ: sets diskId; a different disk than last time resets the rotation clock.
usb_disk() {
  local id=$1 tmp="$STATUS_FILE.tmp.$$"
  jq --arg id "$id" --arg now "$(now_iso)" '
    .targets.usb as $u |
    if ($u.diskId // "") != $id then
      .targets.usb = ($u + {diskId: $id, diskSwappedAt: $now, lastDbSuccessAt: null,
        lastFilesSuccessAt: null, snapshotId: null})
    else . end' "$STATUS_FILE" >"$tmp" && mv "$tmp" "$STATUS_FILE"
}

enabled_targets() {
  echo local
  [ "${BACKUP_USB_ENABLED:-0}" = 1 ] && echo usb
  [ -n "${BACKUP_S3_REPOSITORY:-}" ] && echo s3
  return 0
}

fail_all() {
  local msg
  msg=$(printf '%s' "$1" | sanitize)
  local t
  for t in $(enabled_targets); do
    status_set "$t" false false "$msg" ""
  done
}

# ---- dump ----------------------------------------------------------------------------------
count_tables() { # prints "table count" per existing table
  local t
  for t in $TABLES; do
    if [ "$(psql -Atqc "select to_regclass('public.$t') is not null" 2>/dev/null)" = t ]; then
      echo "$t $(psql -Atqc "select count(*) from public.$t")"
    fi
  done
}

last_bill() {
  psql -Atqc "select number from public.bill where number is not null order by created_at desc, id desc limit 1" 2>/dev/null || true
}

log "starting $kind run"
started=$(now_iso)
before=$(count_tables) || before=
bill_before=$(last_bill)

if ! pg_dump -Fc -f "$STAGING/hmis.dump.tmp" 2>"$STAGING/pg_dump.err"; then
  err=$(sanitize <"$STAGING/pg_dump.err")
  log "pg_dump failed: $err"
  fail_all "pg_dump failed: $err"
  exit 1
fi
if ! pg_dumpall --globals-only -f "$STAGING/globals.sql.tmp" 2>"$STAGING/pg_dump.err"; then
  err=$(sanitize <"$STAGING/pg_dump.err")
  log "pg_dumpall failed: $err"
  fail_all "pg_dumpall failed: $err"
  exit 1
fi
after=$(count_tables) || after=

# Manifest the restore drill checks: counts before and after the dump bracket what the dump holds.
tables_json=$(
  jq -Rn --arg b "$before" --arg a "$after" '
    def parse($s): [$s | split("\n")[] | select(length > 0) | split(" ") | {key: .[0], value: (.[1] | tonumber)}] | from_entries;
    parse($b) as $bb | parse($a) as $aa
    | [$bb | keys[] | {key: ., value: {before: $bb[.], after: ($aa[.] // $bb[.])}}] | from_entries'
)
jq -n --arg started "$started" --arg finished "$(now_iso)" --arg kind "$kind" --arg bill "$bill_before" \
  --argjson tables "$tables_json" \
  '{createdAt: $finished, startedAt: $started, kind: $kind, lastBillNumber: (if $bill == "" then null else $bill end), tables: $tables}' \
  >"$STAGING/manifest.json.tmp" \
  && mv "$STAGING/hmis.dump.tmp" "$STAGING/hmis.dump" \
  && mv "$STAGING/globals.sql.tmp" "$STAGING/globals.sql" \
  && mv "$STAGING/manifest.json.tmp" "$STAGING/manifest.json" \
  || { log "could not write the dump files"; fail_all "could not write the dump files"; exit 1; }
rm -f "$STAGING/pg_dump.err"
log "dump done ($(stat -c %s "$STAGING/hmis.dump") bytes)"

if [ -n "$save_as" ]; then
  rm -rf "${BACKUP_DIR:?}/$save_as"
  mkdir -p "$BACKUP_DIR/$save_as"
  cp "$STAGING/hmis.dump" "$STAGING/globals.sql" "$STAGING/manifest.json" "$BACKUP_DIR/$save_as/"
fi

# ---- restic --------------------------------------------------------------------------------
repo_for() {
  case $1 in
    local) echo "$BACKUP_DIR/restic" ;;
    usb) echo "$USB_DIR/restic" ;;
    s3) echo "$BACKUP_S3_REPOSITORY" ;;
  esac
}

backup_target() { # sets $err and $snap
  local name=$1 repo out
  repo=$(repo_for "$name")
  export RESTIC_REPOSITORY=$repo
  err=
  snap=
  if ! restic cat config >/dev/null 2>"$STAGING/restic.err"; then
    if ! restic init >/dev/null 2>"$STAGING/restic.err"; then
      err="repository init failed: $(sanitize <"$STAGING/restic.err")"
      return 1
    fi
  fi
  local paths=("$STAGING")
  if [ "$kind" = full ] && [ -d "$FILES_DIR" ]; then paths+=("$FILES_DIR"); fi
  local tags=(--tag hmis --tag "$kind")
  [ -n "$tag" ] && tags+=(--tag "$tag")
  if ! out=$(restic backup --json --host hmis "${tags[@]}" "${paths[@]}" 2>"$STAGING/restic.err"); then
    err="restic backup failed: $(sanitize <"$STAGING/restic.err")"
    return 1
  fi
  snap=$(printf '%s\n' "$out" | jq -r 'select(.message_type == "summary") | .snapshot_id // empty' 2>/dev/null | tail -n1)
  # Weekly housekeeping on full runs: retention + metadata integrity check (non-fatal, except check).
  if [ "$kind" = full ] && [ "$(date +%w)" = 0 ]; then
    restic forget --prune --tag hmis "${KEEP_ARGS[@]}" >/dev/null 2>"$STAGING/restic.err" \
      || log "retention failed on $name: $(sanitize <"$STAGING/restic.err")"
    if ! restic check >/dev/null 2>"$STAGING/restic.err"; then
      err="restic check failed: $(sanitize <"$STAGING/restic.err")"
      return 1
    fi
  fi
  return 0
}

rc=0
for t in $(enabled_targets); do
  if [ "$t" = usb ]; then
    if [ ! -f "$USB_DIR/.hmis-backup-disk" ]; then
      status_set usb false false "usb backup disk not mounted" ""
      log "usb: disk not present"
      [ $rc -eq 0 ] && rc=2
      continue
    fi
    usb_disk "$(head -c 100 "$USB_DIR/.hmis-backup-disk" | tr -d '\n\r ')"
  fi
  if backup_target "$t"; then
    files_ok=false
    [ "$kind" = full ] && files_ok=true
    status_set "$t" true "$files_ok" "" "$snap"
    log "$t: ok ${snap:+(snapshot $snap)}"
  else
    status_set "$t" false false "$err" ""
    log "$t: FAILED: $err"
    if [ "$t" = local ]; then rc=1; elif [ $rc -eq 0 ]; then rc=2; fi
  fi
done
rm -f "$STAGING/restic.err"
exit $rc
