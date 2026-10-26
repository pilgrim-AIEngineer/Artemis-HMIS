# 01 — Architecture

## 1. Deployment shape

Everything runs on one server inside the hospital on the LAN. Clients are Chrome browsers on PCs, tablets and a TV. The internet is used only for WhatsApp, offsite backups, remote support and (later) ABDM/NHCX.

```
[Reception PC] [Billing PC] [Assistant PC] [Doctor tablet] [Pharmacy PC] [Lab PC] [Nurse tablet] [TV]
        \___________________________ LAN (wired + Wi-Fi) ___________________________/
                                           |
                       Main server (Ubuntu 24.04, Docker Compose)
                       caddy (HTTPS hmis.local) -> web (Next.js + tRPC)
                                                 -> worker (pg-boss jobs, PDF, outbox)
                                                 -> postgres (+ pgBackRest)
                       |-- streaming replica -> Standby server (Phase 2)
                       |-- USB disk (nightly full + WAL)
                       |-- internet (when up) -> S3 Mumbai (encrypted backups), WhatsApp API, Tailscale
```

## 2. Applications

### apps/web (Next.js App Router)

- Route groups by role home: `/(app)/reception`, `/(app)/assistant`, `/(app)/billing`, `/(app)/doctor`, `/(app)/nursing`, `/(app)/pharmacy`, `/(app)/lab`, `/(app)/usg`, `/(app)/admin`, `/(app)/reports`.
- `/display/queue` — TV display, no login, shows token numbers only (no patient names by default; setting allows first name + initial). Authenticated by a long random display key in the URL; `setting` stores only its SHA-256 (REG-05), and every poll sends the key in a header.
- `/print/[template]/[id]` — server-rendered print pages using `packages/print` templates.
- tRPC router at `/api/trpc`, split by module (`patient`, `visit`, `queue`, `clinical`, `billing`, `pharmacy`, ...).
- Server Components for read-heavy pages; client components for fast-entry forms.
- Real-time updates (queue, bed board, worklists): Server-Sent Events from a `/api/events` endpoint fed by Postgres `LISTEN/NOTIFY`. Fallback polling every 5 s.

### apps/worker

pg-boss queues:
- `outbox.whatsapp` – send messages; retry with backoff up to 48 h; mark failed.
- `pdf.render` – render a print template to PDF (Playwright Chromium), store in `document` table + file storage.
- `reminder.daily` – 7 pm: next-day ANC visits, vaccines due in 2 days, follow-ups.
- `report.monthly` – 1st of month: Form F summary, MTP Form II draft, birth register list (as drafts for staff).
- `ops.backupCheck` – hourly: verify latest backup age; alert if > 24 h.
- `ops.healthPing` – every 5 min to the monitoring endpoint (when online).

### File storage

Local filesystem volume `/data/files` (scans, signed declarations, PDFs, photos), organised `facility/yyyy/mm/<uuid>.<ext>`. Metadata in `document` table. Backed up with the DB backup job (restic to USB and S3). Max upload 10 MB; images are compressed client-side to ≤ 1600 px, JPEG quality 0.8.

## 3. Offline and failure behaviour

- LAN-only operation is the normal mode. Nothing user-facing depends on the internet.
- If the main server is down, OPD continues on paper with a printed "downtime kit" (blank OPD sheets, receipt book with pre-numbered DT-series receipts). After recovery, a "downtime entry" screen lets staff back-enter visits and receipts with original date/time and the DT receipt number (`is_downtime_entry = true`, audited).
- Client-side drafts: long forms (Rx transcription, discharge summary, Form F, nursing notes) auto-save drafts to `localStorage` every 5 s and to the server every 20 s; on reload, offer to restore.

## 4. Printing

- Templates in `packages/print` are React components rendered to HTML with CSS `@page` rules. One template serves both browser print and worker PDF.
- Paper sizes: `thermal80` (token, receipt), `a5` (OPD sheet, Rx copy, small reports), `a4` (bills, discharge summary, lab reports, Form F, registers), `label50x25` (sample barcode, patient sticker).
- Browser printing by default (`window.print()` on a hidden iframe). Optional silent printing via QZ Tray on reception/billing PCs (setting per workstation; workstation identified by a cookie set during admin pairing).
- Each print logs to `print_log` (template, entity id, user, copy number). Reprints show "DUPLICATE" watermark on receipts and bills.
- Fonts: Noto Sans + Noto Sans Devanagari bundled locally (no CDN).

## 5. Auth and sessions

- Username + password (argon2id). Lockout 15 min after 5 failures.
- Session cookie (`HttpOnly`, `Secure`, `SameSite=Lax`), 12 h absolute, 10 min idle lock on shared workstations. Idle lock shows the PIN keypad for the same user; "switch user" goes to full login.
- Owner/admin remote access requires TOTP.
- Workstation pairing (admin action) stores a workstation id + name (e.g., "Reception 1") to default printers and to show where an action happened in the audit log.

## 6. Search

- Patients: `pg_trgm` GIN index on `search_name_norm` and `mobile`, exact on `uhid`.
- `search_name_norm` = lowercase, trimmed, collapsed spaces, plus phonetic normalisation for Indian names (`aa→a`, `ee→i`, `oo→u`, `sh→s`, `ph→f`, `v→w`, `z→j`, `kh→k`, `th→t`, remove `h` after consonants, drop double letters). Implement in `packages/shared/search.ts` with unit tests; also store `search_name_phonetic`.
- Drugs: trigram on brand + generic. Services and tests: trigram on name + short code.

## 7. Configuration and feature flags

`setting` table, key/value JSON per facility with zod schema in `packages/shared/settings.ts`. Examples: `opd.followUpValidityDays`, `queue.showNameOnDisplay`, `billing.discountLimits`, `features.pmjay`, `features.cardiology`, `print.rxCopy`, `whatsapp.enabled`.

## 8. Observability

- Structured JSON logs (pino) without PHI. Request id per request.
- `/api/health` (DB, disk free, last backup age, queue lag) for Uptime Kuma or healthchecks.io.
- Error capture to a local log file plus optional Sentry with PHI scrubbing (off by default).

## 9. Security

- Caddy terminates TLS with an internal CA; root cert installed on all client PCs.
- Postgres not exposed outside the Docker network.
- Disk encryption (LUKS) on the server; backups encrypted (restic/pgBackRest cipher).
- Security headers (CSP, frame-ancestors none, no-sniff). CSRF protection for mutations.
- OWASP ASVS L1 checklist before each phase go-live (also prepares for ABDM WASA later).

## 10. Future integrations (design hooks now)

- `integration_event` table and `outbox` pattern for ABDM, NHCX and lab machines.
- Public callbacks (ABDM/NHCX) will come through a small cloud relay or Cloudflare Tunnel to the local server; do not open router ports.
- FHIR mapping lives in `packages/fhir` (Phase 3); the DB stays relational.
