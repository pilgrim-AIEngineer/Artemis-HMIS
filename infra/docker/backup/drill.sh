#!/usr/bin/env bash
# Restore drill, runs INSIDE the backup image (OPS-01, docs/31 §3); use infra/scripts/restore-drill.sh.
#
# Restores the newest snapshot of $RESTIC_REPOSITORY into a throwaway Postgres started inside this
# container, then checks the restored data against the manifest written at backup time:
#   restic check; every manifest table has before <= restored rows <= after (data is append-only);
#   the last bill number exists; restored files are present. Prints one JSON result on stdout
#   (logs go to stderr). Exit 0 = every check passed. Needs RESTIC_PASSWORD and runs as root
#   (initdb itself runs as the postgres user).
set -uo pipefail

: "${RESTIC_REPOSITORY:?set RESTIC_REPOSITORY}"
: "${RESTIC_PASSWORD:?set RESTIC_PASSWORD}"
PGBIN=$(find /usr/lib/postgresql -maxdepth 2 -name bin -type d | sort -V | tail -n1)
export PATH=$PGBIN:$PATH

log() { printf '%s restore-drill: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
work=$(mktemp -d /tmp/drill.XXXXXX)
export RESTIC_CACHE_DIR=$work/cache
chmod 755 "$work"
checks='[]'
add() { # add NAME OK DETAIL
  checks=$(jq -c --arg n "$1" --argjson ok "$2" --arg d "$3" '. + [{name: $n, ok: $ok, detail: $d}]' <<<"$checks")
  log "$1: $([ "$2" = true ] && echo ok || echo FAILED) $3"
}
stop_pg() { gosu postgres pg_ctl -D "$work/pgdata" -m immediate stop >/dev/null 2>&1 || true; }
cleanup() { stop_pg; rm -rf "$work"; }
trap cleanup EXIT

finish() { # finish SNAPSHOT_ID SNAPSHOT_TIME FILES_COUNT TABLES_JSON
  local ok
  ok=$(jq -r 'all(.[]; .ok)' <<<"$checks")
  jq -n --argjson ok "$ok" --arg started "$started" --arg finished "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg snap "${1:-}" --arg snaptime "${2:-}" --argjson files "${3:-0}" \
    --argjson tables "${4:-null}" --argjson checks "$checks" \
    '{ok: $ok, startedAt: $started, finishedAt: $finished, snapshot: {id: $snap, time: $snaptime},
      filesRestored: $files, tables: $tables, checks: $checks}'
  [ "$ok" = true ]
  exit $?
}

# 1. Newest database snapshot.
snap_json=$(restic snapshots --no-lock --json --tag hmis --path /backup/staging 2>"$work/err" | jq -c 'sort_by(.time) | last // empty')
if [ -z "$snap_json" ]; then
  add "snapshot" false "no snapshot found in the repository: $(head -c 200 "$work/err" | tr '\n' ' ')"
  finish
fi
snap_id=$(jq -r '.short_id' <<<"$snap_json")
snap_time=$(jq -r '.time' <<<"$snap_json")
add "snapshot" true "$snap_id from $snap_time"

# 2. Repository integrity (metadata + a 5% sample of the data).
if restic check --no-lock --read-data-subset=5% >"$work/check.out" 2>&1; then
  add "restic_check" true "repository consistent"
else
  add "restic_check" false "$(tail -n 3 "$work/check.out" | tr '\n' ' ' | cut -c1-200)"
fi

# 3. Restore the database snapshot (and the latest files snapshot, if any).
if ! restic restore --no-lock "$(jq -r '.id' <<<"$snap_json")" --target "$work/restore" >/dev/null 2>"$work/err"; then
  add "restore" false "restic restore failed: $(head -c 200 "$work/err" | tr '\n' ' ')"
  finish "$snap_id" "$snap_time"
fi
stage=$work/restore/backup/staging
[ -s "$stage/hmis.dump" ] && [ -s "$stage/manifest.json" ] || {
  add "restore" false "snapshot has no dump or manifest"
  finish "$snap_id" "$snap_time"
}
add "restore" true "dump $(stat -c %s "$stage/hmis.dump") bytes"

files_count=0
files_snap=$(restic snapshots --no-lock --json --tag hmis --path /data/files 2>/dev/null | jq -r 'sort_by(.time) | last | .id // empty')
if [ -n "$files_snap" ]; then
  if restic restore --no-lock "$files_snap" --target "$work/restore-files" --include /data/files >/dev/null 2>"$work/err"; then
    files_count=$(find "$work/restore-files/data/files" -type f 2>/dev/null | wc -l)
    add "files" true "$files_count files restored"
  else
    add "files" false "files restore failed: $(head -c 200 "$work/err" | tr '\n' ' ')"
  fi
else
  add "files" true "no files snapshot in this repository (database-only)"
fi

# 4. Throwaway Postgres inside this container.
chown -R postgres:postgres "$work"
mkdir -p "$work/sock" && chown postgres:postgres "$work/sock"
if ! gosu postgres initdb -D "$work/pgdata" -A trust --no-sync >/dev/null 2>"$work/err" \
  || ! gosu postgres pg_ctl -D "$work/pgdata" -w -t 60 \
    -o "-c listen_addresses='' -c unix_socket_directories=$work/sock -c fsync=off" start >/dev/null 2>>"$work/err"; then
  add "postgres" false "could not start throwaway server: $(head -c 200 "$work/err" | tr '\n' ' ')"
  finish "$snap_id" "$snap_time" "$files_count"
fi
export PGHOST=$work/sock PGUSER=postgres PGDATABASE=hmis_drill
[ -s "$stage/globals.sql" ] && gosu postgres psql -d postgres -q -v ON_ERROR_STOP=0 -f "$stage/globals.sql" >/dev/null 2>&1
gosu postgres createdb --maintenance-db=postgres hmis_drill
if gosu postgres pg_restore -d hmis_drill --exit-on-error --single-transaction --no-owner "$stage/hmis.dump" 2>"$work/err"; then
  add "pg_restore" true "dump restored"
else
  add "pg_restore" false "pg_restore failed: $(head -c 200 "$work/err" | tr '\n' ' ')"
  finish "$snap_id" "$snap_time" "$files_count"
fi
q() { gosu postgres psql -Atqc "$1"; }

# 5. Integrity checks against the manifest.
tables='{}'
bad=0
while read -r name before after; do
  [ -n "$name" ] || continue
  got=$(q "select count(*) from public.$name" 2>/dev/null || echo -1)
  tables=$(jq -c --arg n "$name" --argjson b "$before" --argjson a "$after" --argjson g "$got" \
    '. + {($n): {before: $b, after: $a, restored: $g}}' <<<"$tables")
  if [ "$got" -lt "$before" ] || [ "$got" -gt "$after" ]; then
    bad=$((bad + 1))
    log "table $name: restored $got, expected between $before and $after"
  fi
done < <(jq -r '.tables | to_entries[] | "\(.key) \(.value.before) \(.value.after)"' "$stage/manifest.json")
n_tables=$(jq -r '.tables | length' "$stage/manifest.json")
if [ "$n_tables" -eq 0 ]; then
  add "row_counts" false "manifest lists no tables"
elif [ "$bad" -eq 0 ]; then
  add "row_counts" true "$n_tables tables within the manifest range"
else
  add "row_counts" false "$bad of $n_tables tables outside the manifest range"
fi

bill=$(jq -r '.lastBillNumber // empty' "$stage/manifest.json")
if [ -z "$bill" ]; then
  add "last_bill" true "no finalised bill at backup time"
else
  found=$(q "select count(*) from public.bill where number = '${bill//\'/}'" 2>/dev/null || echo 0)
  if [ "$found" = 1 ]; then add "last_bill" true "bill $bill present"; else add "last_bill" false "bill $bill missing"; fi
fi

finish "$snap_id" "$snap_time" "$files_count" "$tables"
