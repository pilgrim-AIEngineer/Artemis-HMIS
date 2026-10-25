# AGENTS.md — HMIS (working name) for Indian hospitals

Read this file fully before writing any code. Then read the docs listed under "Doc index" that relate to your task. If this file or a doc conflicts with a task description, this file wins; ask the human if a conflict touches money, legal registers or patient data.

> Tip: symlink `CLAUDE.md -> AGENTS.md` so every coding agent loads the same rules.

## 1. What we are building

A Hospital Management Information System (HMIS) for small and mid-sized private hospitals in India, sold first to one hospital (the "pilot hospital") and later to many. It is one product, never a custom fork per client. Client-specific needs become configuration.

Pilot hospital (Uttar Pradesh, India):
- About 40 beds. Gynaecology and obstetrics hospital run by the owner gynaecologist, plus one paediatrician.
- About 150 OPD patients per day, peak 9 am – 2 pm.
- In-house: ultrasound (USG), MTP services, pharmacy, pathology lab, OT and labour room.
- Doctors write prescriptions on paper. An assistant enters them into the system.
- Staff can use computers but are slow and error-prone. UX must be simple, guided and forgiving.
- Payments: cash and UPI via a printed static QR code. Deposits mostly cash/UPI. Packages are used for deliveries and surgeries.
- Internet: Jio Fiber (unreliable at times). System runs on a LOCAL SERVER at the hospital; internet is optional.
- Applied for Ayushman Bharat PM-JAY empanelment.
- Next year: the owner's son (cardiologist) joins. Cath lab, ICU and CCU will be set up. Then TPA/insurance, PM-JAY, corporate billing are needed.

## 2. Stack (fixed — do not change without asking)

| Concern | Choice |
| --- | --- |
| Language | TypeScript everywhere, `strict: true` |
| Monorepo | pnpm workspaces + Turborepo |
| Web app + API | Next.js (latest stable, App Router), React, tRPC v11 for internal API, zod for all input validation |
| UI | Tailwind CSS, shadcn/ui (Radix), TanStack Table, react-hook-form, lucide-react icons |
| i18n | next-intl, locales `en` and `hi` |
| Database | PostgreSQL 16+ with `pg_trgm`, `unaccent`, `pgcrypto` |
| ORM / migrations | Drizzle ORM + drizzle-kit, SQL migrations committed |
| Jobs | pg-boss (Postgres-backed queue) in `apps/worker` |
| PDF | HTML templates rendered by headless Chromium (Playwright) in the worker |
| Auth | Custom table-backed sessions, argon2id password hashing, per-user 4–6 digit PIN for quick unlock |
| Tests | Vitest (unit/integration against a real Postgres via Testcontainers or docker compose), Playwright (E2E) |
| Runtime | Docker Compose on Ubuntu Server 24.04 LTS: `caddy`, `web`, `worker`, `postgres`, `backup` |
| Remote ops | Tailscale; no inbound ports on the hospital router |

## 3. Non-negotiable rules

1. **Money is integer paise** (`bigint`). Never floats. Rates in rupees are converted at the edge. GST rates are basis points (500 = 5%).
2. **IDs are UUIDv7** generated in the app (`uuidv7` package). Human numbers (UHID, bill no.) come from `number_series` inside the same DB transaction.
3. **Every table has `facility_id`** (even with one hospital) plus `created_at`, `updated_at`, `created_by`, `updated_by`. Timestamps are `timestamptz`; display in `Asia/Kolkata`.
4. **No hard deletes** of clinical, financial, legal or inventory rows. Use `status` + `cancel_reason` + `cancelled_by/at`. Corrections create new rows (credit note, addendum, reversal movement).
5. **Audit everything**: all inserts/updates on business tables are captured in `audit_log` by DB trigger. Reads of restricted records (MTP, Form F) are logged by the app in `access_log`.
6. **Permissions are enforced on the server** in every tRPC procedure via `requirePermission('module.action')`. UI hiding is cosmetic only.
7. **Fetal sex is never stored, displayed, inferred or printed.** No field, enum value, template placeholder, free-text hint or AI output may carry it. A CI test greps schema, templates and seed data for forbidden terms (see `docs/30-compliance.md`).
8. **MTP data is restricted**: separate Postgres schema `restricted`, separate permissions, excluded from global search, patient timeline and general reports.
9. **Payments are idempotent**: every payment/deposit/refund mutation takes a client-generated `idempotency_key`; duplicate submits return the original result.
10. **Financial year** is April–March. Number series reset per FY per facility.
11. **Never block the counter on the internet.** WhatsApp, cloud backup and future integrations go through the outbox/queue and retry.
12. **All user-facing strings via i18n keys** (`en`, `hi`). Printouts meant for patients are bilingual.
13. **Tests are mandatory** for money math, number series, package logic, GST, day-end close, stock movement, EDD/GA, vaccine due dates, Form F gating, MTP access control.
14. **Migrations are additive**. Never drop or rename a column in one step. Two-step expand/contract only, with the human's approval.
15. **No patient data in logs**, error trackers or URLs. Use IDs.
16. **One product**: no `if (facility === 'X')`. Use settings/feature flags in the `setting` table.

## 4. Repo layout

```
apps/
  web/            Next.js app (UI + tRPC router + print routes)
  worker/         pg-boss jobs: WhatsApp outbox, PDFs, reminders, backup checks, reports
packages/
  db/             Drizzle schema, migrations, seed, number-series, audit triggers
  shared/         zod schemas, permission keys, enums, money/date utils, clinical calculators
  print/          HTML print templates (A4, A5, 80mm thermal) shared by web print + worker PDF
  ui/             shared shadcn components, keypad, patient header, money input
infra/
  docker/         compose files, Caddyfile, Dockerfiles
  scripts/        install.sh, update.sh, backup-check.sh, restore-drill.sh
docs/             this spec
```

## 5. Commands (create these scripts)

- `pnpm dev` – web + worker + local postgres via compose
- `pnpm db:generate` / `pnpm db:migrate` / `pnpm db:seed` (`--demo` adds 500 fake patients and 30 days of OPD)
- `pnpm test` (Vitest), `pnpm e2e` (Playwright), `pnpm lint`, `pnpm typecheck`
- `pnpm check:forbidden` (compliance grep, runs in CI)

## 6. Doc index

| File | Read when working on |
| --- | --- |
| `docs/00-product-overview.md` | anything: scope, phases, feature IDs |
| `docs/01-architecture.md` | infra, app structure, printing, jobs, offline behaviour |
| `docs/02-conventions.md` | any code |
| `docs/03-roles-permissions.md` | auth, any procedure, any screen |
| `docs/04-data-model.md` | schema, migrations, queries |
| `docs/05-ux-guidelines.md` | any screen |
| `docs/modules/10-registration-queue.md` | patients, tokens, queue, OPD sheet |
| `docs/modules/11-opd-clinical.md` | vitals, Rx transcription, ANC, paeds |
| `docs/modules/12-billing-payments.md` | services, tariffs, bills, payments, deposits, packages, day close |
| `docs/modules/13-usg-pcpndt.md` | USG reports, Form F |
| `docs/modules/14-mtp.md` | MTP register |
| `docs/modules/15-pharmacy-inventory.md` | stores, purchase, stock, sales, H1 |
| `docs/modules/16-lab.md` | lab |
| `docs/modules/17-ipd-nursing.md` | admission, beds, nursing, orders |
| `docs/modules/18-ot-labour-newborn.md` | OT, labour room, newborn, birth/death registers |
| `docs/modules/19-discharge.md` | discharge summary |
| `docs/modules/20-reports-dashboard.md` | reports |
| `docs/modules/21-whatsapp-notifications.md` | messaging |
| `docs/modules/22-pmjay-tpa-corporate.md` | payers, PM-JAY, TPA, corporate |
| `docs/modules/23-cardiology-critical-care.md` | cardiology, ICU/CCU, cath lab |
| `docs/modules/24-abdm-nhcx.md` | future integrations |
| `docs/30-compliance.md` | legal rules, forbidden-term check |
| `docs/31-deployment-ops.md` | server, backups, updates, monitoring |
| `docs/32-testing-acceptance.md` | tests, acceptance per phase |
| `docs/33-seed-masters.md` | initial master data |
| `docs/40-open-questions.md` | unresolved decisions (never guess these) |

## 7. Definition of done (every feature)

- Feature ID from `docs/00` referenced in the PR/commit.
- zod-validated inputs, server-side permission check, audit captured.
- en + hi strings.
- Works with keyboard only and with touch on a 10-inch tablet.
- Unit tests for logic; E2E updated if it touches a critical flow (`docs/32`).
- Print layout checked at its paper size if it prints.
- No new `TODO` without an issue reference.

## 8. Glossary

| Term | Meaning |
| --- | --- |
| UHID | Unique Hospital ID for a patient |
| OPD / IPD | Out-patient / in-patient department |
| ANC | Antenatal care (pregnancy check-ups) |
| LMP / EDD / GA | Last menstrual period / expected date of delivery / gestational age |
| G P A L | Gravida, Para, Abortions, Living children (obstetric score) |
| NVD / LSCS | Normal vaginal delivery / lower-segment caesarean section |
| USG | Ultrasonography |
| PCPNDT / Form F | Pre-Conception and Pre-Natal Diagnostic Techniques Act / record mandatory for every prenatal scan |
| MTP | Medical termination of pregnancy (MTP Act 1971, amended 2021) |
| PM-JAY / AB | Ayushman Bharat Pradhan Mantri Jan Arogya Yojana |
| HBP | Health Benefit Package (PM-JAY package master) |
| TMS | PM-JAY Transaction Management System (web portal) |
| SHA | State Health Agency (UP: SACHIS) |
| PMAM / Arogya Mitra | PM-JAY help desk staff at the hospital |
| TPA | Third-party administrator for health insurance |
| CGHS / ECHS | Central Govt / Ex-servicemen health schemes |
| ABHA / HFR / HPR | ABDM health ID / facility registry / professional registry |
| NHCX | National Health Claims Exchange |
| FEFO | First expiry, first out |
| H1 register | Schedule H1 drug sale register |
| MAR | Medication administration record |
| TPR | Temperature, pulse, respiration chart |
| CAG / PTCA | Coronary angiography / angioplasty |
| UTR | UPI transaction reference number |
| SAC / HSN | GST codes for services / goods |
