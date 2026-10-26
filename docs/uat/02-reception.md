# UAT 02 — Reception

Person: one receptionist. About 45 minutes. Role `reception`. Mirrors `docs/32` flows 1 and 2.
Do the timed flows R3 and R4 twice; the second run is the one that counts.

| # | Step | Expected | P/F/N | Note |
| --- | --- | --- | --- | --- |
| R1 | Sign in with your own user. Open Reception. | Search box is focused on arrival. | | |
| R2 | Search a demo patient by (a) first letters of the name, (b) a spelling variant (for example "Sunita" typed as "Soonita"), (c) the mobile number, (d) the UHID. | Each finds the patient within a second. Family on the same mobile are listed together. | | |
| **R3** | **Returning patient (timed).** Search the patient, New visit, pick the doctor, Save visit, Collect (cash), confirm. | Token number, receipt number (`OB/..`) and the "Print OPD sheet" button appear. **Target: 60 s or less.** Seconds: ____ | | |
| R3b | Print the receipt on the 80 mm printer; print the OPD sheet on A5. | Receipt shows amount in figures and Hindi words, balance ₹0.00. Sheet has patient details, doctor, token, QR. Both are one page and readable. | | |
| **R4** | **New patient (timed).** Register a new patient (first name, surname, sex, age, mobile), Save patient, New visit, doctor, Save visit, Collect cash, confirm. | UHID is created, token and receipt are issued. **Target: 120 s or less.** Seconds: ____ | | |
| R5 | Register a second patient with the **same mobile** as R4 and the same name. | Screen warns "Possible existing patient"; choose "Use this patient" or "Create new anyway" (needs a reason). | | |
| R6 | Register a child by age in months (for example `8m`). | Estimated birth date is shown; the child appears under the mother's family. | | |
| R7 | **Free follow-up.** Pick a patient with a paid visit in the last 7 days with the same doctor. New visit. | Screen says follow-up is allowed until a date; fee is ₹0; no payment needed; token issued. | | |
| R8 | Try a second visit for the same patient and doctor today. | Warning "already has a visit today"; "Yes, make another visit today" is needed to continue. | | |
| R9 | Create a visit with a fee and leave it without collecting. Then open the queue. | No token yet: it is issued when the fee is paid (unless the setting `queue.issueTokenBeforePayment` is on). Finish by collecting; the token appears. | | |
| R10 | Queue screen: mark one patient "No-show" with a reason. | The token leaves the waiting list; the reason is saved. | | |
| R11 | Print a patient sticker (50 × 25 mm) and a UHID card. | One label per print; card has front and back. | | |
| R12 | Waiting-hall TV: open the TV link on the display PC. Issue a token. | The token appears on the TV within a few seconds, without names if `queue.showNameOnDisplay` is off. | | |
| R13 | Right after "Save visit", press the browser Reload button, then look at the queue. | The patient has one visit and one token, not two. | | |
| R14 | Double-click "Confirm" on a payment. | One receipt only. | | |
| R15 | Try to open Billing → Facility close. | You are refused: reception closes only its own counter, not the hospital's day. | | |
| R16 | Idle for the lock time, then unlock with your PIN. | Locked screen hides patient data; PIN unlocks. | | |

## Problems found

| # | Step | What happened | Severity |
| --- | --- | --- | --- |
| | | | |

## Sign-off

Timing: R3 ____ s (target 60)   R4 ____ s (target 120)

Name: ____________________  Signature: ____________________  Date: ____________
Observer (vendor): ____________________
