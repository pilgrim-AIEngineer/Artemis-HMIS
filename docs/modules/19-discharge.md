# 19 — Discharge summary [Phase 2A]

Feature ID: DIS-01.

## 1. Templates

Bilingual (English clinical content, Hindi patient-instruction section) templates:
- Normal delivery (mother), LSCS (mother), Newborn (normal), Newborn (NICU), Gynae surgery (hysterectomy, laparoscopy, D&C, etc.), Medical/antenatal admission, Daycare procedure, MTP (restricted — visible only to MTP users; patient copy without sensitive wording per MTP doctor's format), LAMA/DAMA, Referral, Death summary.
- Later: cardiology (CAG/PTCA, ACS, heart failure), ICU/CCU.

## 2. Auto-fill

From the record: patient details, admission/discharge date-time, doctor(s), payer, diagnosis (provisional/final), procedure(s) with date from OT/delivery note, delivery details and baby details (for obstetric templates), key investigations (pick from results — abnormal ones pre-selected), treatment given (from MAR: drugs administered list), course in hospital (free text with suggestion from progress notes), condition at discharge, discharge medications (discharge Rx grid same as OPD transcription, with Hindi instructions), advice (diet, activity, wound care, breastfeeding, contraception), warning signs (template text), follow-up date and with whom, pending reports.

## 3. Workflow

- Draft by assistant/RMO/nurse (doctor may dictate or hand-write; assistant enters) → doctor reviews and signs (PIN) → status `signed`, PDF generated.
- After signing, edits create an addendum; reprint shows "Amended".
- Discharge Rx feeds pharmacy (discharge medicines sale) and the patient timeline.
- Print A4 (2 copies: patient, file) and WhatsApp PDF (with consent; never for restricted encounters unless MTP doctor sends explicitly).
- (Later) AI draft: generate "course in hospital" from structured data for doctor editing; always labelled draft.

## 4. Acceptance

- Cannot finalise the IPD bill until the discharge summary is signed (setting `ipd.requireSummaryBeforeFinalBill`, default true; owner override with reason).
- Summary content matches source records in fixture admissions.
