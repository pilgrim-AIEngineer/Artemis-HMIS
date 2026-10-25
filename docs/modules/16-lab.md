# 16 — Pathology lab [Phase 2A]

Feature IDs: LAB-01, LAB-02.

## 1. Masters (LAB-01)

- Tests: code, name, department, sample type and container (EDTA, plain/SST, fluoride, citrate, urine container, swab), method, unit, result type (numeric, text, option list, culture, calculated), decimals, TAT, outsourced flag + partner lab, linked billing service.
- Panels: CBC, LFT, KFT/RFT, lipid, thyroid (T3/T4/TSH), ANC profile (Hb, blood group & Rh, HIV, HBsAg, VDRL/RPR, HCV, urine R/M, RBS/GTT as configured), urine R/M, coagulation, etc. Panels print as grouped sections.
- Reference ranges by sex, age band (days) and pregnancy trimester where relevant (e.g., TSH, Hb), with critical limits.
- Calculated tests via safe formula strings evaluated by a small expression parser (no `eval`): e.g., indices from CBC, LDL (Friedewald) when the lab uses it, eGFR (formula chosen by the pathologist).
- Seed data list in `docs/33`; the pathologist reviews units and ranges before go-live.

## 2. Workflow (LAB-02)

1. Orders arrive from billing (`clinical_order` billed) or from IPD (posted to IPD bill).
2. **Sample collection** screen: patient, tests grouped by container → print barcode labels (50×25 mm, 1 per container: barcode, patient name, age/sex, UHID, sample type, date/time) → mark collected (collector, time). Sample rejection with reason (haemolysed, insufficient, wrong container) → recollect.
3. **Result entry** worklist by department/test: numeric keypad entry, tab to next; auto flag L/H/critical; delta check vs previous result (configurable % change) shown as warning; text/option templates for urine/smear; culture template (organism, colony count, antibiotic sensitivity table).
4. **Verification** by pathologist/authorised signatory (may be remote over Tailscale, or a scheduled visit): review abnormal/critical first; verify all or per test; comments.
5. **Report release**: PDF with hospital/lab header, test, result, unit, reference range, flags, method, sample collection/report times, verified by (name, qualification, signature). Partial reports allowed (completed tests) with "Pending" list.
6. Delivery: print at lab, WhatsApp PDF (consent), visible to doctor in patient timeline. Critical values → immediate alert to the ordering doctor's queue screen and a call log entry (who was informed, when).
7. Amendments after release create a new version with reason; old version kept; reprint shows "Amended".

## 3. Outsourced tests

Mark sent (partner lab, date, courier), mark received, upload partner report PDF or enter results; billing unaffected.

## 4. Reports

Daily test counts by department, TAT (collection → release) by test, pending samples, rejections, revenue by test (via billing), outsourced pending.

## 5. Later (Phase 3+)

Analyser interfacing (ASTM/HL7 via a small serial/TCP gateway) — keep `integration_event` and test `machine_code` mapping column ready.

## 6. Acceptance

- Reference range selection correct for age/sex/trimester test fixtures.
- Unverified results are never visible on patient-facing prints or WhatsApp.
- Barcode uniqueness and label printing on the chosen label printer.
