# 22 — PM-JAY, TPA/insurance, corporate, CGHS/ECHS

Feature IDs: PAY-02 … PAY-04 (Phase 2B), PAY-05, PAY-06 (Phase 3).

The hospital has applied for PM-JAY empanelment (in UP the State Health Agency is SACHIS). PM-JAY cases are processed on the government **TMS** portal by the hospital's PM-JAY desk (Arogya Mitra). In Phase 2B our system does **not** integrate with TMS by API; it keeps the hospital's own records correct, prepares documents, tracks status and prevents patient over-charging. NHCX/HMIS integration comes in Phase 3 (`24`).

Confirm all PM-JAY rules below with the SHA guidelines and the hospital's PM-JAY desk before go-live; they change via circulars.

## 1. Payer setup (PAY-01 prerequisite)

- `payer` rows: `PM-JAY (SACHIS UP)` type `pmjay`; later each TPA/insurer, corporates, CGHS, ECHS.
- Tariff per payer. For PM-JAY the tariff holds **HBP package rates** applicable to the hospital (state rates and any NABH/entry-level incentive uplift as per the hospital's empanelment letter). Import from Excel: package code, name, specialty, rate, pre-auth required, special conditions, whether reserved for public hospitals.
- `package_rate.payer_package_code` stores the HBP code; hospital packages map to HBP codes where applicable.

## 2. PM-JAY encounter (PAY-02)

- On visit/admission, payer = PM-JAY → capture: beneficiary ID / PM-JAY ID (from verification on TMS/BIS), family ID (if any), name as per card, verification reference, Aadhaar last 4 (never full), beneficiary photo (document). Store in `patient_payer_coverage` + `patient_identifier(type=pmjay_id)`.
- Select HBP package(s) for the admission; system shows rate, pre-auth requirement and document checklist from `payer_document_rule`.
- Patient share is ₹0 for covered services. Setting `pmjay.blockPatientCharges` (default true): billing cannot collect money from the patient on a PM-JAY encounter without owner override + reason (to stay compliant with cashless rules).
- Pharmacy and lab charges during the stay are posted to the PM-JAY bill as inside-package (for internal costing) with payer share; they are not billed to the patient.
- Bill shows package code/name, amount claimable, and internal cost breakdown (for the owner's profitability report).

## 3. Pre-auth and claim tracker (PAY-03, PAY-04)

- `preauth`: TMS case/reference no., package codes, requested and approved amounts, status timeline (submitted, query with due date, approved, rejected, enhancement), notes. Status updated manually by the PM-JAY desk from TMS.
- `claim`: after discharge — claim submission date, TMS claim ref, claimed amount, query/resolution, approved amount, deductions with reasons, settlement date, UTR, amount received.
- Document checklist per stage with upload status: ID/PM-JAY card, admission photo, investigation reports, OT/delivery note, discharge summary, discharge photo, bills, implant stickers (cardiology later), others per package. **Claim document pack** PDF: merges all required documents in order with a cover sheet (case details, document index) for upload on TMS.
- Alerts: query due dates, cases discharged but claim not submitted after N days (setting), claims pending settlement > 30 days.
- Reports: claim ageing (0–15, 16–30, 31–60, > 60 days), rejection/deduction reasons, revenue by package, internal cost vs package rate (owner).

## 4. TPA / insurance desk (PAY-05, Phase 3)

- Payer per TPA/insurer; hospital-negotiated tariff per TPA (or GIPSA PPN rates where applicable); room-rent eligibility caps; non-payables list (configurable master: e.g., registration, attendant food, toiletries — per IRDAI list the hospital uses); co-pay %.
- Cashless flow: policy/member details → pre-auth request document pack (pre-auth form fields the TPA uses, doctor's notes, investigations, estimate) → status tracking (query, approval amount) → enhancement requests → discharge approval → final bill split into payer and patient shares (non-payables, room-rent proportionate deductions per policy, co-pay) → claim file → settlement tracking with deductions.
- Reimbursement cases: patient pays; hospital provides claim documents set.
- (Later) NHCX integration for pre-auth/claims (`24`).

## 5. Corporate and government schemes (PAY-06, Phase 3)

- Corporate: company payer, employee verification (`corporate_employee` list import or letter upload), credit limit, monthly statement and outstanding ageing; patient pays non-covered items.
- CGHS/ECHS: if empanelled, rate lists import, referral letter capture, bill formats as required.

## 6. Acceptance

- PM-JAY encounter cannot produce a patient receipt (unless override) — test.
- Claim pack includes every required document in the configured order; missing items listed on the cover sheet.
- Ageing report buckets correct on fixtures.
