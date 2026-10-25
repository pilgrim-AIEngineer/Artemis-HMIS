# 23 — Cardiology, ICU/CCU and cath lab [Phase 3]

Feature IDs: CAR-01, ICU-01, CTH-01, CTH-02.

The owner's son (cardiologist) joins next year with a cath lab, ICU and CCU. Everything below reuses existing structures (department, doctor, service, tariff, package, store, admission, bed, orders, MAR). No new core concepts should be needed — if you find yourself adding one, ask.

## 1. Cardiology OPD (CAR-01)

- Department `CARD`; consultation rules and tariffs per doctor.
- Quick-tick order list on the OPD sheet: ECG, 2D Echo, TMT, Holter, ABPM, lipid profile, troponin, NT-proBNP, HbA1c, KFT, CAG advice.
- Rx templates: hypertension, stable angina, post-PTCA (DAPT etc.), heart failure, AF (anticoagulation) — content provided by the cardiologist.
- Cardiac risk helpers (shown as calculators, not decisions): BMI, BP category, eGFR; others the cardiologist approves.
- Patient header flags: on anticoagulant, post-PTCA date, device implanted.

## 2. Cardiology investigations (CAR-01)

- ECG: upload image/PDF from ECG machine (or scan) → interpretation template (rate, rhythm, axis, intervals, ST-T changes, impression) → signed report.
- 2D Echo: structured report template (chamber dimensions, LVEF, wall motion by segment, valves, PA pressure, pericardium, impression) designed with the cardiologist; measurement fields numeric with normal ranges.
- TMT: protocol, stages, duration, METs, max HR %, BP response, symptoms, ST changes, result.
- Holter/ABPM: upload device report PDF + summary/impression.
- Worklist and billing same pattern as USG (orders → bill → worklist → report).

## 3. ICU / CCU (ICU-01)

- Wards `icu`, `ccu` with room categories flagged `is_icu` (GST-exempt room charges per `12 §7.5`), bed codes, per-day charges, equipment charges (ventilator, monitor, syringe pump per day/hour).
- **Flowsheet** (tablet, hourly grid): HR, BP (invasive/non-invasive), MAP (auto), RR, SpO2, temp, GCS, pain, urine output, drains, intake; ventilator settings (mode, FiO2, PEEP, TV, RR, PIP); infusions (drug, concentration, rate ml/h → dose auto-calculated per weight); lines/tubes with insertion dates; scores the cardiologist/intensivist chooses (e.g., GCS; others later). Copy-forward of last hour's values with one tap, then edit.
- Critical alerts to doctor screens; shift summary print.
- (Later) monitor integration (HL7 from patient monitors) — keep `integration_event`.

## 4. Cath lab (CTH-01, CTH-02)

- Schedule (like OT), consents (procedure-specific), pre-procedure checklist (renal function, allergies to contrast, anticoagulants held/given, consent, site).
- Procedure report templates: CAG (dominance, vessel-wise lesion description with % stenosis by segment), PTCA (target vessel/lesion, pre-dilatation, stent details from implant scan, post-dilatation, final TIMI flow, result), others (PPI, BMV) as the cardiologist adds. Images/cine are not stored (no PACS); attach key frames or report PDF if the machine exports.
- Contrast volume, fluoroscopy time, radiation dose (if available), complications, closure device, access site.
- **Implants and consumables**: scan stent/balloon/guide-wire/catheter stickers (UDI/barcode) from the cath lab store (often consignment stock). Each implant: brand, size, batch/serial, MRP, billed rate (≤ price cap), sticker photo. Bills show implant details separately as required for capped devices; package bills (PM-JAY PTCA packages) still record implants for claim documents (implant invoice/stickers in claim pack).
- Post-procedure orders auto-template (sheath removal, monitoring, DAPT).

## 5. Packages

Cardiology packages (CAG, PTCA single/double stent, temporary/permanent pacemaker) for cash and PM-JAY (HBP codes) with inclusions/exclusions (e.g., stent excluded or included per payer).

## 6. Acceptance

- Infusion dose calculation unit tests (mcg/kg/min ↔ ml/h for given concentrations).
- Implant price-cap block test; implant appears on bill and in claim pack.
- ICU room charges GST-exempt on bill fixtures.
