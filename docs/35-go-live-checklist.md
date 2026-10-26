# 35 — Go-live checklist (Phase 1, OPD)

Feature ID: OPS-01 (PR 22). This is the tracked copy of `docs/31 §7`, with how each item is
proven, who owns it, and where the evidence is kept. `docs/31 §7` stays the short list; **this
file is the one that is filled in**, committed on every change, and read at the go/no-go meeting.

## How to use this file

- Status values: `Open` → `In progress` → `Done`. `Waived` only with the owner's written
  approval, the reason, and a date for closing it (write it in the Notes column).
- When an item is `Done`, write the date, the name, and where the evidence is (a file in
  `docs/go-live/`, a photo, a restore-drill JSON, a signed UAT sheet) in the Evidence column.
- Do not tick an item because the software is "probably fine". Tick it because someone did the
  check in the "How to prove it" column on the hospital's own equipment.
- Go live only when every row in sections A and B is `Done` or `Waived`.

## A. Hospital readiness (`docs/31 §7`)

| ID | Item (as in `31 §7`) | How to prove it | Owner | Status | Evidence / date / name | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| GL-01 | Masters reviewed and signed by owner (services, fees, doctors, follow-up rules, quick-tick orders, Rx phrases) | Owner reads the printed masters (Admin → Masters, tariffs, Settings) and signs. Fee and follow-up answers come from `docs/40` Q6; unpriced services are listed and either priced or hidden | Owner | Open | | Rates are always entered by the hospital (`33`) |
| GL-02 | Users created, one per person; roles reviewed; PINs set | Admin → Users list matches the staff list (`docs/40` Q9). Each person signs in, changes the temporary password (12+ characters) and sets a PIN. No `demo_*` users, no shared users. Roles reviewed against `03 §1` | Admin | Open | | `install.sh` creates only the first admin; `db:seed --demo` must never run on production |
| GL-03 | Every PC opens hmis.local without certificate warning; every printer prints its templates | On each PC: open `https://hmis.local`, no warning (Caddy root certificate installed, `01 §9`). On each printer: print the sample pages from Admin → Print header for its paper size (80 mm, A5, A4, 50×25 label) and the real receipt, OPD sheet, sticker and UHID card | Vendor + admin | Open | | Attach one test print per printer; `50 §4` risk: A5 tray and thermal width need the real printers |
| GL-04 | Barcode scanners read OPD sheet QR | At each scanner station scan a printed OPD sheet in "Scan the OPD sheet" (Assistant → Rx); the right visit opens | Vendor | Open | | |
| GL-05 | Backups (local, USB, cloud) verified; restore drill passed; standby promotion rehearsed (if installed) | (1) `infra/scripts/backup-check.sh` exits 0 and shows local, USB and cloud as fresh. (2) `BACKUP_PASSPHRASE=… infra/scripts/restore-drill.sh --repo <repo>` for the USB disk and for the cloud repository passes; keep both JSON results. (3) USB swap: swap the disk, confirm the alert clears; leave it 8 days in a rehearsal and confirm the alert fires. (4) `curl -s https://hmis.local/api/health?strict=1` returns 200. (5) Standby promotion only if a standby is installed (`OPS-02`) | Vendor | Open | | Phase 1 backups are restic, hourly DB dump plus nightly full; RPO up to 1 hour until WAL archiving (`31 §8`) |
| GL-06 | UPS power-cut test passed | Pull the mains with the UPS carrying server, switch and router: the system stays up; at 20 % battery the server shuts down cleanly (NUT); on power return it starts by itself and `/api/health` is OK without anyone touching it | Vendor | Open | | NUT and auto-start are written but not yet proven on the real hardware (`31 §8`) |
| GL-07 | Staff trained in training mode (reception, assistant, billing, vitals); each did 20 practice patients | Training copy is running the same version (see Section C, C-4). Each person finished their `docs/uat/` script and 20 practice patients; the signed sheets are scanned into `docs/uat/signed/` and the table in `docs/uat/README.md` is full | Vendor + admin | Open | | `31 §8`: the training instance (`training.hmis.local`) is not built yet; see C-4 |
| GL-08 | Parallel run 3 days without blocking issue | Three OPD days with the system and the paper register both running. Daily: system OPD count equals paper count; cash and UPI totals equal the counted cash and the bank credits (`docs/00 §5`). Every issue is written down with a severity; no Blocker left open | Owner + admin | Open | | Success numbers to record: visits (system vs paper), cash and UPI difference, longest wait for a returning patient |
| GL-09 | Downtime kit in place | Pre-printed OPD sheets, receipt book with DT-series numbers, downtime registers, and the one-page Hindi instruction are at reception and billing. Staff have done a 15-minute rehearsal with the server switched off | Admin | Open | | `31 §6`; the back-entry screen after recovery is described in `01 §3` |
| GL-10 | Data processing agreement signed with the hospital | Signed copy filed; the owner holds a copy | Owner + vendor | Open | | Legal text is not in this repository |

## B. Software release gate (the vendor ticks these before the go/no-go meeting)

| ID | Item | How to prove it | Status | Evidence / date / name |
| --- | --- | --- | --- | --- |
| SW-01 | `pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm check:forbidden` pass on the release commit | CI run of the release tag; link in Evidence | Open | |
| SW-02 | Critical E2E flows 1–8 (`32 §2`) pass on desktop (1366×768) and tablet (1280×800) | `pnpm e2e` log or CI artifact: flow 1 (new patient to receipt), 2 (returning, free follow-up), 3 (vitals), 4 (Rx), 5 (UPI, day close), 6 (cancellation, refund by PIN), 7 (ANC), 8 (vaccines) | Open | |
| SW-03 | Load test at the `32 §1` targets passes on the production server spec | Run `pnpm load` (see `docs/36-load-test.md`) **on the hospital server** with `SCALE=1`; search p95 < 300 ms, mutations p95 < 1 s. Record the result in `docs/36-load-test.md` | Open | The numbers there were taken on a development host, not the production server |
| SW-04 | ASVS L1 checklist reviewed, no open failure | `docs/34-asvs-l1.md` signed by a reviewer who is not the author; `pnpm audit --prod` re-run | Open | |
| SW-05 | `--demo` seed produces 500 patients, 30 days of OPD, 50 pregnancies, 80 children | `pnpm db:seed --demo` on the training copy; counts shown in its log lines | Open | Covered by `packages/db/src/masters.test.ts` |
| SW-06 | Update and rollback rehearsed | `update.sh` to a test version and back on a copy of the server (`31 §4`); the pre-update backup restores | Open | |
| SW-07 | Release tagged `vYYYY.MM.DD.n`; images pulled from the private registry; `/api/health` shows that version | `curl -s https://hmis.local/api/health \| jq .version` | Open | |
| SW-08 | Production database holds no demo or test data | First sign-in list, patient count 0, UHID series at the start, `number_series` set for the current financial year | Open | |

## C. Things the build does not do yet (close or waive before go-live)

From `docs/31 §8` ("Not covered yet") and `docs/40`. Each one must be built, replaced by a manual
procedure written down here, or waived by the owner.

| ID | Gap | What to do before go-live | Status | Notes |
| --- | --- | --- | --- | --- |
| C-1 | WhatsApp alerts to the vendor (monitoring currently goes to a webhook and/or Telegram) | Configure `OPS_ALERT_WEBHOOK_URL` or Telegram; send a test alert and confirm the vendor receives it | Open | `31 §5` names WhatsApp/Telegram |
| C-2 | Replication / standby | Phase 1 runs without a standby (RTO and RPO as in `31 §3` need `OPS-02`). Owner accepts the single-server risk in writing, or the standby is installed | Open | Waiver text needed from the owner |
| C-3 | NUT, USB auto-mount verified on real hardware | Covered by GL-05 and GL-06 | Open | |
| C-4 | Training instance (`training.hmis.local`) and its update with the same version | Until built: a second compose project on the same server (or the vendor laptop) with `db:seed --demo`, on another host name, updated with the same `update.sh` run | Open | UAT and GL-07 depend on this |
| C-5 | "What's new" changelog shown after an update | Not needed for the first go-live; staff are told in person | Open | Can be waived |
| C-6 | Creating the first admin from the release images | Run the documented command once on the production server and keep the one-time password out of chat and email | Open | |
| C-7 | Audit log has no screen in Phase 1 | The vendor reads `audit_log` from the database when asked; the owner knows this | Open | `admin.audit.view` exists; a screen is not built |

## D. Clinical and legal sign-offs needed before the related feature is used (`32 §5`)

Phase 1 features only. Record the sign-off date and name; the signed paper goes in `docs/go-live/`.

| Feature | Signs off | Done (date, name) |
| --- | --- | --- |
| ANC schedule, risk rules, ANC card | Gynaecologist (owner) | |
| Vaccine schedule (IAP/UIP choice, `docs/40` Q14), growth charts, dose rules | Paediatrician | |
| GST treatment on OPD receipts, invoice format | Hospital CA | |
| Discharge templates, USG, MTP, lab, pharmacy | Not in Phase 1; not enabled | n/a |

## E. Inputs from the hospital (`50 §3`)

| Input | Needed for | Received (date) |
| --- | --- | --- |
| Fees and follow-up rules (Q6) | GL-01 | |
| Staff list and counters (Q9) | GL-02 | |
| OPD sheet print point: reception or vitals (Q11) | GL-03 | |
| WhatsApp number and provider (Q13) | Reminders and receipts | |
| Vaccine schedule choice (Q14) | Section D | |
| Rx verification mode (Q15) | UAT 07 | |
| Branding: name, logo, colours (Q20) and product name (Q22) | Print header, GL-03 | |
| 60+ anonymised Rx lines; 10 real OPD bills; rate list; sample prints (`32 §3`) | Parser tuning, UAT 02/04/05 | |

## F. Go / no-go record

| | |
| --- | --- |
| Meeting date | |
| Present | |
| All of A and B `Done` or `Waived` | yes / no |
| Open Blockers from UAT or the parallel run | |
| Decision | GO / NO-GO |
| First live OPD day | |
| Rollback plan if the first day fails (return to paper; who decides; when) | |
| Signatures | Owner: ______________ Vendor: ______________ |

## G. First 30 days (`00 §5`) — measured after go-live

| Measure | Target | Result |
| --- | --- | --- |
| OPD visits registered and billed in the system | 100 %; paper register stopped | |
| Returning patient: search → token → receipt | 60 s or less (average receptionist) | |
| New patient | 120 s or less | |
| Typical 4-drug Rx typed | 60 s or less | |
| Day-end cash and UPI vs counted cash and bank | no manual correction | |
| Data loss / longest outage in OPD hours | zero / 15 minutes or less | |
