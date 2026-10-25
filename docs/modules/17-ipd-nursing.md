# 17 — IPD / ADT and nursing [Phase 2A]

Feature IDs: IPD-01 … IPD-04.

## 1. Beds (IPD-01)

- Masters: wards (general, semi-private, private, labour, NICU/baby warmer, daycare; later ICU, CCU), room categories with daily rates per tariff, beds with codes (e.g., `PVT-201`, `GEN-05`, `LR-1`, `NICU-2`).
- **Bed board**: grid by ward; each bed tile shows status colour + text (Free, Occupied, Cleaning, Reserved, Blocked), patient name, age/sex, days admitted, doctor, package, deposit balance (green/amber/red), flags (high-risk, post-op day N, restricted shows only "Occupied"). Touch-friendly for nurse tablets. Live via SSE.
- Housekeeping: after discharge bed → Cleaning; nurse marks Free.

## 2. Admission (IPD-02)

- Entry points: admission advice order from OPD, labour/emergency direct admission, planned surgery.
- Steps (stepper): patient (search/register) → admission details (doctor, consultants, provisional diagnosis, admission type, MLC yes/no with MLC no., expected stay) → bed (bed board picker, filtered by category) → payer (Cash; PM-JAY/TPA from Phase 2B) + package (optional) → deposit collection → print admission form + consents.
- Prints: admission sheet (A4, face sheet), general consent, surgical/anaesthesia consent (templates bilingual, filled with patient details, signed and scanned back), wristband (optional, if they buy a wristband printer: name, UHID, age/sex, admission no, barcode).
- Attendant details and visitor pass (optional).
- Transfers: bed/ward change with time; rate changes from transfer time per bed-day rule; transfer history kept.
- Daily auto-charges per `12 §7.4`.

## 3. Doctor orders and notes (IPD-03)

- Doctors may write on paper here too. Support both:
  - Assistant/nurse enters orders from the doctor's paper order sheet (status `entered`, needs doctor verification if `ipd.ordersRequireVerify` = true; verification on tablet by the doctor during the round, with photo of the paper order sheet attachable).
  - Doctor enters directly on tablet.
- Order types: medication (drug, dose, route, frequency or specific times, start/stop, PRN), IV fluids (fluid, rate, volume), investigations (lab/USG → billing auto-posted for IPD), diet, nursing instructions, procedures.
- Progress notes (daily), with templates: post-LSCS day 1/2/3, post-hysterectomy, antenatal admission, neonatal.
- Doctor visit charges: one tap "Visit done" by nurse/doctor (posts consultant visit charge per tariff).

## 4. Nursing (IPD-04)

- Nurse home: bed board + "My patients" + due tasks (medications due in next 60 min, vitals due).
- **MAR**: schedule generated from medication orders (frequency → times per hospital standard: OD 9 am, BD 9 am/9 pm, TDS 8/14/20, QID 6/12/18/24 — configurable). Nurse marks Given / Held / Refused / Missed with time; given doses decrement ward stock if ward-stock item (else from patient-issued stock).
- Vitals/TPR chart: entries at any time; chart view (temp, pulse, BP lines) printable for the file.
- Intake-output chart: oral/IV in, urine/drain/vomit out, 24 h balance.
- Obstetric nursing extras: fundal height, lochia, perineum/wound check, breastfeeding, baby feeding.
- Nursing notes and shift handover (structured: patient condition, pending tasks, alerts).
- Critical alerts (e.g., BP ≥ 160/110 postpartum, SpO2 < 90) show on the bed board and notify the on-duty doctor screen.

## 5. Discharge workflow (handoff to `19` and `12`)

Discharge advice by doctor → nurse completes checklist (medicines returned, IV removed, baby checked, documents ready) → discharge summary signed → pharmacy returns → final bill → payment/refund → patient leaves → bed Cleaning. Types: normal, LAMA/DAMA (with signed form), referred (with referral letter), death (death record).

## 6. Acceptance

- Bed board accurate under concurrent admissions/transfers (no two patients on one bed — DB constraint).
- Bed-day charge job: fixtures for midnight rule and 24 h rule, transfers mid-day, discharge same day.
- MAR schedule correctness for each frequency and stop times.
