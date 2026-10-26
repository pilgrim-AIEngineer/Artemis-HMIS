#!/usr/bin/env bash
# Backup status at a glance (OPS-01): reads /api/health of the local web container.
#
#   infra/scripts/backup-check.sh [--url URL]
#
# Prints one line per backup target and exits 0 when every backup is fresh, 1 when any is stale or
# missing (same rules as the ops.backupCheck job: local DB <= 24 h, cloud <= 48 h, USB swapped
# within 8 days), 2 when the server cannot be reached.
set -euo pipefail

SCRIPT_NAME=backup-check
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

ENV_FILE=${HMIS_ENV_FILE:-$SCRIPT_DIR/../../.env}
port=$(env_get "$ENV_FILE" WEB_PORT)
url=${HMIS_HEALTH_URL:-http://127.0.0.1:${port:-3000}/api/health}
while [ $# -gt 0 ]; do
  case $1 in
    --url) url=${2:?}; shift 2 ;;
    -h | --help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" 64 ;;
  esac
done

# /api/health answers 503 when the DB is down but still returns the body.
body=$(curl -sS --max-time 10 "$url" 2>/dev/null) || { echo "cannot reach $url"; exit 2; }
printf '%s' "$body" | jq -e '.checks.backup' >/dev/null 2>&1 || { echo "unexpected response from $url"; exit 2; }

printf '%s' "$body" | jq -r '
  .checks.backup as $b
  | "backup: \($b.state)" + (if $b.lastBackupAgeHours != null then " (freshest database backup \($b.lastBackupAgeHours) h ago)" else "" end),
    ($b.targets[] | "  \(.name): \(if .ok then "ok" else "PROBLEM" end), database \(.dbAgeHours // "never") h, files \(.filesAgeHours // "never") h" + (if .lastError then ", last error: \(.lastError)" else "" end)),
    (.alerts[] | select(.code | startswith("backup.")) | "ALERT [\(.severity)] \(.message)")'
printf '%s' "$body" | jq -e '.checks.backup.ok' >/dev/null
