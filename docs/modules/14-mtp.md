# 14 — MTP register (restricted) [Phase 2A]

Feature ID: MTP-01.

The hospital provides MTP services. The MTP Act 1971 (amended 2021), MTP Rules and MTP Regulations 2003 require specific consent, opinion and admission register records, monthly reporting, and strict confidentiality (disclosure of a woman's identity is an offence). Build against the current official forms; the MTP-certified doctor signs off every screen and print.

## 1. Confidentiality design

- All MTP-specific data in Postgres schema `restricted` (`mtp_case`, `mtp_monthly_report`) with RLS; app role sets `app.user_permissions` per transaction.
- The related IPD/daycare `encounter` is flagged `is_restricted = true`:
  - Visible to normal staff only as a bed occupancy and a bill with the neutral package name (e.g., "Gynae day-care procedure").
  - Clinical notes, diagnosis, orders text hidden; patient timeline omits it; global search does not reveal MTP status; clinical reports exclude it; WhatsApp messages never mention it (generic discharge/bill message only, or none — setting `mtp.whatsapp` default `none`).
- Lab/USG orders from a restricted encounter show the test name only; the clinical indication is hidden.
- Every read writes `access_log` with purpose.
- Exports and prints watermarked "CONFIDENTIAL — MTP Act".
- The pregnancy record closes as "Closed" for non-MTP users.

## 2. Records (fields per the official forms — summary)

Obtain the latest official text of these forms before coding and store them as versioned schemas:

| Record | Purpose (summary) |
| --- | --- |
| Consent (Form C) | Written consent of the woman (or guardian where legally required), uploaded signed scan |
| Opinion (Form I) | Opinion of the registered medical practitioner(s) forming the opinion, with gestation and grounds; number of opinions required depends on gestation per the Act |
| Admission Register (Form III) | Serial number, date of admission, details as required by the regulations; kept in the restricted register |
| Monthly Report (Form II) | Monthly statement to the Chief Medical Officer of the district |

Implementation notes:
- Gestation-based rules (which opinions are required, upper limits, special categories, medical board cases) are configuration (`mtp.rules` setting) maintained by the MTP doctor, not hard-coded; the UI shows which documents are required for the entered gestation and blocks completion until uploaded.
- `register_no` from `mtp_register` number series (calendar year; confirm).
- Fields that the law says must not be recorded (e.g., identity details in reports) are excluded from the monthly report output.

## 3. Workflow

1. MTP doctor (or authorised user) opens "New MTP case" from the patient (or from an admission) → creates restricted encounter (daycare or IPD) with neutral package.
2. Upload consent; complete opinion(s); record procedure (medical method — drug, dose, dates; surgical method — procedure details), outcome, follow-up, complications.
3. Close case; pregnancy record closed.
4. Monthly report draft generated on the 1st; MTP doctor reviews and marks submitted.

## 4. Retention

Admission register and records retained as per the MTP Regulations (5 years from the end of the calendar year of entry per current regulations — confirm with the MTP doctor/current text). Never purge automatically.

## 5. Acceptance

- Integration tests: users without `mtp.register.view` get no MTP data from any API (patient timeline, search, reports, encounter detail, bill detail text, exports).
- RLS test: direct SQL as app role without the session permission returns zero rows from `restricted.*`.
- Every access writes `access_log`.
- MTP doctor signs off forms and prints.
