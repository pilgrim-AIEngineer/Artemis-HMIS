# UAT 05 — Cashier

Person: one cashier. About 60 minutes. Role `cashier`. Mirrors `docs/32` flows 5 and 6.
Money rules: amounts are exact to the paisa; every payment, discount and refund is recorded with
who did it (`docs/12`). The cashier does **not** approve their own discount above their limit.

## A. Taking money

| # | Step | Expected | P/F/N | Note |
| --- | --- | --- | --- | --- |
| C1 | Billing → pending bills. Open a bill made from an assistant's orders (UAT 04 step A5). | The bill lists the consultation and the three orders with fees. | | |
| C2 | Add a service: "Add service" → type "IUCD" → choose "IUCD insertion". Remove it again with a reason. | The total changes; the removed line stays visible as removed. | | |
| C3 | Collect **cash**: amount due ₹500, the patient gives ₹2,000. Type "Cash given by patient". | The screen shows "Return ₹1,500.00". Amount received cannot be more than due. | | |
| C4 | Confirm the amount in the confirmation box. Double-click "Confirm". | One receipt only. | | |
| C5 | Print the receipt on the 80 mm printer, and again as A5. | Receipt shows figures and Hindi words, the receipt number, balance ₹0.00. | | |
| C6 | Collect a **UPI** payment with the UTR from the phone (the patient scans the printed static QR). | UTR is saved with the payment. A UTR must be 4 to 12 digits; anything else is refused with a message. The UTR is optional. | | |
| C7 | Collect a **split** payment: part cash, part UPI. | Both amounts add up to the amount due; two lines on the receipt. | | |
| C8 | Try to collect a payment for a bill that is already paid. | Refused; the screen says there is nothing due. | | |

## B. Discount and cancellation

| # | Step | Expected | P/F/N | Note |
| --- | --- | --- | --- | --- |
| D1 | Apply a 5 % discount with a reason (within your limit). | Applies at once; the reason is shown on the bill. | | |
| D2 | Apply a 20 % discount (above your limit). | The screen asks for "Supervisor username" and "Supervisor PIN". The owner or admin types them; the discount applies and the bill shows the approver. | | |
| D3 | Try a wrong supervisor PIN. | Refused with a message; no discount. | | |
| D4 | "Remove discount". | Total returns to the earlier value; the removal is recorded. | | |
| D5 | Cancel a paid bill: give a reason. The system makes a **credit note** and a refund. | Credit note number shown. Refund above the limit needs the supervisor PIN. | | |
| D6 | "Print refund voucher". | Voucher has the refund amount, the bill, the reason and the approver. | | |
| D7 | Try to cancel the same bill again, or split the cancellation into small credits to stay under the approval limit. | Refused / the approval is required on the total for the bill. | | |

## C. Day end (timed by the clock, not by seconds)

| # | Step | Expected | P/F/N | Note |
| --- | --- | --- | --- | --- |
| E1 | Billing → Day close. Count the cash in the drawer with the **denomination counter** (₹500, 200, 100, 50, 20, 10, coins). | The counted total builds up as you type each note count. | | |
| E2 | Compare with the expected cash. | Expected cash = cash receipts − cash refunds for your counter. A difference is shown clearly with its amount. | | |
| E3 | Enter a reason for a small difference, then close the counter. | The counter is closed; a day-close slip can be printed. The slip shows counted, expected and difference. | | |
| E4 | Check UPI: Billing → UPI reconciliation for the day: tick the credits you see in the bank app. | Matched total vs bank total; unmatched UPI items are listed. | | |
| E5 | Ask the admin to run **Facility close** for the day. | All counters are included; totals equal the Daily collection report. | | |

## Problems found

| # | Step | What happened | Severity |
| --- | --- | --- | --- |
| | | | |

## Sign-off

Day-end totals matched counted cash and bank UPI without manual correction: yes / no

Name: ____________________  Signature: ____________________  Date: ____________
Observer (vendor): ____________________
