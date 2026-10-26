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

Built (OPD-01):

- Desk at `/nursing/vitals` (list) and `/nursing/vitals/<token id>` (form); permission `vitals.record`. The queue cards link to it ("Enter vitals"); the older "Vitals done" button still moves a token without readings.
- The assistant picks the adult or pregnant form (an ANC visit, an active pregnancy record (OPD-05), or a pregnant-form reading in the last 300 days, makes pregnant the default). The pregnant form stays open to any non-male patient of 10 years or more, so a woman without a pregnancy record can still have her BP taken. Under 18 the child form is the default.
- Thresholds are the setting `vitals.thresholds` (defaults above); the yearly height prompt is `vitals.heightPromptDays` (365). Children are judged on temperature and SpO2 only; no paediatric BP / pulse bands are invented.
- Temperature is stored in °C with two decimals so that the °F typed comes back unchanged on the sheet. A correction inserts a new row and marks the earlier one `superseded`; both stay on record.
- "Raised BP in pregnancy" is a flag with level `alert` in `vitals.flags`; it shows on the form, the saved panel, the desk list and the OPD sheet. With an active pregnancy record the readings also fill that day's ANC visit row (OPD-05) and the `high_risk_pregnancy` patient alert follows the ANC risk flags.

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

### Built (OPD-02, OPD-03, OPD-04)

- Screens: `/assistant/rx` (scan box focused, "Seen — to transcribe", "Typed today") and `/assistant/rx/<encounter id>`; the assistant home and the queue cards (`with_doctor` … `billed_orders`) link to it. The scanner types the sheet's `E:<encounter id>` and Enter. Permission `rx.transcribe`; placing orders also needs `order.create`. Restricted (MTP) encounters are left out and answer "not found".
- Shorthand parser `packages/shared/src/rx-shorthand.ts` (90 synthetic fixtures; extend with the real lines when collected). Besides the codes above it reads `bid/tid/qds/prn/eod`, `x5`, `5/7` `2/52` `1/12`, `½`/`half`/`0.5`, spaced or `+` patterns and plain phrases ("twice a day", "after food", "khane ke baad", "khali pet"). Unknown words are kept in the row and shown in the instructions; the typed line is stored as `prescription_item.source_line`. Enter pressed before the drug lookup lands waits for it.
- Quantity = pattern sum × days (month = 30 days, `ALT` every other day, `WEEKLY` once a week, `STAT` once) for tab/cap/sachet/pessary; blank otherwise. The assistant can overwrite it.
- Hindi/English instructions `packages/shared/src/rx-hindi.ts`; the hospital rewords Hindi phrases with setting `rx.hindiPhrases` (instead of a masters table).
- Warnings (never blocking): same drug twice, same generic, > 4 units per dose, > 6 doses a day, > 180 days, quantity > 300, missing frequency or duration, drug not in master. Allergy, pregnancy-caution and paediatric dose checks wait for their masters (OPD-05/06, patient allergies).
- Photo: webcam dialog or file/camera input, compressed in the browser to ≤ 1600 px JPEG 0.8, stored on the files volume as `document(kind = rx_scan, entity = encounter)` and served by id at `/api/documents/rx-scan/<id>` to `rx.transcribe` / `rx.verify` / `rx.view`. `rx.requirePhoto` defaults to true as above. The phone QR hand-off page is not built yet.
- Orders: the sheet's quick-tick list (`opd.quickOrders`, else the defaults) mapped to services by `opd.quickOrderServices` (label → service codes), plus search over lab/USG/procedure/cardiology services; admission advice is `clinical_order(kind = admission)` with expected date and a note (packages arrive with BIL-07). Saving opens a draft bill when new orders have none; the bill screen lists unbilled orders pre-ticked, adds them as lines (`bill_line.clinical_order_id`), skips unpriced ones, marks them `billed` on finalise and moves a token at `rx_entered` to `billed_orders` once none is left unbilled.
- Notes tab: complaint and advice chips (`opd.complaintChips`, `opd.adviceChips`) + free text, provisional diagnosis; stored as `clinical_note(kind = opd)` with `follow_up_date`. Follow-up: after 3/7/15/30 days or a date (tomorrow … one year).
- Save: one transaction (idempotency key) → `prescription(final, transcribed_from_paper)`, rows, orders, note, token → `rx_entered`. Re-saving is a correction: next `version`, the old Rx `superseded`, unwanted orders `cancelled`; an order already on a bill cannot be dropped here.
- Drafts: browser `localStorage` every 5 s, server `rx_draft` every 20 s; on reload the newer one (if newer than the saved Rx) is offered with Restore / Start fresh. Autosave-only writes to `rx_draft` are not copied into `audit_log`; creation and status changes are.
- Verification (`rx.verifyMode`, default `sample`, `rx.verifySamplePercent` 10): sampled or warned Rx go to `/doctor/verify` for the doctor linked to the visit's doctor profile, photo beside the typed rows, "Verify". "Correct" from the doctor's tablet, Rx templates, the Rx print and the WhatsApp summary/reminder are not built yet.

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

### Built (OPD-05)

All ANC rules below are the drafts of this file and `33 §4`: **pending gynaecologist sign-off**. Every ANC screen shows that notice until the setting `anc.rulesSignedOff` is ticked (Admin → Settings → ANC); the calculators remind and flag, they never decide treatment.

- Screens: `/assistant/anc` (search by name / mobile / UHID with the keyboard, list of active pregnancies with GA, EDD, G P A L, risk chips, next visit) and `/assistant/anc/<patient id>` (the card: summary, dating, visits, schedule, blood group + manual flags, earlier pregnancies + G P A L, closing). Reading needs `patient.view`; every change needs `clinical.anc.edit` (assistant, doctor, owner). Reception can read but not open a record (open question, see PR notes).
- Tables (migration 0024/0025): `pregnancy` (partial unique index = one `active` per patient, invariant 04 §15.4), `obstetric_history`, `anc_visit`, `anc_schedule_item` (seeded from the draft in `33 §4` by `seedMasters`; the built-in draft is used until then), `anc_schedule_status`, `patient_alert`, and `encounter.pregnancy_id`. Differences from `04 §5`: `pregnancy` also keeps `scan_date`, `scan_ga_days`, `dating_basis`, `redating_decision`, `booking_date`, `plurality`, `gpal_manual`, `manual_risks` (jsonb, replaces `risk_flags text[]`) and the closing fields; `obstetric_history.babies_alive` is a count (twins) plus `neonatal_death`; rows are replaced by cancelling, never deleted.
- Calculators in `packages/shared/src/anc.ts` (pure, `YYYY-MM-DD` and whole days): EDD = LMP + 280 days; GA from the final EDD (`280 − days to EDD`, so scan-dated pregnancies work the same); scan EDD = scan date + (280 − GA at scan). Re-dating compares the two EDDs: the table `anc.redatingThresholds` is picked by the **GA found at the scan** and the scan EDD is suggested only when the difference is **more than** the limit (equal keeps the LMP). The suggestion is never applied by itself: "Use scan EDD" / "Keep LMP EDD" are confirmed by a person and the old and new EDD are in `audit_log`. A pregnancy dated by scan only has no LMP.
- G P A L from the earlier pregnancies plus the current one; a delivery before `anc.viabilityWeeks` (default 28, a draft) counts as an abortion, ectopic and abortion always do, a stillbirth is a birth. It can be typed by hand (must add up) and restored from the history. Closing a pregnancy adds its row to the history so the next pregnancy is right.
- Risk flags (auto, recomputed on every read from `anc.riskRules`; manual ones kept until removed): the defaults of §3.2, with BP ≥ 160/110 as the serious `alert` band. Any flag raises the `high_risk_pregnancy` alert; closing the pregnancy clears it. "Multiple pregnancy" comes from the number of babies the assistant ticks after the scan report; nothing else about the baby is recorded.
- Schedule: `due` / `overdue` / `upcoming` / `done` / `skipped` per item from the GA windows; booking tests and Td-1 are due from the booking date and overdue after `anc.bookingGraceDays` (14); Td-2 runs four weeks after Td-1 was given; anti-D / Coombs only when the blood group is Rh-negative. An item is ticked by hand, or by itself when a completed order for one of its service codes falls in its window (±7 days). Next visit = last visit + the interval of its GA (`anc.visitIntervals`: 4 / 2 / 1 weeks).
- Closing outcomes: delivered (mode asked), abortion, MTP, ectopic, lost to follow-up, transferred. **MTP** needs `mtp.register.edit`; without `mtp.register.view` the pregnancy reads as "closed" with no date or reason on every screen, and is not printable; a permitted read is written to `access_log`. The history row it leaves is an ordinary `abortion`.
- Visit type: a woman with an active pregnancy seeing a gynaecologist is suggested `anc` at the reception (`10 §4`).
- Prints: ANC card `anc-card` (A5, bilingual, entity = pregnancy, permission `clinical.anc.edit`, no DUPLICATE mark) with booking details, EDD, blood group, risk flags, visit table, tests / scans / Td, next visit; the OPD sheet gets a pregnancy block (GA, EDD, G P A L, risks in bold, last three BP / weights, tests due / overdue, Td).
- Not built yet: the ANC register report (`20`), WhatsApp ANC reminders (`21`), a screen to edit the schedule master (rows are in `anc_schedule_item`), ANC suggested date inside the Rx follow-up tab.

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

### Built (OPD-06)

All paediatric rules below are the drafts of this file and `33 §5`: **pending paediatrician sign-off**. Every paediatrics screen shows that notice until the setting `paeds.rulesSignedOff` is ticked (Admin → Settings → Paediatrics). The software calculates and reminds; it never decides what a child should be given.

- Screens: `/assistant/paeds` (search by name / mobile / UHID, list of children whose last dose left a next due date within 60 days back to 14 days ahead) and `/assistant/paeds/<patient id>` (summary + WhatsApp consent, vaccines still to give with a Record button, doses given with batch, growth). Reading needs `patient.view`; changes need `clinical.paeds.edit` (assistant, doctor, owner; not nurse or reception: add it in the role matrix if nurses give vaccines). Weight-based dose rules are masters: `admin.masters.manage`.
- Tables (migrations 0026/0027): `immunisation_schedule` (seeded from `33 §5` by `seedMasters`; the built-in draft is used until then), `immunisation_profile` (IAP/UIP per child), `immunisation_given`, `growth_measurement`, `drug_paeds_rule` (no seed), `patient_consent`, `message_outbox` (04 §13, queue only; the sender is MSG-01; status `cancelled` added).
- Schedule maths `packages/shared/src/immunisation.ts` (pure, whole days; months = 30.4375 d): per dose `due`, `min`, `max` age and the minimum interval from the previous dose of the series. Status `upcoming` / `due` (from the due date, `immunisation.overdueGraceDays` = 7) / `overdue` / `given` / `not_applicable` (past the maximum age, a closed series, or a dose for one sex, HPV in the draft). **Catch-up**: next due = max(own age, given date + minimum interval); a dose not yet given counts from `max(its due date, today)`, so the doses behind it show the earliest date if it were given today.
- Recording a dose: vaccine, brand, batch, expiry, site, route, date, given by. Date before birth / future, a dose already given and an expired batch are refused; too early (beyond `immunisation.earlyGraceDays` = 4), after the maximum age and an earlier dose missing ask for a confirmation and are stored on the row. Batches come from earlier records until pharmacy stock exists (Phase 2A). A wrong entry is cancelled with a reason.
- Reminder: after each change the next compulsory due date is worked out and, when the family agreed (WhatsApp consent recorded on the card, `verbal_recorded`) and there is a mobile, one `message_outbox` row (`vaccine_reminder`, Hindi, all doses due that day) is queued for 10:00 IST `immunisation.reminderLeadDays` (2) before, outside quiet hours; an old row for another date is cancelled. No consent row = nothing queued. `whatsapp.enabled` is honoured by the sender (MSG-01), not here.
- Growth: WHO 2006 LMS tables for 0–5 y (weight-, length/height-, head-circumference-for-age, weight-for-length under 2 y and for-height from 2 y) bundled from the public WHO "expanded tables" in `packages/shared/src/who-growth/` (import `@hmis/shared/growth`, server only). z beyond ±3 is extended linearly for weight indicators, as WHO does. Length/height measured lying vs standing is not corrected (±0.7 cm). From 5 y, or when the sex is not M/F, only values are kept (IAP 2015 charts not bundled). A child's vitals fill that day's measurement (a typed entry of the day wins). Chart: `GrowthChart` (SVG, `packages/ui`), also in the A4 growth-chart print.
- Dose check (§4.4): `drug_paeds_rule` rows only from the hospital's list (no seed; `paeds.saveDoseRule`). Matched on the drug's generic name; liquids use the rule's concentration, tablets the drug strength; today's weight from vitals or a growth entry. Warnings `paeds_dose` (below / above / over the per-dose maximum / too many doses a day) and `paeds_no_weight` appear on the row and are saved with the Rx (they send it to doctor verification); the dose is never changed.
- Prints: `vaccination-card` (A5, bilingual), `vaccination-certificate` (A4), `growth-chart` (A4), permission `clinical.paeds.edit`.
- Not built yet: the paeds block on the OPD sheet, the daily re-check job (`reminder.daily`, MSG-01) and sending, a masters screen for the schedule and dose rules (rows are in the tables), newborn birth-dose link (§4.3, Phase 2A), IAP 2015 charts.

## 5. Acceptance

- Shorthand parser: unit tests for at least 60 real-world lines (provided by assistant during discovery) with ≥ 95% correct parse; failures fall back to manual row without data loss.
- A 4-drug Rx with 3 orders transcribed in ≤ 60 s by a trained assistant (timed E2E script with realistic typing speed of 25 wpm).
- EDD/GA: tests for leap years, LMP at month ends, scan re-dating thresholds.
- Vaccine schedule: tests for due/overdue/catch-up logic across birth dates.
- Restricted pregnancy outcomes (MTP) never appear to a user without permission (integration test).
