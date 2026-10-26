# 10 — Registration, visits, token queue, OPD sheet [Phase 1]

Feature IDs: REG-01 … REG-07, MIG-01.

## 1. The real OPD flow at the pilot hospital

```
Patient arrives
  -> Reception: search / register -> create visit -> collect consultation fee -> print token (+ OPD sheet)
  -> Vitals desk (nurse/assistant): vitals entered -> OPD sheet printed (if setting = vitals)
  -> Doctor: sees patient, WRITES Rx and orders on the printed OPD sheet
  -> Assistant: scans sheet QR, photographs sheet, transcribes Rx + orders + follow-up
  -> Billing counter: bills orders (USG, lab, procedures) -> payment
  -> USG / Lab / Pharmacy
```

Doctors keep writing on paper. The system's job is to make the paper smarter (pre-filled, with history and a QR) and make transcription fast.

## 2. Patient search (REG-02)

- Single search box, autofocus. Input classification:
  - 10 digits → mobile exact (also matches `alt_mobile`).
  - Starts with UHID prefix or digits ≤ 7 → UHID (with/without prefix).
  - Otherwise → name fuzzy (trigram on normalised + phonetic name), optional second token as guardian/locality filter.
- Results (max 20): name, age/sex, guardian name, locality, UHID, last visit date + doctor, flags (pregnant GA, PM-JAY, deceased greyed out).
- Family view: searching a mobile lists all patients on that number grouped as a family; "Add family member" pre-fills mobile, address and locality.
- Keyboard: ↑/↓ to move, Enter to select, `F2` new patient.
- Target: results < 300 ms with 2 lakh patients.

## 3. Registration (REG-01)

### Fields

Required: first name, sex, age or DOB, mobile (unless "No mobile" checkbox with reason).
Optional: middle/last name, Hindi name (auto-transliterated suggestion, editable), guardian name and relation (husband/father/mother), address line, locality (type-ahead), district (default facility district), pincode, blood group, marital status, referred by, photo, ID type + last 4 digits, allergies, alerts.

### Rules

- Name title-cased; extra spaces removed.
- Age input `25`, `25y`, `6m`, `15d` → estimated DOB (`dob_is_estimated = true`).
- Duplicate check before save: same mobile AND (phonetic name similarity ≥ 0.6) AND age within ±2 years → modal "Possible existing patient" listing matches with "Use this patient" (default focus) or "Create new anyway" (reason required, logged).
- UHID generated on save. Print sticker/UHID card optional (REG-07).
- Newborns are created from the delivery record (Phase 2A), not here, but reception may register a baby brought for OPD: name allowed as "Baby of <mother name>", link to mother optional.
- Edits after registration: allowed for `patient.update`; name/DOB/sex changes are audited and show a "changed" badge.
- Merge (admin): choose survivor, move encounters/bills/records, mark other `merged_into_id`. Irreversible except by admin restore from audit.

## 4. Visit creation (REG-03)

- Select doctor (large buttons with photo/name; default = last used at this workstation). Department derived.
- Visit type auto-suggested:
  - `follow_up` if the patient saw the same doctor within `follow_up_validity_days` (per doctor setting, default 7) and free follow-ups not exhausted → fee ₹0 or follow-up rate.
  - `anc` if patient has an active pregnancy and doctor is gynae.
  - `paeds_vaccination` if child and vaccine due (reception can switch).
  - else `new` (or `emergency` if chosen).
- Fee auto-filled from `consultation_rule` + `service_rate` (tariff of payer). Reception can change visit type; fee updates.
- Payer defaults to Cash/Self. (Phase 2B: PM-JAY toggle when patient has coverage.)
- On save: `encounter` (type `opd`), `opd_token`, draft `bill` with consultation line.
- Step 3: payment (see `12-billing-payments`). Token is issued when payment is collected OR immediately if fee is ₹0. Setting `queue.issueTokenBeforePayment` (default false).

## 5. Token and queue (REG-04)

- Token number per doctor per day, starting at 1. Allocation uses a Postgres advisory lock on (doctor_id, date) to avoid duplicates.
- Priority: `emergency`, `labour` (jump to top, red), `elderly`, `staff`, `vip` (configurable order); normal tokens ordered by number.
- Queue states: `waiting → vitals_done → with_doctor → seen → rx_entered → billed_orders → done`; also `no_show`, `cancelled`.
  - `with_doctor`: set when doctor's assistant/nurse presses "Call next" or "Send in" on the doctor-room tablet.
  - `seen`: set when the assistant receives the sheet back (scan QR) or presses "Seen".
  - `rx_entered`: transcription saved.
  - `billed_orders`: all orders billed or none needed.
  - `done`: automatic when rx_entered + billed_orders, or manual.
- Queue screen (reception, vitals desk, doctor room): columns per doctor, cards with token no, name, age/sex, visit type badge, waiting minutes, state chip. Actions: Call next, Recall, Skip (moves after next 3), Transfer to doctor, Mark no-show (end of day auto no-show for `waiting` tokens with reason).
- Live updates via SSE.
- Wait-time analytics from `queue_event`.

## 6. Waiting-hall TV display (REG-05)

- URL `/display/queue?key=...` in full-screen Chrome on a TV mini PC.
- Shows per doctor: "Now: 23" big, "Next: 24, 25, 26, 27, 28". Name display off by default (privacy); setting can show first name + last initial.
- Chime on token change; optional Hindi TTS announcement (browser `speechSynthesis` with `hi-IN` voice if available; otherwise chime only).
- Auto-recovers after network blips; shows "Reconnecting…" discreetly.

## 7. Pre-filled OPD sheet (REG-06) — the key design

Printed A5 (portrait) per visit. Setting `opd.sheetPrintAt`: `reception` (after token) or `vitals` (after vitals saved; default when vitals desk has a printer). Reprint allowed (marked "DUPLICATE").

Layout (top to bottom):

1. Hospital header (logo, name, phone), doctor name + qualification + reg no.
2. Patient strip: Name, Age/Sex, UHID, Token no, Date/time, Guardian, Locality, mobile last 4, Payer (Cash / PM-JAY).
3. QR code (encodes `E:<encounter short id>`) + barcode of visit number.
4. Vitals box: printed values if entered, else blank boxes for BP / Pulse / Wt / Temp / SpO2.
5. Context box (auto):
   - Pregnant: GA today (`24w 3d`), EDD, G P A L, risk flags (bold), last 3 visits BP/weight, ANC tests due/overdue, Td status (built with OPD-05).
   - Child: age, weight (with growth percentile), vaccines due/overdue.
   - Everyone: allergies (bold), last visit date + diagnosis + up to 5 last drugs.
6. Large blank area: "Complaints / Findings" (left) and "Rx" (right) for handwriting.
7. Quick-tick orders area (configurable list per doctor, max ~20): e.g., CBC, Hb, Blood group, Urine R/M, HIV/HBsAg/VDRL, TSH, RBS, GTT, Obstetric USG, NT scan, Anomaly scan, Follicular study, TVS; each with a checkbox. Free lines for other tests.
8. Follow-up: "Next visit after ____ days / date ____", "Admit: Yes / No".
9. Footer: "Doctor's signature", print time, user initials.

Template stored in `packages/print/opd-sheet.tsx`, with the quick-tick list from settings `opd.quickOrders[doctorId]`.

## 8. Vitals desk entry

Covered in `11-opd-clinical` (OPD-01). The vitals desk list shows tokens in `waiting`; after save, state → `vitals_done` and sheet prints (if configured).

## 9. Data migration (MIG-01)

- Import patients from CSV/Excel (columns mapped in a wizard): name, age/DOB, sex, mobile, address, old reg number (stored in `patient_identifier` type `other`, label "Old reg no"). Dry-run report shows duplicates and errors before commit.
- Import service/rate list and doctor list from Excel templates provided in `docs/33-seed-masters.md`.

## 10. Acceptance

- Returning patient search → visit → cash payment → token + sheet printed in ≤ 60 s (E2E timed with scripted user).
- Duplicate modal appears for same mobile + similar name; does not appear for different family members with distinct names.
- Two receptionists issuing tokens for the same doctor simultaneously never get the same number (concurrency test, 100 parallel requests).
- Queue updates appear on other screens within 2 s.

## 11. Implementation notes: visit and queue (REG-03, REG-04)

Decisions made while building PR 8; each is a setting or a one-line change.

- **Follow-up window** runs from the patient's latest consultation with the same doctor that was not itself a follow-up (a follow-up does not extend it). The last valid day is `consultation date + validity days` (7 days = same weekday next week), counted on IST calendar days. The free count is the number of follow-ups allowed per consultation; when used up (or the window is over) the visit is `new`. Validity and free count come from `consultation_rule` (follow-up row), then `opd.followUpRulesByDoctor[doctor]`, then `opd.followUpValidityDays` / `opd.freeFollowUps` (Q6 defaults 7 / 1).
- **Follow-up fee** is the rate of the follow-up consultation service in the payer's tariff (set it to ₹0 for a free follow-up). A doctor without a follow-up rule gets ₹0. Reception cannot choose `follow_up` when the patient is not entitled; a concession goes through a discount with approval (BIL-03).
- **A missing fee is not given away**: a visit type without a consultation rule or rate gets ₹0 with `fee_basis` `no_rule` / `no_rate` and no automatic token; the queue shows it under "Visits without a token" with a warning.
- **Token timing**: issued at visit creation when the fee is ₹0 (and known) or `queue.issueTokenBeforePayment` is on; otherwise on payment (BIL-01 calls `issueToken(…, 'payment')`). Until BIL-01, someone with `billing.payment.collect` can release it by hand (`manual_fee_pending` on the token).
- **Second visit with the same doctor on the same day** asks for confirmation (`allowRepeatToday`).
- **Priority order** is `queue.priorityOrder` (default emergency, labour, elderly, staff, vip); normal tokens follow by number. **Skip** puts a patient behind the next three of the same priority class; a called patient who does not come returns to `waiting` / `vitals_done`.
- **Transfer** gives a new number in the other doctor's day counter; the fee is unchanged. **No-show** needs a reason; **reinstate** works on the same day only. Unseen tokens (`waiting`, `vitals_done`) become `no_show` at 23:30 IST (worker job `queue.endOfDay`).
- **Permissions**: reading the board needs `patient.view`; doctor-room actions (call, send in, recall, skip, seen, done) need `queue.call` (doctor, assistant, nurse, reception); desk actions (no-show, reinstate, transfer, priority) need `queue.manage`; cancelling a visit needs `visit.cancel`.
- **Live updates**: the `opd_token` trigger runs `pg_notify('hmis_events', {f, t, d})` (ids only). `/api/events` fans it out over SSE per facility; clients poll every 5 s while no stream is open (503 while the listener is down) and every 60 s as a safety net while one is.

## 12. Implementation notes: TV display, OPD sheet, labels (REG-05, REG-06, REG-07)

Decisions made while building PR 9; each is a setting or a one-line change.

- **Display key**: `/display/queue?key=…` (43-character base64url, 256 bits). The `queue.displayKey` setting holds only the key's SHA-256, so neither a settings read nor `audit_log` can reveal it. The full link is shown once, when an owner (`queue.display.manage`; admins only if granted) makes it on Admin → Waiting-room TV; making a new one switches the old TV off at once. The page checks the key (404 otherwise) and every poll sends it in the `x-display-key` header to `/api/display/queue` (not in a URL; a wrong key is a plain 404, repeated wrong keys get 429). The page sets `Referrer-Policy: no-referrer` and `noindex`.
- **Feed**: per doctor with a token today: `now` (tokens `with_doctor`, latest call first) and `next` (first 5 pending in queue order, plus "+N waiting"). Only token numbers, a recall counter and doctor names are selected; `queue.showNameOnDisplay` adds first name + last initial (`Radha K.`) and nothing else. Polled every 2 s (the TV is not a staff screen, so no SSE session); shows "Reconnecting…" after two failed polls and recovers by itself.
- **Sound**: a two-tone Web Audio chime when a token enters "Now" or is recalled (not on first load). Browsers may block audio until a click; a small "Tap to turn on sound" button appears then (kiosk Chrome with `--autoplay-policy=no-user-gesture-required` avoids it). `queue.displayVoice` (default off) adds a Hindi line via `speechSynthesis` if the TV computer has a `hi-IN` voice; otherwise chime only.
- **OPD sheet** (`opd-sheet`, A5, entity = encounter): QR payload is `E:<encounter uuid>` (the full id, so a scan resolves it exactly; the id only, no patient data), Code 128 barcode of the visit number, mobile shown as last four digits. Prints by itself when the vitals desk presses **Vitals done** (`queue.vitalsDone`, `vitals.record`) and `opd.sheetPrintAt` = `vitals` (default, Q11), or after the token when it is `reception`. Manual **Print OPD sheet** on the visit screen and on every queue card; reprints say DUPLICATE. The vitals boxes print the saved reading (OPD-01: `*` amber, `**` red, extra readings and the "Raised BP in pregnancy" alert under the boxes), blank boxes when none was taken; the pregnancy, child, allergy and last-drugs context blocks arrive with the ANC, paediatric and Rx modules (a printed "Allergies: ____" line and the last-visit line are there now). Quick-tick orders come from `opd.quickOrders[doctor]`, else the examples of §7, at most 20.
- **Sticker** (`patient-sticker`, 50 × 25 mm) and **UHID card** (`uhid-card`): QR = UHID. Neither is marked DUPLICATE on reprint (`markDuplicate: false`; `print_log` still counts copies). The card has no paper size of its own in docs/01 §4: front and back (85.6 × 54 mm) print on one A5 sheet to cut out.
- **No patient data in URLs**: print URLs carry template + uuid only; the `?registered=` flag no longer carries the UHID; all tRPC calls (queries included) go by POST so a search for a name or mobile is never in a URL or access log. An e2e test records every request URL of the TV and print flows and fails if a name, mobile or UHID appears.

## 13. Implementation notes: data import (MIG-01)

Decisions made while building PR 20; each is a setting, an option on the upload, or a one-line change. Admin → **Import data** (`/admin/import`, permission `admin.import.run`, given to `admin` and `owner`).

- **Scope**: the two importers of this phase, patients (`patients.xlsx`) and the rate list (`services_rates.xlsx`). Doctors, drugs, lab tests, packages, opening stock and PM-JAY rates keep their templates and come with their modules. The template is downloadable from the same screen and is built from `packages/db/seed/templates/spec.ts`, so it cannot drift from the importer.
- **Flow**: upload (`.xlsx`, `.csv`, `.tsv`; 5 MB, 10,000 rows) → every row is stored in `import_row` with a verdict → review → import. A batch is a record (`import_batch`: file name, SHA-256, who, when, mapping, options, counts); cancelling needs a reason and the batch stays. `import_row` is staging (rebuilt from the file; copying patient data into `audit_log` again would add nothing) and is the only table without the audit trigger; the batch, the patients, identifiers, services and rates are audited.
- **Messy files**: the header row is found among the first 25 rows (title lines are skipped; blank rows are dropped; row numbers in reports are the file's own). Headers are matched by name with common spellings and Hindi headings (`Mob. No`, `Patient Name`, `W.E.F`, `नाम`); the wizard shows the guess and lets the user pick a column's meaning by hand. Sheet `Data` is used if present, else the first sheet with a recognisable header. CSV: UTF-8 (with or without BOM), UTF-16 or Windows-1252; comma, semicolon, tab or pipe.
- **Patient cells**: one `Name` column is split (first, middle words, last); `Smt.`/`Mr.` prefixes dropped; names title-cased. Sex: `F/Female/महिला/…`. DOB day-first (`01/07/1994`, `1-Jul-94`, `1994-07-01`, Excel serial or date cell); a two-digit year takes the latest century that is not in the future; an unreadable DOB falls back to the age with a warning. Age `28`, `28 yrs`, `6 months`, `15 days` becomes an estimated DOB through the normal rule (docs/02 §3). Mobile: `+91`, `0`, spaces, `.0`, and a second number after `/ , ;` becomes the alternate mobile. Guardian written `W/o Ramesh` or `D/o Mohan` sets the name and the relation. Optional values that cannot be read (pincode, blood group, relation) are left out with a warning instead of failing the row.
- **Mobile is required** (template). Old registers often lack it, so the upload has the option **Import patients without a mobile number**: such rows get the reason "Not in old register" (default off).
- **Old register number** is stored as `patient_identifier` (type `other`, label "Old reg no"), as docs/10 §9 says. The table is new in migration 0030 (it was in docs/04 but not yet built).
- **Duplicates**: (1) the same old reg no already imported: never imported again, so uploading the same file twice adds nothing; (2) the same old reg no twice in the file: the later row is held back; (3) the REG-01 rule (same mobile, similar name, age within tolerance, same settings) against existing patients and against earlier rows of the file. (3) is skipped by default; **Import them as new patients** creates them with the override reason "Imported from file (MIG-01); possible duplicate". The rule is checked again at commit, so a look-alike registered at the counter after the dry run is still caught.
- **Commit** runs 200 rows per transaction, each row in its own savepoint, through `registerPatient` (UHID from the `uhid` series, locality learning, audit actor). A row that cannot be saved becomes `failed` and the rest continue. The screen loops over `importer.commitStep` with a progress line; a crash or closed tab is resumed with **Continue importing**. Rows with errors or held-back duplicates are never imported; the **error report** (CSV with the original columns after row, status and problems, in the user's language) is made to be corrected and uploaded again.
- **Rate list**: service by `service_code` (created if new, otherwise name, category, department, unit, SAC and GST are updated for the fields the file gives); tariff must already exist (by name, ignoring case and spacing; never created by an import); rate through `setServiceRate`, so a changed rate for the same date cancels the old row and a new date is a new row (old bills keep their snapshot). Rupees are parsed as text to paise (`₹ 1,200/-`, `Rs. 500`); more than two decimals is an error, except spreadsheet float noise within 0.0001 paise. A rate that changes by more than half is flagged for a second look. Rows without an effective date are errors unless the user sets a default date for the batch. Room-specific rates (`room_category`) are refused until IPD room categories exist. Conflicting rows for the same service/tariff/date in one file are errors; identical repeats are held back.
