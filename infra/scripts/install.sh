#!/usr/bin/env bash
# First-time server setup (OPS-01, docs/31 §2). Ubuntu Server 24.04 LTS, run as root from the
# release bundle (the checkout / tarball that contains infra/ and .env.example):
#
#   sudo infra/scripts/install.sh --hostname hmis.local --lan-cidr 192.168.1.0/24 \
#        [--registry registry.example.com/hmis --version v2026.10.26.1 | --build-local] \
#        [--tailscale] [--ups usbhid-ups] [--usb] [--lan-ssh] [--dir /opt/hmis] [--yes] [--dry-run]
#
# Idempotent: re-running keeps an existing .env and only repairs what is missing. Secrets are
# generated on the server (openssl) and written to a root-only 600 .env; nothing secret is in the
# repo. --dry-run prints every step without changing anything (works without root, on any OS).
#
# Not done here (hardware / vendor console): LUKS full-disk encryption (checked and warned about),
# BIOS "power on after AC loss", router LAN DNS entry, Tailscale ACLs.
set -euo pipefail

SCRIPT_NAME=install
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BUNDLE_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

HMIS_DIR=/opt/hmis
HOSTNAME_FQDN=hmis.local
LAN_CIDR=
REGISTRY=
VERSION=
BUILD_LOCAL=0
USE_TAILSCALE=0
UPS_DRIVER=
USE_USB=0
LAN_SSH=0
ASSUME_YES=0
SKIP_OS_CHECK=0
USB_HOST_DIR=/mnt/hmis-usb

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case $1 in
    --dir) HMIS_DIR=${2:?}; shift 2 ;;
    --hostname) HOSTNAME_FQDN=${2:?}; shift 2 ;;
    --lan-cidr) LAN_CIDR=${2:?}; shift 2 ;;
    --registry) REGISTRY=${2:?}; shift 2 ;;
    --version) VERSION=${2:?}; shift 2 ;;
    --build-local) BUILD_LOCAL=1; shift ;;
    --tailscale) USE_TAILSCALE=1; shift ;;
    --ups) UPS_DRIVER=${2:?}; shift 2 ;;
    --usb) USE_USB=1; shift ;;
    --lan-ssh) LAN_SSH=1; shift ;;
    --yes | -y) ASSUME_YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-os-check) SKIP_OS_CHECK=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" 64 ;;
  esac
done

# ---- validation ------------------------------------------------------------------------------
[[ $HOSTNAME_FQDN =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ ]] || die "bad --hostname"
[[ -z $LAN_CIDR || $LAN_CIDR =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$ ]] || die "bad --lan-cidr (e.g. 192.168.1.0/24)"
[[ -z $VERSION || $VERSION =~ ^v[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]+$ ]] || die "bad --version (vYYYY.MM.DD.n)"
[[ -z $UPS_DRIVER || $UPS_DRIVER =~ ^[a-z0-9_-]+$ ]] || die "bad --ups driver name"
[[ $HMIS_DIR = /* ]] || die "--dir must be absolute"
if [ "$BUILD_LOCAL" = 0 ] && [ -z "$REGISTRY" ]; then
  die "give --registry PREFIX --version VERSION (release images) or --build-local (build on this server)"
fi
if [ "$BUILD_LOCAL" = 0 ] && [ -z "$VERSION" ]; then die "--version is required with --registry"; fi
[ -n "$LAN_CIDR" ] || die "--lan-cidr is required: the firewall only admits the hospital LAN to HTTPS"

# ---- preflight -------------------------------------------------------------------------------
preflight() {
  if [ "$DRY_RUN" != 1 ] && [ "$(id -u)" != 0 ]; then die "run as root (sudo)"; fi
  if [ "$SKIP_OS_CHECK" != 1 ] && [ "$DRY_RUN" != 1 ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    [ "${ID:-}" = ubuntu ] && [ "${VERSION_ID:-}" = 24.04 ] || die "Ubuntu Server 24.04 LTS required (found ${PRETTY_NAME:-unknown})"
  fi
  if [ "$DRY_RUN" != 1 ] && ! lsblk -no TYPE 2>/dev/null | grep -q '^crypt$'; then
    warn "no LUKS-encrypted volume found: docs/31 §2.1 requires full-disk encryption before patient data is stored"
    [ "$ASSUME_YES" = 1 ] || die "re-run with --yes to continue without disk encryption (not for production)"
  fi
  if [ -n "${SSH_CONNECTION:-}" ] && [ "$LAN_SSH" = 0 ] && [ "$USE_TAILSCALE" = 0 ] && [ "$DRY_RUN" != 1 ]; then
    warn "you are connected over SSH: the firewall will only keep SSH open via Tailscale (or LAN with --lan-ssh)"
    [ "$ASSUME_YES" = 1 ] || die "add --lan-ssh or --tailscale, or --yes to accept being locked out"
  fi
  [ -f "$BUNDLE_DIR/infra/docker/docker-compose.yml" ] || die "run from the release bundle (infra/docker/docker-compose.yml not found)"
}

# ---- steps -----------------------------------------------------------------------------------
step_packages() {
  log "1/10 base packages, unattended security updates, NTP"
  run apt-get update -y
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg jq openssl ufw chrony unattended-upgrades e2fsprogs rsync
  if [ "$DRY_RUN" = 1 ]; then
    echo "[dry-run] write /etc/apt/apt.conf.d/20auto-upgrades (daily update + unattended-upgrade)"
  else
    printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' >/etc/apt/apt.conf.d/20auto-upgrades
  fi
  run timedatectl set-timezone Asia/Kolkata
  run systemctl enable --now chrony
}

step_docker() {
  log "2/10 Docker Engine + Compose plugin"
  if [ "$DRY_RUN" != 1 ] && command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
    log "docker already installed"
  else
    run install -m 0755 -d /etc/apt/keyrings
    run curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    run chmod a+r /etc/apt/keyrings/docker.asc
    if [ "$DRY_RUN" = 1 ]; then
      echo "[dry-run] write /etc/apt/sources.list.d/docker.list (noble stable)"
    else
      printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable\n' \
        "$(dpkg --print-architecture)" >/etc/apt/sources.list.d/docker.list
    fi
    run apt-get update -y
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  fi
  if [ "$DRY_RUN" = 1 ]; then
    echo "[dry-run] write /etc/docker/daemon.json if missing (json-file logs, 10m x 5)"
  elif [ ! -f /etc/docker/daemon.json ]; then
    printf '{\n  "log-driver": "json-file",\n  "log-opts": { "max-size": "10m", "max-file": "5" }\n}\n' >/etc/docker/daemon.json
    systemctl restart docker
  fi
  run systemctl enable --now docker
}

step_files() {
  log "3/10 release bundle -> $HMIS_DIR"
  run install -d -m 0755 "$HMIS_DIR"
  run rsync -a --delete --exclude node_modules --exclude .git --exclude .next --exclude .turbo \
    --exclude '/.env' --exclude '/state' --exclude '/pki' "$BUNDLE_DIR/" "$HMIS_DIR/"
  run install -d -m 0700 "$HMIS_DIR/state" "$HMIS_DIR/pki"
}

gen() { openssl rand -hex "$1"; }

step_env() {
  log "4/10 .env with generated secrets (root-only, mode 600)"
  local envf=$HMIS_DIR/.env
  if [ "$DRY_RUN" = 1 ]; then
    echo "[dry-run] create $envf from .env.example: POSTGRES_PASSWORD, APP_DB_PASSWORD, HMIS_SECRET_KEY, BACKUP_PASSPHRASE generated; HMIS_HOSTNAME=$HOSTNAME_FQDN"
    return 0
  fi
  if [ -f "$envf" ]; then
    log "$envf exists: keeping it"
    return 0
  fi
  (
    umask 077
    cp "$HMIS_DIR/.env.example" "$envf"
  )
  chmod 600 "$envf"
  env_set "$envf" POSTGRES_PASSWORD "$(gen 24)"
  env_set "$envf" APP_DB_PASSWORD "$(gen 24)"
  env_set "$envf" HMIS_SECRET_KEY "$(gen 32)"
  env_set "$envf" HMIS_HOSTNAME "$HOSTNAME_FQDN"
  env_set "$envf" COMPOSE_PROJECT_NAME hmis
  env_set "$envf" CADDY_HTTPS_PORT 443
  env_set "$envf" CADDY_HTTP_PORT 80
  env_set "$envf" WEB_PORT 3000
  local pass
  pass=$(gen 24)
  env_set "$envf" BACKUP_PASSPHRASE "$pass"
  env_set "$envf" BACKUP_USB_ENABLED "$USE_USB"
  env_set "$envf" BACKUP_USB_HOST_DIR "$USB_HOST_DIR"
  [ -n "$REGISTRY" ] && env_set "$envf" HMIS_IMAGE_PREFIX "$REGISTRY"
  [ -n "$VERSION" ] && env_set "$envf" HMIS_VERSION "$VERSION"
  echo
  echo "================================================================================"
  echo " BACKUP PASSPHRASE (shown once): $pass"
  echo " Write it on paper and give it to the owner / keep it in the vendor vault."
  echo " Without it NO backup (USB or cloud) can be restored. It is also in $envf."
  echo "================================================================================"
  echo
}

step_firewall() {
  log "5/10 firewall (ufw): HTTPS/HTTP from $LAN_CIDR, SSH via Tailscale only"
  run ufw --force reset
  run ufw default deny incoming
  run ufw default allow outgoing
  run ufw allow from "$LAN_CIDR" to any port 443 proto tcp
  run ufw allow from "$LAN_CIDR" to any port 80 proto tcp
  if [ "$USE_TAILSCALE" = 1 ]; then
    run ufw allow in on tailscale0
  fi
  if [ "$LAN_SSH" = 1 ]; then
    run ufw allow from "$LAN_CIDR" to any port 22 proto tcp
  fi
  run ufw --force enable
  log "note: Docker publishes ports by itself; keep the router free of port forwards (docs/01 §9)"
}

step_tailscale() {
  [ "$USE_TAILSCALE" = 1 ] || { log "6/10 tailscale: skipped (--tailscale not given)"; return 0; }
  log "6/10 Tailscale (SSH + owner HTTPS over the tailnet)"
  run curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg -o /usr/share/keyrings/tailscale-archive-keyring.gpg
  run curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list -o /etc/apt/sources.list.d/tailscale.list
  run apt-get update -y
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y tailscale
  run systemctl enable --now tailscaled
  if [ -n "${TS_AUTHKEY:-}" ] && [ "$DRY_RUN" != 1 ]; then
    local keyfile
    keyfile=$(mktemp)
    chmod 600 "$keyfile"
    printf '%s' "$TS_AUTHKEY" >"$keyfile"
    tailscale up --auth-key="file:$keyfile" --ssh --hostname="hmis-${HOSTNAME_FQDN%%.*}" || warn "tailscale up failed"
    rm -f "$keyfile"
  else
    log "TS_AUTHKEY not set: run 'tailscale up --ssh' by hand, then restrict access with ACLs (vendor admin devices -> SSH; owner phone -> 443 only) in the Tailscale admin console"
  fi
}

step_ups() {
  [ -n "$UPS_DRIVER" ] || { log "7/10 UPS: skipped (--ups DRIVER not given)"; return 0; }
  log "7/10 UPS monitoring with NUT ($UPS_DRIVER): graceful shutdown at 20% battery"
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y nut
  if [ "$DRY_RUN" = 1 ]; then
    echo "[dry-run] write /etc/nut/{nut.conf,ups.conf,upsd.users,upsmon.conf}; restart nut services"
    return 0
  fi
  local pw
  pw=$(gen 12)
  printf 'MODE=standalone\n' >/etc/nut/nut.conf
  printf '[ups]\n  driver = %s\n  port = auto\n  desc = "Server UPS"\n  override.battery.charge.low = 20\n' "$UPS_DRIVER" >/etc/nut/ups.conf
  printf '[upsmon]\n  password = %s\n  upsmon primary\n' "$pw" >/etc/nut/upsd.users
  printf 'MONITOR ups@localhost 1 upsmon %s primary\nMINSUPPLIES 1\nSHUTDOWNCMD "/sbin/shutdown -h +0"\nPOLLFREQ 5\nPOLLFREQALERT 5\nHOSTSYNC 15\nDEADTIME 15\nFINALDELAY 5\n' "$pw" >/etc/nut/upsmon.conf
  chmod 640 /etc/nut/upsd.users /etc/nut/upsmon.conf
  chown root:nut /etc/nut/upsd.users /etc/nut/upsmon.conf
  systemctl enable nut-server nut-monitor
  systemctl restart nut-driver.target nut-server nut-monitor || warn "NUT did not start: check the UPS driver with 'upsdrvctl start'"
}

step_usb() {
  log "8/10 USB backup disk mount point $USB_HOST_DIR"
  run install -d -m 0755 "$USB_HOST_DIR"
  # While no disk is mounted nothing may write into the bare directory (it is on the system disk).
  run chattr +i "$USB_HOST_DIR"
  [ "$USE_USB" = 1 ] || { log "USB backups are off (--usb not given); the mount point is prepared for later"; return 0; }
  if [ "$DRY_RUN" = 1 ]; then
    echo "[dry-run] write /etc/systemd/system/hmis-usb-mount.{service,timer}: mount the disk labelled HMIS-BACKUP every minute"
    return 0
  fi
  cat >/etc/systemd/system/hmis-usb-mount.service <<UNIT
[Unit]
Description=Mount the HMIS backup USB disk when present

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'mountpoint -q $USB_HOST_DIR || { [ -e /dev/disk/by-label/HMIS-BACKUP ] && mount -o nosuid,nodev,noexec LABEL=HMIS-BACKUP $USB_HOST_DIR; } || true'
UNIT
  cat >/etc/systemd/system/hmis-usb-mount.timer <<UNIT
[Unit]
Description=Check for the HMIS backup USB disk

[Timer]
OnBootSec=30
OnUnitActiveSec=60

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now hmis-usb-mount.timer
}

compose() { (cd "$HMIS_DIR" && docker compose --env-file .env -f infra/docker/docker-compose.yml "$@"); }

step_stack() {
  log "9/10 start the stack"
  if [ "$BUILD_LOCAL" = 1 ]; then
    run bash -c "cd '$HMIS_DIR' && docker compose --env-file .env -f infra/docker/docker-compose.yml build"
  else
    run bash -c "cd '$HMIS_DIR' && docker compose --env-file .env -f infra/docker/docker-compose.yml pull"
  fi
  run bash -c "cd '$HMIS_DIR' && docker compose --env-file .env -f infra/docker/docker-compose.yml up -d --wait postgres"
  # Applies migrations and creates/updates the least-privileged app login (idempotent).
  run bash -c "cd '$HMIS_DIR' && docker compose --env-file .env -f infra/docker/docker-compose.yml run --rm --no-deps worker node dist/migrate.mjs"
  run bash -c "cd '$HMIS_DIR' && docker compose --env-file .env -f infra/docker/docker-compose.yml up -d --wait"
}

step_finish() {
  log "10/10 root certificate, first backup"
  if [ "$DRY_RUN" = 1 ]; then
    echo "[dry-run] copy Caddy's internal root CA to $HMIS_DIR/pki/hmis-root-ca.crt; run the first full backup"
  else
    for _ in $(seq 1 30); do
      if compose exec -T caddy test -f /data/caddy/pki/authorities/local/root.crt 2>/dev/null; then break; fi
      sleep 2
    done
    compose exec -T caddy cat /data/caddy/pki/authorities/local/root.crt >"$HMIS_DIR/pki/hmis-root-ca.crt" \
      || warn "could not export the root CA yet; see infra/docker/caddy/Caddyfile for the command"
    compose exec -T backup backup-run.sh --kind full || warn "first backup did not finish cleanly; check 'docker compose logs backup'"
  fi
  cat <<MSG

Done. Next steps (docs/31 §2 and §7):
  1. Install $HMIS_DIR/pki/hmis-root-ca.crt as a trusted root on every client PC and tablet.
  2. Add a LAN DNS entry on the router: $HOSTNAME_FQDN -> this server's LAN IP (or each PC's hosts file).
  3. Create the first admin and load master data (docs/33), then set the monitoring URLs in $HMIS_DIR/.env
     (HEALTHCHECK_PING_URL, OPS_TELEGRAM_*, BACKUP_S3_REPOSITORY, AWS_*) and run: docker compose ... up -d
  4. Prepare the two USB disks with infra/scripts/usb-init.sh, then set BACKUP_USB_ENABLED=1.
  5. Run infra/scripts/backup-check.sh and a restore drill (infra/scripts/restore-drill.sh) before go-live.
MSG
}

main() {
  preflight
  step_packages
  step_docker
  step_files
  step_env
  step_firewall
  step_tailscale
  step_ups
  step_usb
  step_stack
  step_finish
}
main
