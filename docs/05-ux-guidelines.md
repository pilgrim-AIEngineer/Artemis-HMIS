# 05 — UX guidelines (for staff who use computers slowly)

Staff can operate a computer but are not efficient. The system must be faster than paper for them, not just for a power user. Every screen is judged against: "Can a nervous receptionist do this at 11 am with 30 people waiting?"

## 1. Principles

1. **One screen, one job.** Each role gets a home screen with 3–6 large action tiles (e.g., Reception: "New patient", "Old patient", "Today's queue", "Collect payment", "Day close"). No deep menus.
2. **Guided steps, not giant forms.** Registration → visit → payment → print is a stepper with a visible progress bar. Each step shows only what is needed now.
3. **Defaults everywhere.** Doctor defaults to the last doctor used at this workstation; visit type defaults from history (follow-up if last visit ≤ validity days); city/district default to the hospital's; payment mode defaults to Cash.
4. **Minimal mandatory fields.** New patient minimum: name, age or DOB, sex, mobile. Everything else optional and can be filled later.
5. **Search first.** The patient search box is the first focus on reception; typing digits searches mobile/UHID, letters search names.
6. **Big targets.** Buttons ≥ 44 px tall, primary action bottom-right, consistent colours: primary blue, money actions green, cancel/danger red, never two primary buttons on a screen.
7. **Readable.** Base font 16 px, numbers in tabular figures, money right-aligned with ₹. High-contrast theme; no grey-on-grey.
8. **Hindi + English.** Per-user language. Labels can show both ("मरीज़ का नाम / Patient name") when setting `ui.bilingualLabels` is on (default on for reception, cashier, nurse).
9. **Forgiving.** Draft autosave; "Undo" toast for 10 s after non-money actions; money actions use a confirmation dialog that repeats the amount in large text and words ("₹1,250 — एक हज़ार दो सौ पचास रुपये").
10. **Prevent, don't scold.** Disable impossible options instead of erroring (e.g., cannot pick a past date for follow-up). Errors appear inline in plain Hindi/English, never codes.
11. **Keyboard for those who learn it; touch/mouse for everyone.** Shortcuts shown on buttons (`F2 New patient`, `F4 Bill`, `F8 Pay`, `Ctrl+P Print`, `Esc Back`), but nothing requires them.
12. **Show the patient.** A sticky `PatientHeader` (name, age/sex, UHID, mobile last 4, flags: pregnant GA, high-risk, allergy, PM-JAY) on every patient screen to prevent wrong-patient errors.
13. **Speed budget.** Any screen interactive in < 1 s on LAN; search results < 300 ms; no full-page reloads in the main flows.

## 2. Number and text entry helpers

- Mobile input: 10-digit numeric keypad on tablets; validates Indian mobile (starts 6–9).
- Age entry accepts `25`, `25y`, `6m`, `15d`.
- Rx shorthand (assistant): `1-0-1`, `bd`, `tds`, `od`, `hs`, `sos`, `x5d`, `x2w`, `af`/`bf` (after/before food). See `docs/modules/11`.
- Money input: digits only, auto-formats with Indian grouping; amount in words shown under it.
- Locality picker: type-ahead on a seeded list of localities/villages for the district, new entries allowed and learned.

## 3. Training mode

`setting: features.trainingMode` with a separate database `hmis_training` reachable at `https://training.hmis.local`. Clearly watermarked "TRAINING" banner in orange. Staff practise without touching real data. Reset nightly from a seed.

## 4. Visual design

- Calm, clinical, not flashy. Neutral background, one accent colour (configurable to hospital brand).
- Status chips with text and colour (never colour alone): Waiting, Vitals done, With doctor, Rx entered, Billed, Done.
- Tables: zebra rows, sticky header, the key column (patient name / item) left, money right.
- Empty states explain what to do next ("No patients waiting. Press F2 to register.").

## 5. Accessibility

WCAG 2.1 AA contrast, visible focus ring, all icons have labels, forms usable at 125% browser zoom (some staff will zoom).

## 6. Printouts

- Patient-facing prints are bilingual (Hindi first line, English second for headings; drug instructions in Hindi with English drug names).
- Hospital header, registration number, address, phone on every print.
- Every print has a QR/barcode of the document id or UHID and the print time + user initials in the footer.
