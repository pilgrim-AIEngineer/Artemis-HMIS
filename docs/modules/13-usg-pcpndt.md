# 13 — USG and PCPNDT Form F [Phase 2A, first item]

Feature IDs: USG-01, USG-02.

The hospital performs ultrasound and is registered under the PCPNDT Act. Mistakes here carry criminal penalties for the doctor and can lead to sealing of the machine. Build this module exactly to the official forms, have the USG doctor sign off every screen and print, and never improvise. Until this module is live, the hospital continues its current Form F process; the Phase 1 system only orders and bills USG.

## 1. Absolute rules

1. No field, option, template placeholder, free-text hint, keyboard shortcut, report section or AI output may record, display, imply or allow typing of the **sex of the fetus**. The template engine strips any user-defined field whose label or key matches the forbidden-term list (see `docs/30`). CI fails if forbidden terms appear in USG templates, seed data or schema.
2. A USG study on a pregnant woman cannot be signed/printed until its Form F is complete and signed by the doctor (DB constraint + API check). Emergency override is not provided.
3. Form F records cannot be deleted or edited after signing; corrections are addenda with reason.
4. Retain Form F and USG records at least **2 years** (PCPNDT Rules) — in practice never purge.
5. The hospital's PCPNDT registration number is printed on every USG report and Form F.

## 2. USG worklist (USG-01)

- Studies created from billed USG orders (`clinical_order.kind = usg`) or walk-in referrals (referral details required for Form F).
- Columns: token/time, patient, age, GA (if pregnant), procedure, referring doctor, status, Form F status.
- Statuses: `ordered → in_progress → report_draft → signed`; `cancelled` with reason.
- `is_pregnant` is pre-set from active pregnancy and confirmed by the operator before starting; procedures in category `obstetric` force `is_pregnant = true`.

## 3. Report templates

- Template engine: structured fields (zod schema per template version) + impression free text + optional images (uploaded from machine export or captured screen).
- Seed templates (USG doctor to finalise wording):
  - Obstetric early (< 14w): gestational sac, CRL, GA by CRL, cardiac activity, FHR, number of gestations, chorionicity (if multiple), adnexa, impression.
  - NT/NB scan (11–13w6d): CRL, NT mm, nasal bone, FHR, other markers per doctor's format.
  - Anomaly scan (18–22w): biometry (BPD, HC, AC, FL), EFW, placenta location/grade, liquor (AFI/SDP), structures checklist (doctor's format), cervical length, impression.
  - Growth/late (> 24w): biometry, EFW, centile (if doctor wants), presentation, placenta, liquor, Doppler indices (UA PI, MCA PI, CPR) optional, impression.
  - Gynae pelvis (TAS/TVS), follicular study (serial with dates and follicle sizes table), abdomen, others.
- **GA by biometry** calculations (Hadlock formulas) are optional helpers in `packages/shared/obstetric-biometry.ts`, unit-tested against published tables, shown as suggestions only.
- Signed report PDF stored; printable A4 with hospital header, PCPNDT reg no., doctor name/qualification/signature, and the mandatory statement setting `usg.reportFooter` (e.g., the hospital's standard declaration that sex determination is not done — wording supplied by the doctor).

## 4. Form F (USG-02)

### 4.1 Source of truth

Implement Form F exactly as in the current PC&PNDT Rules (Form F as amended in 2014, with sections for all diagnostic procedures, non-invasive procedures, invasive procedures and declarations). Before coding, obtain:
- the latest official Form F text (Gazette/MoHFW PCPNDT website), and
- the Uttar Pradesh online Form F format if the district uses an online portal.
Store the schema as `FormFv1` (versioned zod schema + layout). If the law changes, add `FormFv2`; never mutate v1.

### 4.2 Data capture (fields as per the official form; summary)

- Centre details (auto from facility).
- Patient: name, age, address, contact; husband/father name; number of living children with the age and sex of each **living child** (this is about already-born children, required by the form — do not confuse with fetal sex).
- Referral: referring doctor/centre with address, or self-referral with reason (as the form requires); referral slip upload.
- LMP / weeks of pregnancy.
- Procedure section: indication(s) for non-invasive procedure (checkbox list exactly as in the form), procedure performed, date, result summary (normal/abnormal as per form), name of doctor performing.
- Invasive procedure section (if any performed): only if the hospital does invasive procedures; otherwise hidden but supported in schema.
- Declarations: doctor's declaration (signed) and pregnant woman's declaration (signed on print or thumb impression) — printed for wet signature, scanned back and attached (`document kind = form_f_signed`). The doctor's e-signature on screen records `doctor_declaration_signed_at` but the physical signed copy is still required.

### 4.3 Workflow

1. Operator opens study → Form F tab auto-filled from patient/pregnancy/referral data; missing mandatory fields highlighted.
2. Patient declaration printed and signed before the scan (setting `pcpndt.patientDeclarationBeforeScan`, default true) → scan uploaded.
3. Doctor performs scan, completes Form F result fields, signs declaration (PIN) → `form_f.status = signed`.
4. Report can now be signed.
5. Form F printed (A4) for the register; signed copy scanned and attached.

### 4.4 Monthly report

- On the 1st of each month the worker generates a draft list of all Form F of the previous month (with counts by indication) as PDF + CSV in the official/district format.
- Staff submit by the **5th** (to the Appropriate Authority / online portal), then mark submitted with date and reference (`pcpndt_monthly_report`).
- Dashboard alert from the 1st until submitted.

### 4.5 Registers and inspection readiness

- Form F register view (filter by month), printable.
- USG machine register (`usg_machine`) with serial numbers and registration reference.
- "Inspection mode" printout bundle: register for a date range, signed Form F PDFs, machine list, registration certificate (uploaded).
- Access to Form F data restricted to `pcpndt.*` and owner; every view logged.

## 5. Acceptance

- Cannot sign an obstetric report without a signed Form F (API + DB tests).
- Forbidden-term CI check passes and is proven to fail on a seeded bad template.
- USG doctor signs off each template and the Form F print against the official form (checklist in `docs/32`).
- Monthly report counts match the register for test months.
