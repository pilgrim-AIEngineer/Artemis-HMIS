# UAT 04 — Doctor's assistant (prescription typing, ANC, vaccines)

Person: the assistant who enters the doctor's paper Rx. About 60 minutes. Role `doctor_assistant`.
Mirrors `docs/32` flows 4, 7 and 8. Use the **60+ anonymised real Rx lines** from the hospital
(`docs/32 §3`) as the paper prescriptions for A2 if they have arrived; otherwise the vendor
prints five sample Rx sheets.

## A. Prescription (timed)

| # | Step | Expected | P/F/N | Note |
| --- | --- | --- | --- | --- |
| A1 | Open Assistant → Rx. Scan the QR of an OPD sheet with the barcode scanner ("Scan the OPD sheet"). | The right patient and visit open ("Type the prescription"). | | |
| A2 | **Timed.** Photograph the paper Rx, then type **4 medicines** in short form (for example `T paracetamol 650 1-1-1 x5d`) in "Medicine line", pick the medicine from the list. Save prescription. | Each row shows the medicine, dose, and the Hindi instruction. **Target: 60 s or less** from scan to saved. Seconds: ____ | | |
| A3 | Type a medicine the list does not know. | It can be kept as a free-text line; the row shows a "free text" warning so the verifier looks at it. | | |
| A4 | Type a dose the checks consider too high, and the same medicine twice (the vendor tells you which). | A warning appears beside the row (it asks "is this what the paper says?"). Warnings do not stop saving; the doctor or verifier sees them. | | |
| A5 | Orders tab: tick three orders (for example CBC, TSH, a scan). Add them to the bill. | "Add 3 orders to the bill". The orders appear on the cashier's pending bill with the fees. | | |
| A6 | Follow-up tab: choose "After 7 days" (or a date). | The follow-up date is shown on the visit. | | |
| A7 | Close the browser tab in the middle of an Rx and open it again. | "Restore draft" is offered; the typed lines come back. | | |
| A8 | Press "Next patient". | The next waiting patient opens. | | |

## B. Antenatal (ANC)

| # | Step | Expected | P/F/N | Note |
| --- | --- | --- | --- | --- |
| B1 | Assistant → ANC cards. Open a pregnant patient. "Open pregnancy record" with LMP. | EDD and gestational age appear. Check them against the gynaecologist's own method (Naegele). | | |
| B2 | Enter GPAL and the previous pregnancies. | G P A L totals follow from the history. | | |
| B3 | Add today's ANC visit: weight, BP, fundal height, FHR, presentation, urine, Hb, remarks. | "Visit saved." The schedule shows what is due next. | | |
| B4 | Enter a BP of 150 / 100. | The "High-risk pregnancy" flag appears with the reason. | | |
| B5 | Enter a dating scan that differs from the LMP. | The screen compares both and offers "Use scan EDD". Confirm it. | | |
| B6 | Mark a schedule item as done (for example Td). | The item shows done; the next one is highlighted. | | |
| B7 | Print the ANC card. | One A5/A4 card with EDD, GA, visits and risks. The gynaecologist confirms the content. | | |
| B8 | Look for any place that shows or asks for the baby's sex. | None exists (legal rule, `docs/30`). | | |

## C. Child vaccines and growth

| # | Step | Expected | P/F/N | Note |
| --- | --- | --- | --- | --- |
| C1 | Assistant → Vaccines and growth. Open a child. | Schedule with given, due and overdue doses. | | |
| C2 | "Record" a due dose: batch number, expiry date, site. Tick "I have checked this". Save dose. | Dose is recorded; the next due date is calculated from the date given. | | |
| C3 | Try a dose that is too early, or with an expired batch. | A warning for early; expired batch is refused. | | |
| C4 | Tick the WhatsApp reminder consent and save. | A reminder is queued for the date shown (it is not sent on training machines). | | |
| C5 | Enter weight and length; "Save measurement". | Growth chart updates with the point; a value outside the usual lines is flagged for the doctor. | | |
| C6 | Print the vaccination card and the growth chart. | Both print on one page and are readable. The paediatrician confirms the content. | | |
| C7 | Cancel a dose entered by mistake. | It stays on record as cancelled with the reason; the schedule recomputes. | | |

## Problems found

| # | Step | What happened | Severity |
| --- | --- | --- | --- |
| | | | |

## Sign-off

Timing: A2 ____ s (target 60)

Name: ____________________  Signature: ____________________  Date: ____________
Observer (vendor): ____________________
