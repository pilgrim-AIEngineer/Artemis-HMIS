# 20 — Reports and owner dashboard

Feature IDs: RPT-01 (P1), RPT-02 (P1), RPT-03 (P2A).

## 1. Common rules

- Every report: date range filter (default today), facility, doctor/department filters where relevant; on-screen table + Excel export (xlsx via `exceljs`) + print (A4).
- Restricted (MTP) data excluded except in MTP reports.
- Money in ₹ with Indian grouping; totals row.
- Report queries run against the primary in Phase 1; from Phase 2 heavy reports can use the standby replica (read-only connection) to avoid slowing the counters.

## 2. Phase 1 reports (RPT-01)

| Report | Content |
| --- | --- |
| Daily collection | By user, by mode (cash/UPI/card), by department, by doctor; receipts list; refunds; net |
| Day close summary | Per user close: expected vs counted, differences and reasons |
| UPI reconciliation | System UPI vs entered bank total per day; unmatched receipts |
| OPD census | New vs follow-up vs ANC vs vaccination by doctor; by hour of arrival (heatmap table); average wait (token → with doctor) |
| Doctor-wise consultation revenue | Count and amount per doctor |
| Orders | Ordered vs billed vs not billed (leakage report: orders transcribed but not billed by end of day) |
| Discounts & cancellations | Who, when, how much, reason, approver |
| ANC register | Active pregnancies: name, age, GA today, EDD, risk flags, last visit, next due; EDDs in next 30 days; overdue visits (missed by > 7 days) for follow-up calls |
| High-risk pregnancy list | Filter by flag |
| Vaccines due/overdue | This week; overdue list with phone numbers for calling |
| Transcription | Rx entered per assistant, average time, verification results (sample mode) |
| Patient registrations | New patients by day, by locality (catchment) |

## 3. Owner dashboard (RPT-02)

Phone-friendly read-only page (accessed via Tailscale on her phone; TOTP login):
- Today: OPD count by doctor, live waiting count, collection by mode, discounts given, cancellations (with names), admissions/discharges (Phase 2), deliveries (NVD/LSCS) (Phase 2), bed occupancy (Phase 2), pharmacy and lab revenue (Phase 2).
- Trend: last 30 days OPD and revenue lines; month-to-date vs last month.
- Alerts: day close differences, pending UPI reconciliation, backup failure, Form F/MTP/birth reporting due (Phase 2).

## 4. Phase 2 reports (RPT-03)

| Area | Reports |
| --- | --- |
| IPD | Admissions/discharges, bed occupancy %, ALOS by package/doctor, deposits outstanding, final bills, refunds |
| Obstetrics | Deliveries by mode (NVD/LSCS/assisted), LSCS rate per month, births (live/still), PPH cases, referrals |
| OT | Surgeries by type/surgeon, OT utilisation |
| Pharmacy | Sales, margin (owner), expiry, reorder, H1 register, GST summaries |
| Lab | Test volumes, TAT, rejections, outsourced |
| Legal | Form F monthly, MTP monthly (MTP users only), birth/death register and CRS reporting status |
| Revenue | Department-wise revenue, package vs itemised revenue, payer-wise (Phase 2B) |

## 5. Phase 2B/3 reports

PM-JAY: pre-auth status, claims submitted/approved/settled/rejected, ageing; TPA outstanding; corporate statements; cardiology procedures; ICU/CCU occupancy.
