# 32 — Testing and acceptance

## 1. Test layers

| Layer | Tool | Scope |
| --- | --- | --- |
| Unit | Vitest | `packages/shared`: money, GST, rounding, number formats, search normalisation, rx shorthand parser, Hindi instruction builder, EDD/GA, scan re-dating, ANC schedule, vaccine schedule + catch-up, WHO z-scores, dose ranges, infusion calc, bed-day rules, package matching |
| Integration | Vitest + real Postgres | tRPC procedures with permissions, transactions, invariants (`04 §15`), RLS for `restricted`, audit triggers, number series concurrency |
| E2E | Playwright | Critical flows below, on Chrome, at 1366×768 and tablet 1280×800 |
| Load | k6 | Peak OPD: 15 concurrent users, 40 registrations/h, 150 bills/day, search p95 < 300 ms, mutations p95 < 1 s on the reference server spec |
| Print | Playwright screenshots of print routes | Visual regression per template and paper size |
| Compliance | `pnpm check:forbidden` + specific tests | Form F gating, MTP access, H1 register |
| Ops | Scripts | Backup/restore drill, update rollback, standby promotion |

## 2. Critical E2E flows

1. New patient → visit → cash payment → token + receipt + OPD sheet print.
2. Returning patient (family by mobile) → follow-up free visit → token.
3. Vitals entry → sheet reprint with vitals.
4. Assistant scans QR → photo capture → shorthand Rx (4 drugs) + 3 orders + follow-up → save.
5. Billing of orders → UPI payment with UTR → day close with denomination counter → facility close.
6. Bill cancellation with credit note and refund approval by PIN.
7. ANC: create pregnancy from LMP → visits → re-date by scan → risk flag from BP → ANC card print.
8. Paeds: vaccine due → given with batch → next due computed → reminder queued.
9. (P2A) USG obstetric study blocked until Form F signed → report signed and printed.
10. (P2A) Admission with LSCS package → deposit → OT note with consumables → delivery + newborn → MAR → discharge summary → final bill with deposit adjustment and refund.
11. (P2A) Pharmacy: GRN → sale against Rx (FEFO) → return → H1 register entry.
12. (P2A) Lab: sample barcode → results → verify → release → WhatsApp queued.
13. (P2A) MTP: case with restricted visibility verified from a reception user's perspective.
14. (P2B) PM-JAY admission → package → patient receipt blocked → claim pack PDF.

## 3. Fixture data from the hospital (collect during discovery)

- 60+ real Rx lines (anonymised) for the shorthand parser.
- 10 real OPD bills, 5 IPD package bills with expected totals (owner verifies).
- Current rate list, package list with inclusions.
- Sample prints the hospital likes (letterhead, receipts).
- Pathologist-approved test list/ranges; paediatrician-approved vaccine schedule and dose rules; gynaecologist-approved ANC schedule and risk rules; USG doctor-approved templates; official Form F and MTP forms.

## 4. User acceptance (per phase)

- Owner, one receptionist, one assistant, one cashier, one nurse (P2) each complete the scripted UAT checklist in training mode and sign it.
- Timing targets from `00 §5` measured with real staff, not developers.
- Sign-off sheets stored in `docs/uat/` (scanned). The scripts per role are `docs/uat/01-owner.md` … `07-doctor.md`; the method and the sign-off table are in `docs/uat/README.md`.
- Load test: `pnpm load` runs `apps/web/load/k6/peak-opd.js` against a throwaway stack; results are kept in `docs/36-load-test.md`.
- Security: `docs/34-asvs-l1.md` (OWASP ASVS L1 status per item) and `apps/web/e2e/asvs.spec.ts` (executable evidence).

## 5. Clinical/legal sign-offs required before the related feature goes live

| Feature | Signs off |
| --- | --- |
| ANC schedule, risk rules, ANC card | Gynaecologist (owner) |
| Vaccine schedules, growth charts, dose rules | Paediatrician |
| USG templates, Form F screens and print, monthly report | USG doctor |
| MTP screens, forms, monthly report, confidentiality behaviour | MTP-certified doctor |
| Lab tests, units, ranges, report format | Pathologist |
| Discharge templates | Respective doctors |
| GST treatment, invoice formats | Hospital CA |
| Pharmacy invoice, H1 register | Pharmacist |
| Cardiology/ICU templates (P3) | Cardiologist |
