#!/usr/bin/env bash
# Restore drill (OPS-01, docs/31 §3): run monthly on the vendor laptop, and in CI.
#
#   BACKUP_PASSPHRASE=... infra/scripts/restore-drill.sh --repo REPO [--image IMG] [--out FILE]
#
# REPO is a restic repository: a directory (the USB disk's restic/ folder, or the local one) or an
# S3 URL (s3:https://s3.ap-south-1.amazonaws.com/bucket/hmis, with AWS_ACCESS_KEY_ID and
# AWS_SECRET_ACCESS_KEY in the environment). The newest snapshot is restored into a throwaway
# Postgres inside a container (nothing touches a live database), then integrity checks run:
# restic check, row counts against the manifest, last bill number, restored files.
# The JSON result is written to FILE (default ./restore-drill-<UTC time>.json); keep it as the
# monthly record. Exit 0 = drill passed. Needs Docker and the backup image (pull it, or build with
# `docker compose build backup`).
set -euo pipefail

SCRIPT_NAME=restore-drill
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

repo=
image=${HMIS_BACKUP_IMAGE:-${HMIS_IMAGE_PREFIX:-hmis}/backup:${HMIS_VERSION:-dev}}
out=./restore-drill-$(date -u +%Y%m%dT%H%M%SZ).json

while [ $# -gt 0 ]; do
  case $1 in
    --repo) repo=${2:?}; shift 2 ;;
    --image) image=${2:?}; shift 2 ;;
    --out) out=${2:?}; shift 2 ;;
    -h | --help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" 64 ;;
  esac
done
[ -n "$repo" ] || die "--repo is required" 64

if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
  if [ -t 0 ]; then
    read -r -s -p "Backup passphrase: " BACKUP_PASSPHRASE
    echo
  else
    die "set BACKUP_PASSPHRASE" 64
  fi
fi
export RESTIC_PASSWORD=$BACKUP_PASSPHRASE

args=(--rm -e RESTIC_PASSWORD)
case $repo in
  s3:* | rest:* | sftp:*)
    args+=(-e "RESTIC_REPOSITORY=$repo" -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION)
    ;;
  *)
    [ -d "$repo" ] || die "repository directory not found: $repo"
    args+=(-v "$(cd "$repo" && pwd):/repo:ro" -e RESTIC_REPOSITORY=/repo)
    ;;
esac

log "restoring the newest snapshot of $repo with $image"
rc=0
docker run "${args[@]}" "$image" drill.sh >"$out" || rc=$?
jq -r '"snapshot \(.snapshot.id) (\(.snapshot.time))", (.checks[] | "  [\(if .ok then "ok" else "FAIL" end)] \(.name): \(.detail)")' "$out" 2>/dev/null || cat "$out"
if [ "$rc" = 0 ]; then log "drill PASSED, result in $out"; else log "drill FAILED, result in $out" >&2; fi
exit "$rc"
