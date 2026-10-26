# 31 — Deployment and operations

Feature IDs: OPS-01 (Phase 1), OPS-02 (Phase 2A).

## 1. Hardware (hospital buys; prices are rough estimates, Oct 2026)

| Item | Spec | Qty | When |
| --- | --- | --- | --- |
| Main server | Business mini PC/tower, recent Intel i5/Ryzen 5, 32 GB RAM, 1 TB NVMe (OS + DB) + 1 TB SSD (files/backups staging) | 1 | P1 |
| Standby server | Same class, 16–32 GB RAM, 1 TB NVMe | 1 | P1 strongly advised, P2A mandatory |
| Online UPS (server + switch + router) | 1–2 kVA online, USB for NUT auto-shutdown | 1 | P1 |
| External backup disks | 2 TB USB, two disks rotated weekly (one at owner's home) | 2 | P1 |
| Internet | Jio Fiber (existing) + second ISP from a different provider (e.g., Airtel fibre or 5G FWA) | 2 | P1 |
| Dual-WAN router | Automatic failover between ISPs | 1 | P1 |
| Network | Gigabit managed switch, CAT6 to every counter, business Wi-Fi AP for tablets | 1 set | P1 |
| PCs | Reception ×2, billing ×1, assistant ×1–2 (transcription), vitals ×1 (or tablet), pharmacy ×1, lab ×1, nursing station ×1; any recent PC with 8 GB RAM, Chrome | as needed | P1/P2 |
| Tablets | 10-inch Android for doctor rooms (verify/queue), vitals, nurses | 3–5 | P1/P2 |
| 2D barcode scanners | Read QR on OPD sheet, barcodes on labels | 3 | P1 |
| Document camera or phone stand | Photograph paper Rx at assistant desk | 1–2 | P1 |
| Thermal printers 80 mm | Tokens/receipts | 2 | P1 |
| A5/A4 laser printers | OPD sheets (A5 tray), bills, reports | 3 | P1 |
| TV + mini PC/Android stick | Waiting hall queue display | 1 | P1 |
| Label printer 50×25 mm | Lab samples, patient stickers | 1 | P2A |
| Wristband printer (optional) | IPD | 1 | P2A |

## 2. Server setup (`infra/scripts/install.sh`)

1. Ubuntu Server 24.04 LTS, LUKS full-disk encryption (unlock via TPM or a small USB key + passphrase procedure documented for the owner).
2. Unattended security updates; NTP; firewall (ufw) allowing 443 from LAN only and Tailscale.
3. Docker + Compose plugin; clone release bundle (images pulled from the private registry).
4. `.env` with secrets (root-only, 600); internal CA generated; Caddy configured for `hmis.local` and `training.hmis.local`; LAN DNS entry on the router (or hosts file on each PC).
5. Tailscale with ACLs: vendor admin devices → SSH; owner phone → HTTPS only.
6. NUT configured with the UPS: graceful shutdown at 20% battery; auto-start on power return; containers `restart: unless-stopped`.
7. Monitoring agent (healthchecks pings + Uptime Kuma on vendor side).

## 3. Backups (most important)

- pgBackRest: continuous WAL archive + nightly full (02:00) to `/backup` (second SSD) and to encrypted S3 bucket in `ap-south-1` (when online; catches up after outages).
- restic for `/data/files` to the USB disk and S3, nightly.
- USB disk rotation weekly (owner swaps; system alerts if the USB disk was not swapped in 8 days — disk label check).
- Standby server: streaming replication (synchronous_commit = on for the standby when available — local LAN, low latency; falls back to async if standby is down, with alert).
- **Restore drill** monthly on vendor laptop (`restore-drill.sh`): restore latest backup, run integrity checks (row counts, last bill number), record result.
- Targets: RPO ≤ 15 min (≈ 0 with standby), RTO ≤ 1 h (promote standby: documented runbook, 10 steps, tested before go-live).

## 4. Updates

- CI builds versioned images (`vYYYY.MM.DD.n`), pushes to a private registry.
- `update.sh <version>` over Tailscale, only after OPD hours (blocked 8 am – 3 pm unless `--force`): take backup → pull → run migrations in a transaction → start new containers → health check → on failure roll back images and restore DB to pre-update backup if migrations ran.
- Changelog in Hindi/English shown to users after update ("What's new").
- Training DB updated with the same version.

## 5. Monitoring and alerts (to vendor via WhatsApp/Telegram, critical also to admin)

App down, DB down, replication lag > 60 s, disk > 80%, backup age > 24 h, cloud backup lag > 48 h, USB not rotated, UPS on battery/low, CPU temp high, certificate expiry, error rate spike, queue (outbox) backlog > 500.

## 6. Downtime kit (paper)

Pre-printed blank OPD sheets, downtime receipt book (DT-series numbers), downtime registers; staff instructions in Hindi; back-entry screen after recovery (`01 §3`).

## 7. Go-live checklist (Phase 1)

- [ ] Masters reviewed and signed by owner (services, fees, doctors, follow-up rules, quick-tick orders, Rx phrases)
- [ ] Users created, one per person; roles reviewed; PINs set
- [ ] Every PC opens hmis.local without certificate warning; every printer prints its templates
- [ ] Barcode scanners read OPD sheet QR
- [ ] Backups (local, USB, cloud) verified; restore drill passed; standby promotion rehearsed (if installed)
- [ ] UPS power-cut test passed
- [ ] Staff trained in training mode (reception, assistant, billing, vitals); each did 20 practice patients
- [ ] Parallel run 3 days without blocking issue
- [ ] Downtime kit in place
- [ ] Data processing agreement signed with the hospital

## 8. Implementation notes (OPS-01, as built)

- **Backups use restic for everything** (database dump and `/data/files`), not pgBackRest. The `backup` container runs `pg_dump -Fc` plus `pg_dumpall --globals-only` (roles and grants) hourly (`BACKUP_DB_EVERY_MIN`) and a nightly full run at `BACKUP_AT` (02:00) that also copies `/data/files`. Targets: `local` (`/backup/restic`, second SSD), `usb` (`BACKUP_USB_ENABLED=1`, disk labelled `HMIS-BACKUP` with a `.hmis-backup-disk` marker made by `usb-init.sh`), `s3` (`BACKUP_S3_REPOSITORY`, `AWS_*`). All are encrypted with `BACKUP_PASSPHRASE`. The RPO is therefore up to one hour until WAL archiving/standby arrives with OPS-02 (target in §3: 15 min).
- Status is written to `/backup/status/status.json`; `/api/health` (`checks.backup`, `checks.disk`, `checks.queue`, `alerts`) and the `ops.backupCheck` (hourly) / `ops.healthPing` (5 min) jobs read it. Only a dead database makes `/api/health` answer 503; `?strict=1` also fails on open alerts. Alerts go to `OPS_ALERT_WEBHOOK_URL` and/or Telegram, repeated at most every `OPS_ALERT_REPEAT_HOURS`; `HEALTHCHECK_PING_URL` is pinged (and `/fail` on critical alerts).
- Scripts (`infra/scripts`): `install.sh` (`--dry-run` supported), `update.sh vYYYY.MM.DD.n`, `backup-check.sh`, `restore-drill.sh --repo DIR|s3:URL`, `usb-init.sh`. Monthly drill: keep the JSON result it writes.
- Not covered yet: WhatsApp alerts to the vendor, replication/standby, NUT and USB auto-mount are written but need verification on the real hardware, training instance (`training.hmis.local`), "What's new" changelog, creating the first admin from the release images.
