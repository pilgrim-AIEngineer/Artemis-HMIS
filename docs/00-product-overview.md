# 00 — Product overview, scope and feature IDs

## 1. Goal

Replace paper registration, OPD billing and registers at the pilot hospital with software that is faster than paper for slow typists, works without internet, keeps the hospital legally safe (PCPNDT, MTP, birth registration, drug registers), and grows into a full HMIS with PM-JAY, TPA, cardiology, ICU/CCU and cath lab without rework.

## 2. Pilot hospital facts (confirmed with owner)

| Topic | Answer | Design consequence |
| --- | --- | --- |
| USG in-house | Yes | Form F (PCPNDT) gating, USG reports, monthly report |
| MTP | Yes | Restricted MTP register (Forms C, I, II, III), strict access control |
| Pharmacy | Yes, in-house | Batch/expiry stock, GST invoices, H1 register, IPD issue |
| Lab | Yes, in-house | Orders, samples, results, verification, reports |
| Staff computer skill | Can operate, not efficient | Guided flows, big targets, defaults, Hindi, minimal typing, forgiving undo |
| Rx | Doctor writes on paper; assistant enters | Pre-filled printed OPD sheet + QR; fast transcription screen; photo of paper Rx attached |
| Packages | Yes | Package master with inclusions/exclusions and per-payer rates |
| Payments | Cash, UPI via static QR | UPI recorded with optional UTR; daily UPI reconciliation report |
| Internet | Jio Fiber, can upgrade; hardware can be bought | Local server; second ISP as backup; offline-safe |
| PM-JAY | Applied | PM-JAY payer and package billing ready soon after empanelment (Phase 2B) |
| Next year | Cardiologist joins; cath lab, ICU, CCU | Stores, implants, critical-care charting, cardiology templates in Phase 3; payer/department/store structures exist from Phase 1 |

## 3. Phases and feature IDs

Hermes plans the work; this list defines **what** exists in each phase. Feature IDs are referenced in commits and tests.

### Phase 1 — OPD go-live (first production release)

| ID | Feature | Spec |
| --- | --- | --- |
| FND-01 | Monorepo, Docker Compose, CI, lint, typecheck | 01 |
| FND-02 | Auth: login, sessions, PIN unlock, password reset by admin | 03 |
| FND-03 | Roles, permissions, user management | 03 |
| FND-04 | Audit log triggers, access log | 02, 04 |
| FND-05 | Number series per FY | 02, 04 |
| FND-06 | Settings, facility profile, print header, i18n en/hi | 01, 05 |
| FND-07 | Masters UI: departments, doctors, services, tariffs, payers (Cash only active), drugs (basic list for Rx), lab test list (for orders), USG procedures (for orders) | 33 |
| REG-01 | Patient registration + family by mobile + duplicate check | 10 |
| REG-02 | Fuzzy patient search (name, mobile, UHID) | 10 |
| REG-03 | Visit creation with doctor, visit type, fee auto-fill and follow-up validity | 10, 12 |
| REG-04 | Token issue, queue per doctor, queue states, priority | 10 |
| REG-05 | Waiting-hall TV display | 10 |
| REG-06 | Pre-filled printed OPD sheet (A5) with QR | 10 |
| REG-07 | Patient sticker / UHID card print | 10 |
| OPD-01 | Vitals entry (adult, pregnant, child) with out-of-range flags | 11 |
| OPD-02 | Rx transcription screen (assistant) with shorthand entry | 11 |
| OPD-03 | Photo/scan of paper Rx attached to visit | 11 |
| OPD-04 | Orders from transcription: lab, USG, procedures, admission advice, follow-up date | 11 |
| OPD-05 | ANC card: pregnancy, GPAL, ANC visits, schedule, risk flags | 11 |
| OPD-06 | Paeds: immunisation schedule and records, growth charts, dose check | 11 |
| OPD-07 | Patient timeline (visits, Rx, orders, bills) | 11 |
| BIL-01 | OPD bill from visit + orders; add/remove items | 12 |
| BIL-02 | Payments: cash, UPI (static QR, optional UTR), card, split | 12 |
| BIL-03 | Discounts with role limits and reasons | 12 |
| BIL-04 | Cancellations and refunds via credit note | 12 |
| BIL-05 | Receipt print (80 mm thermal and A5) | 12 |
| BIL-06 | Day-end close per user and facility summary | 12 |
| RPT-01 | Daily collection, OPD counts, ANC register, vaccines due, discounts/cancellations | 20 |
| RPT-02 | Owner dashboard (phone, read-only) | 20 |
| MSG-01 | WhatsApp outbox, templates, receipts and reminders | 21 |
| OPS-01 | Server install, backups (USB + cloud), monitoring, update script | 31 |
| MIG-01 | Import existing patient list and rate list from Excel/CSV | 10 |

### Phase 2A — Hospital core

| ID | Feature | Spec |
| --- | --- | --- |
| USG-01 | USG worklist, report templates (obstetric, gynae, others) | 13 |
| USG-02 | Form F (PCPNDT) with gating, declarations, monthly report | 13 |
| MTP-01 | MTP register (restricted): consent, opinion, admission register, monthly report | 14 |
| INV-01 | Stores, item master, suppliers | 15 |
| INV-02 | Purchase entry, GRN, batch/expiry, purchase return | 15 |
| INV-03 | Pharmacy sale (OPD/walk-in), returns, GST invoice | 15 |
| INV-04 | Indents and transfers between stores; IPD issue/return | 15 |
| INV-05 | H1 register, expiry alerts, reorder, stock valuation, GST reports | 15 |
| LAB-01 | Test masters, panels, reference ranges | 16 |
| LAB-02 | Sample collection with barcode, results entry, verification, report | 16 |
| IPD-01 | Wards, bed categories, beds, live bed board | 17 |
| IPD-02 | Admission, attendant, consents, transfers, daily auto-charges | 17 |
| IPD-03 | Doctor IPD orders and progress notes (assistant-entered allowed) | 17 |
| IPD-04 | Nursing: TPR/vitals chart, intake-output, MAR, notes, handover | 17 |
| BIL-07 | Packages, deposits, interim and final IPD bill, refunds | 12 |
| OT-01 | OT schedule, pre-op checklist, OT note, consumables to bill | 18 |
| LR-01 | Labour room: partograph (simplified), delivery note | 18 |
| NB-01 | Newborn registration linked to mother; birth/death/still-birth registers | 18 |
| DIS-01 | Discharge summary templates, print, WhatsApp | 19 |
| RPT-03 | IPD, OT, delivery, pharmacy, lab, legal monthly reports | 20 |
| OPS-02 | Standby server with streaming replication | 31 |

### Phase 2B — PM-JAY ready (start as soon as empanelment is approved)

| ID | Feature | Spec |
| --- | --- | --- |
| PAY-01 | Multi-payer model activated: payer types, payer-specific tariffs and package rates | 12, 22 |
| PAY-02 | PM-JAY beneficiary details on visit/admission, HBP package mapping | 22 |
| PAY-03 | Pre-auth and claim tracker with document checklist and TMS reference numbers | 22 |
| PAY-04 | PM-JAY bill (zero patient share), claim document pack PDF, claim ageing report | 22 |

### Phase 3 — Cardiology, critical care, insurance

| ID | Feature | Spec |
| --- | --- | --- |
| CAR-01 | Cardiology OPD templates, ECG upload/report, Echo/TMT/Holter reports | 23 |
| ICU-01 | ICU/CCU beds, hourly flowsheet, infusions, ventilator settings, scores | 23 |
| CTH-01 | Cath lab schedule, procedure reports (CAG, PTCA, etc.) | 23 |
| CTH-02 | Implants and consignment stock with barcode/UDI, price-cap display | 15, 23 |
| PAY-05 | TPA/insurance desk: cashless pre-auth, enhancement, queries, final claim, settlement | 22 |
| PAY-06 | Corporate credit billing, CGHS/ECHS rate lists | 22 |
| ABD-01 | ABDM M1 (ABHA create/verify, Scan and Share) | 24 |
| ABD-02 | ABDM M2/M3 (HIP/HIU) | 24 |
| NHX-01 | NHCX claims | 24 |

## 4. Out of scope (until told otherwise)

HR/payroll, purchase approval workflows, full accounting ledger (export to Tally instead), PACS/DICOM storage, patient mobile app, telemedicine video, lab analyser interfacing (Phase 3+), multi-hospital admin UI (but keep `facility_id`).

## 5. Success criteria for Phase 1 (measured over 30 days live)

- 100% of OPD visits registered and billed in the system; paper OPD register stopped.
- Returning patient: search → token → receipt in ≤ 60 s by an average receptionist. New patient ≤ 120 s.
- Assistant transcribes a typical 4-drug Rx in ≤ 60 s.
- Day-end cash/UPI totals match counted cash and bank UPI credits without manual correction.
- Zero data loss; no outage longer than 15 minutes during OPD hours.
