# 33 — Seed and master data

Everything here is a **draft seed** to make development and demos realistic. Clinical schedules and rules MUST be reviewed and edited by the responsible doctor in the masters UI before go-live (`32 §5`). Rates are always entered by the hospital.

## 1. Platform seeds

- Facility profile placeholder; number series for current FY; roles and permissions from `03`; reason codes; one payer `Cash / Self`; one tariff `Standard (Cash)`.
- Departments: Obstetrics & Gynaecology (GYN), Paediatrics (PAED), Radiology/USG (RAD), Pathology (PATH), Pharmacy (PHARM), Anaesthesia (ANES), Cardiology (CARD, inactive until P3).
- Localities: import list of localities/villages/pincodes for the hospital's district (from India Post pincode data, CSV provided by the human).

## 2. Services (names only; hospital fills rates)

Consultation: Gynae new, Gynae follow-up, ANC visit, Emergency consultation, Paeds new, Paeds follow-up, Vaccination visit, Night consultation.
Procedures (OPD): Pap smear, IUCD insertion, IUCD removal, Implant/contraceptive injection administration, Dressing (small/large), Suture removal, Injection charge (IM/IV), IV cannulation, Nebulisation, NST/CTG, Vaginal examination/speculum (if billed), Colposcopy (if done), Ear piercing (if paeds does), Circumcision (if done).
USG: Obstetric early, NT scan, Anomaly scan (level II), Growth scan, Obstetric Doppler, Pelvis TAS, Pelvis TVS, Follicular study (per visit), Abdomen, Breast (if done), Neonatal cranial (if done).
IPD: Bed charges per category, Nursing per day, RMO per day, Consultant visit, Monitor per day, Oxygen per hour, Baby warmer/phototherapy per day, NICU per day.
OT/LR: OT charges (minor/major), Labour room charges, Surgeon fee, Assistant fee, Anaesthetist fee, Paediatrician at delivery.

## 3. USG procedure master

Map each USG service to `usg_procedure` with category and `requires_form_f_if_pregnant` (all obstetric = true; pelvis/TVS/abdomen = true when patient pregnant).

## 4. ANC schedule (draft — gynaecologist to confirm)

| Item | Window |
| --- | --- |
| Booking visit + tests: blood group & Rh, CBC/Hb, HIV, HBsAg, VDRL/RPR, urine R/M, RBS or OGTT (DIPSI/75 g as per doctor), TSH | First visit |
| Dating scan | Up to 13w6d |
| NT/NB scan (± biochemistry as per doctor) | 11w0d – 13w6d |
| Anomaly scan | 18w0d – 22w0d |
| OGTT (repeat) | 24w0d – 28w0d |
| Hb repeat | 26w – 30w and 34w – 36w |
| Indirect Coombs / anti-D (Rh-negative only) | 28w |
| Growth scan | 32w – 36w |
| Td-1, Td-2 (4 weeks later) or Td booster | At booking / per history |
| Iron-folic acid, calcium | From 2nd trimester (per doctor) |
| Visit frequency | Every 4 weeks to 28w; every 2 weeks 28–36w; weekly after 36w |

## 5. Immunisation schedules (draft — paediatrician to confirm against the current IAP ACVIP and national UIP schedules)

IAP (draft): Birth — BCG, OPV-0, Hep B-1; 6 w — DTwP/DTaP-1, IPV-1, Hib-1, Hep B-2, Rotavirus-1, PCV-1; 10 w — DTP-2, IPV-2, Hib-2, Hep B-3, Rotavirus-2, PCV-2; 14 w — DTP-3, IPV-3, Hib-3, Hep B-4, Rotavirus-3 (product-dependent), PCV-3; 6 m — Influenza-1 (+ dose 2 after 4 weeks), annual influenza to 5 y; 6–9 m — Typhoid conjugate; 9 m — MMR-1; 12 m — Hep A-1; 12–15 m — PCV booster; 15 m — MMR-2, Varicella-1; 16–18 m — DTP booster-1, IPV booster, Hib booster; 18–19 m — Hep A-2 (if inactivated), Varicella-2; 4–6 y — DTP booster-2, MMR-3 (as per IAP), 9–14 y — HPV (2 doses); 10–12 y — Tdap.
UIP (draft): Birth — BCG, OPV-0, Hep B-0; 6 w — OPV-1, Pentavalent-1, Rotavirus-1, fIPV-1, PCV-1; 10 w — OPV-2, Pentavalent-2, Rotavirus-2; 14 w — OPV-3, Pentavalent-3, fIPV-2, Rotavirus-3, PCV-2; 9–12 m — MR-1, PCV booster, (JE-1 in endemic districts), fIPV-3 if included; 16–24 m — MR-2, DPT booster-1, OPV booster, (JE-2); 5–6 y — DPT booster-2; 10 y and 16 y — Td.

Store each as rows with `due_age_days`, `min_age_days`, `max_age_days`, minimum interval from previous dose.

## 6. Lab tests (draft — pathologist to confirm units/ranges/methods)

Haematology: Hb, CBC (Hb, TLC, DLC, platelets, RBC, PCV, MCV, MCH, MCHC, RDW), ESR, blood group & Rh, BT/CT, PT/INR, APTT, peripheral smear, malaria antigen/smear.
Biochemistry: RBS, FBS, PPBS, OGTT (75 g, 0/1/2 h), HbA1c, urea, creatinine, uric acid, electrolytes, LFT (bilirubin T/D, SGOT, SGPT, ALP, total protein, albumin), lipid profile, calcium, CRP.
Serology: HIV I & II, HBsAg, HCV, VDRL/RPR, Widal, Dengue NS1/IgM, Typhidot (if used), RA, ASO, UPT (urine pregnancy test), beta-hCG (quantitative, if done/outsourced).
Hormones (often outsourced): TSH, FT3/FT4, prolactin, FSH, LH, AMH, vitamin D, B12.
Clinical pathology: urine routine/microscopy, urine culture (outsourced?), stool routine.
Panels: ANC profile, CBC, LFT, KFT, lipid, thyroid, pre-op profile (CBC, BT/CT, RBS, urea, creatinine, HIV, HBsAg, HCV, urine R/M, blood group), fever profile.

## 7. Drug master

- Seed from the hospital pharmacy's current item list (Excel export from their current billing software or distributor price lists). For Rx transcription in Phase 1, seed at least the top 300 drugs the doctors prescribe (collected during discovery from 2 weeks of OPD sheets/pharmacy sales).
- Rx Hindi phrase table: frequency (`1-0-1` → "सुबह 1, रात 1"), timing ("खाने के बाद", "खाने से पहले", "खाली पेट"), duration ("5 दिन", "2 हफ्ते", "1 महीना"), forms ("गोली", "कैप्सूल", "सिरप", "इंजेक्शन", "ड्रॉप", "क्रीम"). Editable in masters.

## 8. Templates to collect

OPD quick-tick list per doctor; Rx templates per doctor; discharge summary formats; OT note formats; consent forms (general, surgical, anaesthesia, LSCS, blood transfusion, LAMA); letterhead and print preferences.

## 9. Excel import templates (provide in `packages/db/seed/templates/`)

`patients.xlsx`, `services_rates.xlsx`, `doctors.xlsx`, `drugs.xlsx`, `lab_tests.xlsx`, `packages.xlsx`, `stock_opening.xlsx` (P2A), `pmjay_hbp_rates.xlsx` (P2B). Each importer: dry-run with error report, then commit. MIG-01 commits in batches of 200 rows (one transaction each, resumable) instead of one transaction: a single long transaction would hold the UHID series row and block the registration counter (AGENTS.md rule 11). See `modules/10` §13.
