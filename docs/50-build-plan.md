# 50 — Build plan (Phase 1: OPD go-live)

Status: proposed by Hermes, 25-Oct-2026. Repo state at start: spec only (`AGENTS.md` + `docs/`), no code.

## 1. Working method

- One PR per row below, branch `hermes/<feature-id>-<slug>`, conventional commits with feature IDs (`feat(FND-05): ...`).
- Code written by Claude Code inside the repo; Hermes runs `pnpm lint typecheck test check:forbidden` before opening each PR.
- PRs that add/alter migrations are labelled `migration` and need the human's review (`02 §10`).
- Open questions in `40` are never guessed; the listed defaults are used and marked with a `setting` key so they can change without code.
- Clinical content (ANC schedule, vaccine schedule, dose rules) is built from the drafts in `33` and flagged "pending sign-off" until the doctors approve (`32 §5`).

## 2. Milestones and PR sequence

Ordering follows dependencies: foundation → registration → billing → clinical → reports/messaging → ops. Critical E2E flows from `32 §2` are added as soon as their screens exist.

### M0 — Skeleton (week 1)

| PR | IDs | Scope | Done when |
| --- | --- | --- | --- |
| 1 | FND-01 | pnpm + Turborepo; `apps/web` (Next.js App Router, tRPC v11), `apps/worker` (pg-boss stub), `packages/{db,shared,print,ui}`; strict TS, ESLint, Prettier; Vitest + Playwright wired; `infra/docker` compose (`caddy`, `web`, `worker`, `postgres`, `backup` placeholder); GitHub Actions CI (lint, typecheck, test with Postgres service, check:forbidden); `pnpm check:forbidden` from `30 §1`; `CLAUDE.md -> AGENTS.md` | `pnpm dev` boots, `/api/health` returns DB ok, CI green |

### M1 — Foundation (weeks 1–3)

| PR | IDs | Scope | Done when |
| --- | --- | --- | --- |
| 2 | FND-04, FND-05 | Platform schema (`04 §1`): facility, user, role, permission, user_role, session, setting, number_series, audit_log, access_log, idempotency, document, print_log, workstation, outbox. Generic audit trigger, `withTx(ctx, fn)` with `SET LOCAL app.user_id/workstation_id`, append-only grants, UUIDv7, FY helper | Integration tests: audit captured on I/U, audit not updatable by app role, number series gap-free under 50 concurrent allocations, FY rollover |
| 3 | — (shared) | `packages/shared`: money (paise, `formatINR`, `applyPercentBp`, round-off), GST per-line split, dates/age display, FY, Indian-name search normalisation + phonetic, settings zod schema | Unit tests per `32 §1` for these functions |
| 4 | FND-02, FND-03 | Login (argon2id, lockout), sessions (12 h / 10 min idle), PIN unlock keypad, admin password reset, TOTP for owner/admin remote, roles + permission keys from `03`, `protectedProcedure` with `requirePermission`, user management UI, workstation pairing | Integration tests: every procedure denies without permission; lockout; idle → PIN |
| 5 | FND-06 | Facility profile, print header, settings UI, next-intl en/hi, app shell with role homes, `packages/print` base (A4/A5/thermal80/label, bundled Noto fonts), print route + print_log + DUPLICATE watermark | Sample print renders at each paper size (Playwright screenshot) |
| 6 | FND-07 | Masters (`04 §2`, `33`): departments, doctors, services, tariffs, payers (Cash active), drug list, lab test list, USG procedures; masters UI with TanStack Table; `pnpm db:seed` (+ `--demo` skeleton) | Seed loads; masters CRUD (soft-cancel only) audited |

### M2 — Registration and queue (weeks 3–5)

| PR | IDs | Scope |
| --- | --- | --- |
| 7 | REG-01, REG-02 | Patient registration, family by mobile, duplicate check, trigram + phonetic search, UHID series |
| 8 | REG-03, REG-04 | Visit creation, fee auto-fill, follow-up validity (default 7 days / 1 free — Q6), tokens per doctor per day (advisory lock), queue states/priority, SSE via LISTEN/NOTIFY + 5 s polling fallback |
| 9 | REG-05, REG-06, REG-07 | TV display (`/display/queue`, display key, tokens only), A5 OPD sheet with QR (prints after vitals by default — Q11), sticker/UHID card |

### M3 — OPD billing (weeks 5–7)

| PR | IDs | Scope |
| --- | --- | --- |
| 10 | BIL-01, BIL-02 | OPD bill from visit (+ orders once PR 14 lands), payments cash/UPI(+UTR)/card/split, idempotency keys, invariant `04 §15.1–2` |
| 11 | BIL-03, BIL-04 | Discount limits by role + PIN approval, cancellation via credit note, refunds with approval |
| 12 | BIL-05, BIL-06 | Receipts thermal80 + A5, day-end close per user with denomination counter, facility summary, UPI reconciliation |

E2E flows 1, 2, 5, 6 land with M3.

### M4 — OPD clinical (weeks 7–10)

| PR | IDs | Scope |
| --- | --- | --- |
| 13 | OPD-01 | Vitals (adult / pregnant / child) with range flags; sheet reprint with vitals (E2E 3) |
| 14 | OPD-02, OPD-03, OPD-04 | Rx transcription with shorthand parser + Hindi instruction builder, photo capture (client-side compression), orders (lab/USG/procedure/admission advice/follow-up), draft autosave (E2E 4) |
| 15 | OPD-05 | ANC: pregnancy (one active), GPAL, EDD/GA, scan re-dating, ANC schedule, risk flags, ANC card print (E2E 7) — pending gynaecologist sign-off |
| 16 | OPD-06 | Paeds: immunisation (IAP default — Q14) with catch-up, growth charts (WHO z-scores), dose check (E2E 8) — pending paediatrician sign-off |
| 17 | OPD-07 | Patient timeline (excludes `restricted`) |

### M5 — Reports, messaging, migration, ops (weeks 10–12)

| PR | IDs | Scope |
| --- | --- | --- |
| 18 | RPT-01, RPT-02 | Daily collection, OPD counts, ANC register, vaccines due, discounts/cancellations; owner phone dashboard |
| 19 | MSG-01 | Outbox + worker sender (Meta Cloud API adapter — Q13), templates, retry 48 h, receipts + `reminder.daily` |
| 20 | MIG-01 | Excel/CSV import for patients and rate list with dry-run + error report |
| 21 | OPS-01 | `install.sh`, `update.sh` with rollback, backups (pgBackRest/restic to USB + S3 Mumbai), `backup-check.sh`, `restore-drill.sh`, `/api/health`, monitoring alerts |
| 22 | — | Hardening: k6 load test at `32 §1` targets, ASVS L1 checklist, `--demo` seed complete, UAT scripts, go-live checklist (`31 §7`) |

## 3. Inputs needed from the hospital before go-live (not blocking development)

From `40`: Q6 fees/follow-up rules, Q9 staff list + counters, Q11 OPD-sheet print point, Q13 WhatsApp number/provider, Q14 vaccine schedule, Q15 Rx verification mode, Q20 branding, Q22 product name. From `32 §3`: anonymised Rx lines, sample bills, rate list, preferred print samples.

## 4. Risks

- Shorthand Rx parser quality depends on real Rx samples; build with synthetic fixtures, retrain rules when samples arrive.
- Speed targets (`00 §5`) can only be proven with real staff; schedule a timing session on the demo seed before UAT.
- Print layouts on the hospital's actual printers (thermal width, A5 trays) must be checked on site.
