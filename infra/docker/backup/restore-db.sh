#!/usr/bin/env bash
# Replaces the database with a dump (OPS-01): used by update.sh to roll back, and for disaster
# recovery from a restic restore.
#
#   restore-db.sh --dump FILE [--globals FILE]
#
# Stop web and worker first. Roles from --globals are created if missing (existing ones are kept).
# The target is $PGDATABASE (default $POSTGRES_DB). The old database is dropped first and the
# dump is restored in one transaction, so only run this when rolling back to a known-good dump.
set -euo pipefail

dump=
globals=
while [ $# -gt 0 ]; do
  case $1 in
    --dump) dump=${2:?}; shift 2 ;;
    --globals) globals=${2:?}; shift 2 ;;
    *) echo "restore-db: unknown argument $1" >&2; exit 64 ;;
  esac
done
[ -s "$dump" ] || { echo "restore-db: dump not found: $dump" >&2; exit 1; }
db=${PGDATABASE:-${POSTGRES_DB:-hmis}}

if [ -n "$globals" ]; then
  # Roles that already exist raise errors; that is expected and harmless.
  psql -d postgres -v ON_ERROR_STOP=0 -q -f "$globals" >/dev/null 2>&1 || true
fi

psql -d postgres -Atqc "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$db' and pid <> pg_backend_pid()" >/dev/null
dropdb --maintenance-db=postgres --if-exists "$db"
createdb --maintenance-db=postgres "$db"
if ! pg_restore -d "$db" --exit-on-error --single-transaction --no-owner "$dump"; then
  echo "restore-db: pg_restore failed" >&2
  exit 1
fi
echo "restore-db: restored $db from $dump" >&2
