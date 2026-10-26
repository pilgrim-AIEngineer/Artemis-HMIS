#!/usr/bin/env bash
# Shared helpers for the ops scripts (OPS-01). Source it; do not execute it.
# shellcheck shell=bash

log() { printf '%s [%s] %s\n' "$(date +%T)" "${SCRIPT_NAME:-hmis}" "$*"; }
warn() { log "WARNING: $*" >&2; }
die() { log "ERROR: $*" >&2; exit "${2:-1}"; }

DRY_RUN=${DRY_RUN:-0}

# run CMD ARGS...: executes, or only prints the command with --dry-run.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run] %s\n' "$*"
    return 0
  fi
  "$@"
}

# Reads KEY from an env file ("" if absent). Does not execute the file.
env_get() {
  local file=$1 key=$2
  [ -f "$file" ] || return 0
  sed -n -E "s/^${key}=(.*)$/\1/p" "$file" | tail -n1
}

# Sets or appends KEY=VALUE in an env file, keeping its mode. VALUE must not contain newlines.
env_set() {
  local file=$1 key=$2 value=$3 tmp
  tmp=$(mktemp "$file.XXXXXX")
  chmod --reference="$file" "$tmp" 2>/dev/null || chmod 600 "$tmp"
  if grep -q -E "^${key}=" "$file" 2>/dev/null; then
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' "$file" >"$tmp"
  else
    { cat "$file" 2>/dev/null; printf '%s=%s\n' "$key" "$value"; } >"$tmp"
  fi
  mv "$tmp" "$file"
}

# Hospital-time hour (00-23); HMIS_NOW_HOUR_IST overrides it for tests.
ist_hour() { printf '%s' "${HMIS_NOW_HOUR_IST:-$(TZ=Asia/Kolkata date +%H)}"; }
