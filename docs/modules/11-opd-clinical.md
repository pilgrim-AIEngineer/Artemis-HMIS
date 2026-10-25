# 11 — OPD clinical: vitals, Rx transcription, ANC, paediatrics [Phase 1]

Feature IDs: OPD-01 … OPD-07.

Clinical defaults in this file (risk thresholds, schedules) are seeds that the owner gynaecologist and paediatrician must review in the masters screen before go-live. The software calculates and reminds; it never decides treatment.

## 1. Vitals (OPD-01)

Screen: vitals desk list (tokens `waiting`, oldest first, priority on top) → select → form adapts by patient:

| Group | Fields |
| --- | --- |
| Adult | BP sys/dia, pulse, temp (°F input, stored °C), SpO2, weight, height (once per year prompt), RBS (optional) |
| Pregnant (active pregnancy) | adult fields + fundal height (optional), FHR (optional), oedema (none/+/++), urine albumin/sugar (optional dipstick) |
| Child (< 18 y) | weight, length/height, head circumference (< 2 y), temp, SpO2, RR, MUAC (optional) |

- Large numeric keypad on tablet. Tab order = paper order.
- Out-of-range highlights (amber/red) and a flag list saved to `vitals.flags`. Defaults: BP ≥ 140/90 amber, ≥ 160/110 red; SpO2 < 94 amber, < 90 red; temp ≥ 38.0 °C amber; pulse < 50 or > 120 amber; RBS > 200 amber. Pregnant + BP ≥ 140/90 → add patient alert "Raised BP in pregnancy" for doctor attention.
- Implausible values blocked with message (e.g., weight 650 kg, BP dia > sys).
- Save → token state `vitals_done`, optional sheet print.

## 2. Rx transcription by assistant (OPD-02, OPD-03, OPD-04)

### 2.1 Entry points

- Scan the QR on the paper sheet with a 2D barcode scanner (keyboard wedge) → opens that encounter's transcription screen. Or pick from the "Seen — to transcribe" list (tokens `with_doctor`/`seen`).

### 2.2 Screen layout (desktop, 1366×768 minimum)

- Top: `PatientHeader` (name, age/sex, UHID, GA/vaccine status, allergies in red).
- Left (40%): **Paper image** panel. "Capture" button uses webcam/document camera or phone upload (QR handoff page `/capture/<code>` opened on a phone on the same Wi-Fi). Zoom/rotate. Saved as `document(kind=rx_scan)` linked to the prescription. Setting `rx.requirePhoto` (default true) – cannot finalise without a photo.
- Right (60%): tabs in order of use: **Medicines**, **Orders**, **Notes & Diagnosis**, **Follow-up**.

### 2.3 Medicines grid

Each row: Drug | Dose | Frequency | Timing | Duration | Qty (auto) | Instructions (Hindi preview).

- Drug picker: type-ahead over `drug` (brand + generic), ranked by this doctor's usage frequency, then stocked items. Unknown drug → "Add as free text" (flagged for admin to map to the master later).
- **Shorthand line entry** (fastest path): a single input where the assistant types e.g.
  - `dolo 650 1-0-1 af 5d` → Dolo 650 tab, 1-0-1, after food, 5 days, qty 15
  - `folvite bd x1m` → BD = 1-0-1, 1 month, qty 60
  - `syp calpol 5ml tds 3d` → 5 ml, TDS, 3 days
  - `inj tt im stat` → stat dose
  Parser in `packages/shared/rx-shorthand.ts`; grammar: `<drug words> [dose] [pattern|code] [timing] [duration]`. Codes: `od`(1-0-0), `bd`(1-0-1), `tds`(1-1-1), `qid`(1-1-1-1), `hs`(0-0-1 at bedtime), `sos`, `stat`, `weekly`, `alt` (alternate days). Timing: `af`, `bf`, `wf`, `es` (empty stomach). Duration: `5d`, `2w`, `1m`, with optional `x`. Parsed result shown as a row for confirmation; Enter accepts.
- Quantity auto-calculated for solid forms (pattern sum × days), blank for liquids/creams unless entered.
- Hindi instruction generated: e.g. `1-0-1, खाने के बाद, 5 दिन` (mapping table in `packages/shared/rx-hindi.ts`, editable phrases in masters).
- Buttons: **Repeat last Rx** (copies previous prescription items of the same doctor; assistant edits), **Template** (doctor templates: "ANC 2nd trimester", "PCOS", "Post-LSCS", "Paeds fever"), **Clear**.
- Warnings (non-blocking, shown inline): allergy match (generic or class), duplicate generic in same Rx, pregnancy flag for drugs marked `pregnancy_caution` in master (seeded only from the doctor-approved list, else off), paeds dose check (see 4.4).

### 2.4 Orders tab

- Checkbox grid mirroring the sheet's quick-tick list (same order, same names) + search for others (lab tests, panels, USG procedures, procedures).
- Admission advice: yes/no + expected date + package suggestion (creates `clinical_order(kind=admission)` visible to IPD desk).
- Each order creates `clinical_order(status=ordered)`; billing sees them immediately.

### 2.5 Notes & diagnosis (optional by default)

- Complaints as chips (common list per specialty) + free text; provisional diagnosis pick list (doctor favourites, optional ICD-10 search); advice chips ("Plenty of fluids", "Iron-rich diet", "Report immediately if bleeding/leaking/decreased fetal movements"). Setting `opd.notesRequired` (default false) because doctors write on paper.

### 2.6 Follow-up

- "After N days" quick buttons (3, 7, 15, 30) or date; ANC suggests next date from GA (see 3.4); vaccines suggest next due date.
- Creates reminder (WhatsApp, 1 day before; see 21).

### 2.7 Save and verification

- Save → `prescription.status = final`, `source = transcribed_from_paper`, token state `rx_entered`. Orders and Rx flow to billing and pharmacy.
- Optional Rx print (setting `print.rxCopy`, default off — patient keeps the doctor's paper). WhatsApp Rx summary (with consent).
- **Doctor verification queue** (setting `rx.verifyMode`: `off`, `sample` (default, random 10% + all with warnings), `all`): doctor sees paper photo side-by-side with the typed Rx on a tablet and taps Verify or Correct. Corrections create a new version; pharmacy is alerted if already dispensed.
- Medico-legal note: the handwritten sheet is the original Rx; the system record is a transcription linked to its photo. The printed label "Transcribed by <user>" appears on any system Rx print.

### 2.8 Timeline (OPD-07)

Patient timeline lists encounters newest first with: date, doctor, visit type, vitals summary, Rx items, orders + status, bills (amount, paid), documents (sheet photos, reports). Restricted encounters hidden per `03`.

## 3. Gynae: ANC card (OPD-05)

### 3.1 Pregnancy record

- Created by assistant (or reception) when a pregnant patient visits: LMP (date or "unknown"), or GA by scan if LMP unknown.
- `edd_by_lmp = lmp + 280 days` (Naegele). GA = today − LMP (shown as `w + d`).
- Dating by scan: enter scan date and GA at scan → `edd_by_scan`. Suggest switching `edd_final` to scan EDD when the difference exceeds the configurable threshold table (defaults, ACOG-style): GA at scan < 9w: > 5 days; 9w–13w6d: > 7 days; 14w–15w6d: > 7 days; 16w–21w6d: > 10 days; 22w–27w6d: > 14 days; ≥ 28w: > 21 days. Doctor/assistant confirms; change is audited.
- Obstetric score G P A L computed from `obstetric_history` plus the current pregnancy; editable.
- Only one active pregnancy per patient; closing outcome: delivered, abortion, MTP (restricted — closing reason shown as "Closed" to non-MTP users), ectopic, lost to follow-up, transferred.

### 3.2 Risk flags (auto + manual)

Auto (default rules, owner to confirm): maternal age < 18 or > 35; height < 145 cm; BMI ≥ 30 at booking; BP ≥ 140/90 at any visit; Hb < 11 g/dL (anaemia), < 7 (severe); previous LSCS; previous stillbirth/neonatal death; ≥ 2 previous abortions; grand multipara (para ≥ 4); Rh negative; multiple pregnancy (from scan); GA > 40w with no outcome (post-dates). Manual: GDM, thyroid disorder, heart disease, placenta praevia, IUGR, others (free text). Flags display on every screen and on the OPD sheet.

### 3.3 ANC visit table

Columns: date, GA, weight, BP, fundal height, FHR, presentation, oedema, urine protein/sugar, Hb, remarks. Values flow from vitals automatically; assistant adds the rest. Weight gain chart (sparkline).

### 3.4 Schedule

`anc_schedule_item` master seeded (see `docs/33`) with visits, tests, scans, Td doses and supplements with GA windows. For each active pregnancy compute `due` / `overdue` / `done`. Done is set automatically when a matching order is completed (e.g., lab test or USG procedure mapped to the schedule item) or manually ticked. Next-visit suggestion: ≤ 28w every 4 weeks; 28–36w every 2 weeks; > 36w weekly (configurable).

### 3.5 Prints

- ANC card (A5, bilingual) for the patient: booking details, EDD, blood group, risk flags, visit table, tests done, Td doses, next visit.
- ANC register report (active pregnancies, EDD this month/next, high-risk list) in `20`.

## 4. Paediatrics (OPD-06)

### 4.1 Immunisation

- Schedule from `immunisation_schedule` (IAP default; UIP selectable per patient) computed from DOB: due date, window, status (`due`, `overdue`, `given`, `not_applicable`).
- Record vaccine given: vaccine, brand, batch, expiry, site, route, date, given by. Batch/expiry picked from pharmacy stock when the vaccine is stocked (Phase 2A), free text before that.
- Catch-up: if a dose is late, next dose due date is computed from the actual given date plus minimum interval.
- Vaccination card print (A5, bilingual) and certificate print.
- WhatsApp reminder 2 days before due (with consent).

### 4.2 Growth

- Store measurements; compute WHO z-scores (0–5 y, weight-for-age, length/height-for-age, weight-for-length/height, head circumference) using WHO LMS tables bundled as JSON in `packages/shared/who-growth/` (public WHO data). 5–18 y: IAP 2015 charts (bundle when provided; otherwise show values only).
- Growth chart component (SVG): child's points over percentile/z-score curves. Printable.

### 4.3 Newborn link

Babies born in the hospital (Phase 2A) carry mother's UHID link, birth weight, and birth-dose vaccines recorded at birth.

### 4.4 Dose check (paeds)

- `drug_paeds_rule` (seeded ONLY from a list approved by the hospital's paediatrician): drug/generic, mg per kg per dose (min/max), max mg per dose, max doses per day, concentration (mg per ml) per form.
- During transcription for a child with today's weight, if a rule exists, show calculated range "Expected 4.5–6.0 ml per dose for 14 kg" next to the entered dose; amber warning if outside. Never auto-change the dose.

## 5. Acceptance

- Shorthand parser: unit tests for at least 60 real-world lines (provided by assistant during discovery) with ≥ 95% correct parse; failures fall back to manual row without data loss.
- A 4-drug Rx with 3 orders transcribed in ≤ 60 s by a trained assistant (timed E2E script with realistic typing speed of 25 wpm).
- EDD/GA: tests for leap years, LMP at month ends, scan re-dating thresholds.
- Vaccine schedule: tests for due/overdue/catch-up logic across birth dates.
- Restricted pregnancy outcomes (MTP) never appear to a user without permission (integration test).
