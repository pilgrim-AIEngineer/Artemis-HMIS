#!/usr/bin/env bash
# Update to a release (OPS-01, docs/31 §4):
#
#   infra/scripts/update.sh <version> [--force] [--dry-run]     e.g. v2026.10.26.1
#
# 1. Refuses 08:00-15:00 hospital time unless --force.
# 2. Takes a full backup (also kept as /backup/pre-update inside the backup volume). Aborts if the
#    local backup fails: nothing has changed yet.
# 3. Pulls the new images (aborts on failure, nothing has changed).
# 4. Stops web and worker, applies migrations (the migrator applies the pending ones in one
#    transaction), starts the new containers and waits for /api/health.
# 5. On any failure after step 3: puts the previous version back, and if migrations were started,
#    restores the database from the pre-update backup. Exit 1 = rolled back; exit 2 = rollback
#    itself failed (manual recovery, see the message).
set -euo pipefail

SCRIPT_NAME=update
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

HMIS_DIR=${HMIS_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}
COMPOSE_FILE=infra/docker/docker-compose.yml
HEALTH_TIMEOUT=${HMIS_HEALTH_TIMEOUT:-120}
FORCE=0
VERSION=

while [ $# -gt 0 ]; do
  case $1 in
    --force) FORCE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option: $1" 64 ;;
    *) [ -z "$VERSION" ] || die "only one version allowed" 64; VERSION=$1; shift ;;
  esac
done
[[ $VERSION =~ ^v[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]+$ ]] || die "usage: update.sh vYYYY.MM.DD.n [--force] [--dry-run]" 64

ENV_FILE=$HMIS_DIR/.env
[ -f "$ENV_FILE" ] || die "$ENV_FILE not found"
PREV=$(env_get "$ENV_FILE" HMIS_VERSION)
[ -n "$PREV" ] || die "HMIS_VERSION missing in $ENV_FILE"
WEB_PORT=$(env_get "$ENV_FILE" WEB_PORT)
WEB_PORT=${WEB_PORT:-3000}

compose() { (cd "$HMIS_DIR" && docker compose --env-file .env -f "$COMPOSE_FILE" "$@"); }

# ---- 1. window -------------------------------------------------------------------------------
hour=$((10#$(ist_hour)))
if [ "$hour" -ge 8 ] && [ "$hour" -lt 15 ] && [ "$FORCE" != 1 ]; then
  die "OPD hours (08:00-15:00 IST): not updating now. Run after 15:00 or add --force." 3
fi
if [ "$VERSION" = "$PREV" ]; then
  log "already on $VERSION"
fi

mkdir -p "$HMIS_DIR/state"
exec 8>"$HMIS_DIR/state/update.lock"
flock -n 8 || die "another update is running"

log "update $PREV -> $VERSION"

healthy() { # healthy VERSION: web answers 200 and reports that version
  local body
  body=$(curl -fsS --max-time 5 "http://127.0.0.1:$WEB_PORT/api/health" 2>/dev/null) || return 1
  [ "$(printf '%s' "$body" | jq -r '.version // empty')" = "$1" ] || return 1
  [ "$(printf '%s' "$body" | jq -r '.checks.db.ok')" = true ]
}

wait_healthy() { # wait_healthy VERSION
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  while [ $SECONDS -lt $deadline ]; do
    healthy "$1" && return 0
    sleep "${HMIS_HEALTH_INTERVAL:-3}"
  done
  return 1
}

# ---- 2. backup -------------------------------------------------------------------------------
log "taking the pre-update backup"
rc=0
run bash -c "cd '$HMIS_DIR' && docker compose --env-file .env -f $COMPOSE_FILE exec -T backup backup-run.sh --kind full --tag pre-update --save-as pre-update" || rc=$?
case $rc in
  0) ;;
  2) warn "backup reached the local disk but not every target (USB/cloud); continuing" ;;
  *) die "pre-update backup failed (exit $rc): not updating" ;;
esac

# ---- 3. pull ---------------------------------------------------------------------------------
log "pulling images for $VERSION"
if ! run bash -c "cd '$HMIS_DIR' && HMIS_VERSION='$VERSION' docker compose --env-file .env -f $COMPOSE_FILE pull web worker backup"; then
  die "image pull failed: still on $PREV, nothing changed"
fi

if [ "$DRY_RUN" = 1 ]; then
  echo "[dry-run] stop web worker; set HMIS_VERSION=$VERSION; migrate; up -d; wait for /api/health; on failure restore $PREV and the pre-update dump"
  exit 0
fi

# ---- 4. switch -------------------------------------------------------------------------------
cp -p "$ENV_FILE" "$HMIS_DIR/state/env.pre-update"
MIGRATIONS_STARTED=0

rollback() {
  warn "update failed: rolling back to $PREV"
  local ok=1
  cp -p "$HMIS_DIR/state/env.pre-update" "$ENV_FILE" || ok=0
  compose stop web worker caddy || true
  if [ "$MIGRATIONS_STARTED" = 1 ]; then
    log "restoring the database from the pre-update backup"
    compose exec -T backup restore-db.sh --dump /backup/pre-update/hmis.dump --globals /backup/pre-update/globals.sql || ok=0
  fi
  compose up -d --no-build || ok=0
  if [ "$ok" = 1 ] && wait_healthy "$PREV"; then
    log "rolled back: running $PREV again"
    return 0
  fi
  return 1
}

fail() {
  if rollback; then
    printf '{"at":"%s","from":"%s","to":"%s","result":"rolled_back"}\n' "$(date -u +%FT%TZ)" "$PREV" "$VERSION" >"$HMIS_DIR/state/last-update.json"
    die "update to $VERSION failed and was rolled back to $PREV: $1" 1
  fi
  die "update to $VERSION FAILED and the rollback to $PREV also failed ($1). Server needs manual recovery: .env backup is state/env.pre-update, database dump is /backup/pre-update/hmis.dump in the backup volume (restore-db.sh)." 2
}

compose stop web worker || fail "could not stop the old containers"
env_set "$ENV_FILE" HMIS_VERSION "$VERSION"

log "applying migrations"
MIGRATIONS_STARTED=1
compose run --rm --no-deps worker node dist/migrate.mjs || fail "migrations failed"

log "starting $VERSION"
compose up -d --no-build || fail "could not start the new containers"
wait_healthy "$VERSION" || fail "health check did not pass within ${HEALTH_TIMEOUT}s"

printf '{"at":"%s","from":"%s","to":"%s","result":"ok"}\n' "$(date -u +%FT%TZ)" "$PREV" "$VERSION" >"$HMIS_DIR/state/last-update.json"
log "updated to $VERSION (previous: $PREV)"
