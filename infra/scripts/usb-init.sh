#!/usr/bin/env bash
# Prepares a USB disk for rotating backups (OPS-01, docs/31 §3). Run once per disk, as root:
#
#   sudo infra/scripts/usb-init.sh /dev/sdX1 [--format]
#
# Without --format the partition must already hold an ext4 filesystem. With --format it is erased
# and created as ext4 (you must type the device name to confirm). Either way the filesystem gets the
# label HMIS-BACKUP (the server mounts the disk with that label) and a marker file with a unique
# disk id, so the system can tell the two rotated disks apart and alert when one is not swapped.
set -euo pipefail

SCRIPT_NAME=usb-init
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

dev=
format=0
while [ $# -gt 0 ]; do
  case $1 in
    --format) format=1; shift ;;
    -h | --help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option: $1" 64 ;;
    *) dev=$1; shift ;;
  esac
done
[ -n "$dev" ] || die "usage: usb-init.sh /dev/sdX1 [--format]" 64
[ "$(id -u)" = 0 ] || die "run as root"
[ -b "$dev" ] || die "$dev is not a block device"
if findmnt -rn -S "$dev" >/dev/null; then die "$dev is mounted: unmount it first"; fi
case $(lsblk -no MOUNTPOINTS "$dev" 2>/dev/null | tr -d '[:space:]') in
  '') ;;
  *) die "$dev (or its parent) has mounted partitions; refusing" ;;
esac

if [ "$format" = 1 ]; then
  read -r -p "ERASE $dev completely? Type the device name to confirm: " answer
  [ "$answer" = "$dev" ] || die "not confirmed"
  mkfs.ext4 -F -L HMIS-BACKUP "$dev"
else
  [ "$(blkid -o value -s TYPE "$dev")" = ext4 ] || die "$dev is not ext4 (use --format to create it)"
  e2label "$dev" HMIS-BACKUP
fi

mnt=$(mktemp -d)
trap 'umount "$mnt" 2>/dev/null || true; rmdir "$mnt" 2>/dev/null || true' EXIT
mount "$dev" "$mnt"
id="hmis-usb-$(openssl rand -hex 6)"
if [ -f "$mnt/.hmis-backup-disk" ]; then
  log "disk already initialised: $(cat "$mnt/.hmis-backup-disk")"
else
  printf '%s\n' "$id" >"$mnt/.hmis-backup-disk"
  log "initialised disk $id"
fi
mkdir -p "$mnt/restic"
sync
