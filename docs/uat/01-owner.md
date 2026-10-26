# UAT 01 — Owner

Person: the owner gynaecologist. About 30 minutes. Training instance, user with role `owner`.
Mirrors `docs/32` flows 5 and 8 from the viewer's side, and the dashboard (`RPT-02`).

| # | Step | Expected | P/F/N | Note |
| --- | --- | --- | --- | --- |
| 1 | Open the training address on the phone. Sign in with username and password. | Dashboard opens. No certificate warning. | | |
| 2 | Lock the screen (Lock button), wait, unlock with your PIN. | PIN keypad appears; the right PIN returns to the same screen. A wrong PIN says how many tries are left. | | |
| 3 | Dashboard: read "OPD visits", "Waiting now", "Collected today", discounts, refunds and cancellations, and the "Needs attention" list. | "Collected today" equals the total of the "Daily collection" report for today. | | |
| 4 | Reports → Daily collection. Choose yesterday. Print it, and save it as CSV. | Report shows cash, UPI, refunds, net, and splits by day, user, doctor and department. Printed copy is readable on A4. | | |
| 5 | Reports → OPD counts: choose "Last 7 days". | Visits by doctor and visit type, by hour of arrival, average wait; totals add up. | | |
| 6 | Reports → ANC register: find one pregnant patient you know. Look at "Missed visits" and "EDD in 30 days". | GA today, EDD, risk flags, last and next visit shown. EDD matches your own calculation from LMP. | | |
| 7 | Reports → Vaccines due: find one child. | "Overdue" and "Due this week" lists; the dose named matches the paediatrician's schedule (IAP). | | |
| 8 | Reports → Discounts and cancellations. | Every discount and cancellation shows who did it, who approved, and why. | | |
| 9 | Billing → Facility close, for a past date. | Counter closes are listed; the difference between counted and expected is visible per counter. UPI reconciliation for the day is reachable from here. | | |
| 10 | Approve a discount or refund by typing your PIN on the cashier's screen (the cashier starts a 15 % discount). | Approval asks for your username and PIN, then the discount applies and the bill shows you as approver. | | |
| 11 | Admin → Settings (read only): follow-up validity days, free follow-ups, discount limits. | Values equal what you decided (`docs/40` Q6). Change nothing. | | |
| 12 | Switch to Hindi using the language button. Open the dashboard again. | All labels Hindi; numbers and ₹ amounts correct. | | |

## Questions for the owner (answer in words)

1. Is any number on the dashboard something you would not trust to run the hospital? Which?
2. What would you want on this screen that is missing?
3. Are you willing to stop the paper OPD register from go-live day? (`docs/00 §5` success criterion)

## Problems found

| # | Step | What happened | Severity |
| --- | --- | --- | --- |
| | | | |

## Sign-off

I have run these steps in training mode. Steps marked F are listed above and I accept / do not
accept going live with them (circle).

Name: ____________________  Signature: ____________________  Date: ____________
Observer (vendor): ____________________
