# 30 — Compliance requirements

This is an engineering checklist, not legal advice. Each item names who must confirm it. Where a law prescribes a form, implement the official form text obtained by the human, stored as a versioned schema; do not write forms from memory.

## 1. PCPNDT Act 1994 and Rules (USG) — confirm with USG doctor / Appropriate Authority

- Form F for every pregnant woman undergoing ultrasonography; doctor and patient declarations; report gating (`13`).
- Monthly report to the Appropriate Authority by the 5th of the following month.
- Records retained ≥ 2 years (keep indefinitely).
- No determination, recording or communication of fetal sex — enforced in software (below).
- Registration number on reports; machine register.

### Forbidden-term check (`pnpm check:forbidden`, runs in CI)

- Scans: `packages/print/**/usg*`, `packages/shared/**/usg*`, `packages/db/schema/usg*`, `packages/db/seed/**/usg*`, `packages/shared/forms/form-f*`, any AI prompt files, and user-defined USG template JSON exported from the DB in tests.
- Case-insensitive patterns (extend as needed): `fetal sex`, `foetal sex`, `sex of (the )?f(o)?etus`, `gender of (the )?f(o)?etus`, `f(o)?etal gender`, `baby gender`, `boy or girl`, `male fetus`, `female fetus`, `\bladka\b`, `\bladki\b`, `लड़का`, `लड़की`, `भ्रूण.*लिंग`, `लिंग`.
- Scope and identifier normalisation were widened by decision D-5 (`docs/40-open-questions.md`); D-5 overrides the path list above.
- Allowlist (exact keys only): `living_children[].sex` in Form F (sex of already-born living children, required by the form). Newborn/birth-register code paths (`newborn`, `birth_record`) are outside the scanned paths — sex of a born baby is normal data.
- Runtime guard: USG template editor rejects field labels/keys matching the patterns.

## 2. MTP Act 1971 (amended 2021), MTP Rules and Regulations — confirm with MTP-certified doctor

- Approved place and certified RMP(s); consent, opinion, admission register, monthly report (`14`).
- Confidentiality of the woman's identity; disclosure is an offence — restricted schema, RLS, access logging, no messaging.
- Retention per regulations (5 years from end of the calendar year of entry, as currently understood — confirm).

## 3. Registration of Births and Deaths Act 1969 (amended 2023) — confirm with hospital admin

- Institutions report births, deaths and still-births to the Registrar (CRS) within 21 days; MCCD for deaths (`18`).

## 4. Clinical Establishments Act (adopted by UP) and medical records — confirm with owner

- Registration number on records; maintain medical records and furnish reports as required.
- IMC (Professional Conduct, Etiquette and Ethics) Regulations 2002 (in force while NMC 2023 regulations are in abeyance): IPD records kept at least 3 years; copies to patients on request within 72 hours. The software never deletes clinical records and provides a "records request" log (requested, provided, by whom).
- Doctor's name, qualification and registration number on prescriptions and reports.

## 5. Drugs and Cosmetics Act and Rules — confirm with pharmacist

- Drug licence numbers on invoices; sale of prescription drugs against prescription.
- Schedule H1 register (prescriber, patient name/address, drug, qty) retained ≥ 3 years.
- Schedule X / NDPS registers if stocked.
- Expired drugs not sold; returns/destruction recorded.

## 6. GST — confirm every rate with the hospital's CA

- Healthcare services by clinical establishments exempt (SAC 9993).
- Non-ICU room rent > ₹5,000 per day: 5% (no ITC). ICU/CCU/NICU exempt.
- Pharmacy retail sales taxable by HSN rate (rates were rationalised in 2025 — import current rates; never hard-code).
- Medicines/consumables in IPD treatment: part of exempt healthcare supply.
- If the pharmacy is a separate legal entity/GSTIN, its invoices carry its own name/GSTIN (`store` level legal entity — see open questions).

## 7. Digital Personal Data Protection Act 2023 and DPDP Rules 2025

- Hospital = data fiduciary; we (vendor) = data processor under a written data processing agreement.
- Most obligations apply from May 2027 (consent manager provisions earlier). Build now:
  - Notice + consent capture at registration (`patient_consent`), purpose-specific (treatment, WhatsApp, ABDM sharing later).
  - Access controls, audit/access logs, encryption at rest and in backups.
  - Breach response runbook (detect, contain, notify hospital without delay; hospital notifies Board/patients as required).
  - Data export for a patient (all records as PDF/JSON) and correction workflow.
  - Retention policy: clinical/legal records retained as required by the laws above (which override erasure requests for those records); marketing/consent data deletable.
- Children's data (paediatrics): processing for treatment; no tracking/marketing.

## 8. CERT-In directions (2022)

- Report cyber incidents to CERT-In within 6 hours (vendor + hospital roles in the runbook).
- Keep system logs for 180 days (within India). Synchronise server clock with NTP (Indian NTP servers or standard pools).

## 9. PM-JAY (SHA/NHA guidelines) — confirm with PM-JAY desk

- Cashless to beneficiary; no collection from patient for covered packages; documents and photos per guidelines; data on TMS (`22`).

## 10. Telemedicine Practice Guidelines 2020 (only if teleconsults are started)

- Record of teleconsult, identity verification, e-prescription format.

## 11. Implants price control (Phase 3) — confirm with cardiologist/admin

- NPPA ceiling prices for coronary stents (and other notified devices) — bill separately with brand, batch and MRP; billed price ≤ cap.
