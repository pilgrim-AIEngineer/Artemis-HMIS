# 12 — Billing, payments, packages, deposits, day close

Feature IDs: BIL-01 … BIL-07 (BIL-07 is Phase 2A), PAY-01 (Phase 2B).

GST statements below are the expected treatment; the hospital's CA must confirm rates and exemptions before go-live (see `docs/30`). All rates live in masters, never in code.

## 1. Pricing model (built in Phase 1, multi-payer used from Phase 2B)

- `service` × `tariff` (× `room_category` for IPD services) → `service_rate`.
- `payer` → default `tariff`. Phase 1 has one payer (Cash/Self) and one tariff (Standard).
- Encounter carries `payer_id` and `tariff_id`; every bill line is priced from the encounter's tariff at the time the line is added (rate snapshot stored on the line).
- Rate changes: new `service_rate` with `effective_from`; old bills keep their snapshot.
- Missing rate → line cannot be added; prompt admin (or allow manual rate with permission `billing.rate.override`, logged).

## 2. OPD bill (BIL-01)

- Created automatically at visit creation with the consultation line (draft).
- Billing screen per patient shows: unbilled orders (from transcription) with checkboxes pre-ticked, existing draft bill lines, "Add service" search, payer, totals.
- One bill per encounter for OPD by default; pharmacy has its own invoice (Phase 2A). Setting `billing.splitUsgBill` (default false) allows a separate bill for USG.
- Lines: description (bilingual), qty, rate, amount, discount, GST (if any), patient share.
- Finalising a bill requires full payment unless setting `billing.allowOpdCredit` (default false, owner-only override).
- Finalised bill → orders move to `billed`, appear in USG/lab worklists.

## 3. Payments (BIL-02)

Modes in Phase 1: **cash**, **UPI (static QR)**, **card** (if they have a POS machine), split across modes.

### UPI via static QR

- The hospital's printed QR stays at the counter. Staff selects UPI and enters the amount; optional fields: last 4–6 digits of UTR, payer name (setting `billing.upiRefRequired`: `off`, `optional` (default), `required_above_amount` e.g. ₹2,000).
- Optional "Show QR" button displays the hospital's static QR image (uploaded in settings) on a customer-facing screen, with amount shown in large text.
- **Daily UPI reconciliation** screen: system UPI total per day vs amount entered from the bank/UPI app statement; list of UPI receipts to tick off; difference noted with reason. (Later upgrade: dynamic QR via a payment gateway or bank soundbox API with auto-match — keep `payment.upi_ref` and `provider_ref` columns ready.)

### Rules

- Payment dialog shows amount due in large text and words (Hindi/English). Tendered cash → change to return.
- Every payment has an `idempotency_key`; double-click cannot create two receipts.
- Receipt number from series; receipt printed (80 mm thermal default) with UHID, bill no, items summary, amount, mode, UTR last digits, received by.
- Payment reversal (wrong mode/amount same day) by cashier with reason; after day close only admin.

## 4. Discounts (BIL-03)

- Line or bill level, percent or amount; reason from `reason_code` (Staff, Doctor discretion, Poor patient, Follow-up concession, Other).
- Role limits from `03 §4`; above limit → approver PIN on the same screen.
- Discount report for the owner (who, how much, why).

## 5. Cancellation and refunds (BIL-04)

- Draft bill: can be deleted? **No** — draft lines can be removed; the draft bill can be "voided" (status cancelled, no number gap issue because drafts get numbers only on finalise).
- Final bill cancellation: permission + reason → `credit_note` for full/partial amount → refund payment (negative) in the chosen mode, or adjust against a new bill. Orders linked to cancelled lines return to `ordered` or `cancelled` per choice.
- Refund over ₹1,000 (setting) needs approver PIN.

## 6. Day-end close (BIL-06)

- Per user: system shows expected cash, UPI, card for the user's receipts since their last close. User enters counted cash using a **denomination counter** (₹500 × n, ₹200 × n, ₹100 × n, ₹50, ₹20, ₹10, coins) → difference computed; reason required if non-zero.
- After close, the user's payments are locked to that `day_close`. Late corrections need admin.
- Facility close (admin/owner): summary of all user closes, totals by mode, department, doctor; UPI reconciliation status; print and WhatsApp to owner.
- Day close does not block further work; a new period starts.

## 7. Packages, deposits, IPD bill (BIL-07, Phase 2A)

### 7.1 Package master

- Package: code, name (bilingual), department, room category (or "any"), included days, inclusions (service categories or specific services with quantity caps, e.g., "OT charges ×1, surgeon fee ×1, anaesthesia ×1, room ×3 days, nursing ×3 days, standard medicines & consumables up to ₹X"), exclusions (e.g., blood products, NICU stay, special investigations, implants), extra-day rate service.
- Rate per tariff × room category (`package_rate`). Neutral display name for restricted packages (MTP).
- Seeded examples (rates entered by hospital): Normal Delivery, LSCS, LSCS + Tubectomy, Hysterectomy (abdominal/vaginal/laparoscopic), D&C, Laparoscopy diagnostic, Cerclage, Ovarian cystectomy, MTP (restricted, neutral name), Newborn care (normal), NICU per day.

### 7.2 Applying a package

- On admission or later (permission `billing.package.apply`). Creates `package_instance` and a package line on the IPD bill at the package rate.
- Auto-posting: any later charge (bed day, nursing, OT, medicines, lab) is matched against inclusions. Included → line posted with `inside_package = true`, amount shown but **not charged** (₹0 to patient), counting towards caps. Excluded or over cap → normal charged line.
- Extra days beyond included days → extra-day service posted automatically by the daily charge job.
- Room upgrade during package: setting `billing.packageRoomChange` = `reprice_to_new_category` (default) or `charge_difference_per_day`.
- Removing a package: reprices all lines itemised (permission + reason).

### 7.3 Deposits

- Collected at admission and anytime (cash/UPI/card) with receipt (`payment.kind = deposit`).
- Running balance (deposits − charges so far) visible on IPD billing, bed board tooltip and to the doctor. Alert when balance < setting threshold (e.g., ₹5,000) to request more deposit.
- At final bill: deposits adjusted (`deposit_adjustment`), balance collected or refunded (refund needs approval).

### 7.4 Interim and final bill

- Interim bill: snapshot print any time (not a tax invoice; watermark "INTERIM").
- Final bill: on discharge clearance; checks: all orders billed/cancelled, pharmacy returns processed, no pending lab bills, package reconciliation reviewed. Prints A4 itemised bill (with package summary + items inside package shown as ₹0 + outside package charges), and a summary bill.
- Daily auto-charges (job at 00:05 or configured time): bed charge by current room category (check-in time rule: setting `ipd.bedDayRule` = `midnight` (default) or `24h_from_admission`), nursing charge, RMO charge, doctor visit charges entered by nurse/doctor per visit.

### 7.5 GST in hospital billing (expected, CA to confirm)

- Healthcare services by a clinical establishment (consultation, procedures, lab, USG, OT, nursing) → exempt (`is_exempt = true`, SAC 9993).
- Room rent: non-ICU room charge **> ₹5,000 per day** → 5% GST on the room line (no ITC). ICU/CCU/NICU rooms exempt. Implement via `room_category.gst_applicable_above_paise` and `is_icu`.
- Medicines/consumables supplied to admitted patients as part of treatment → part of healthcare service (exempt) when billed on the IPD bill.
- OPD/walk-in pharmacy sales → taxable at item GST rates (pharmacy invoice, see `15`).
- Non-medical items (canteen, attendant food, cosmetic procedures) → taxable; flag per service.

## 8. Multi-payer (PAY-01, Phase 2B)

- Payer types become selectable on visit/admission. Selecting PM-JAY/TPA/corporate sets tariff and requires coverage details (see `22`).
- Lines split `payer_share` / `patient_share`:
  - PM-JAY: package covered fully; patient share ₹0 for covered items; non-covered items need explicit patient consent and are usually not allowed — default: block patient charges on PM-JAY encounters (setting per SHA rules).
  - TPA (Phase 3): room-rent capping, non-payables list, co-pay %; patient pays the difference.
- Bills show payer and patient portions; receipts only for the patient portion; payer portion tracked in `claim`.

## 9. Acceptance

- Property-based tests on bill totals (random lines, discounts, GST) satisfy invariants in `04 §15`.
- Concurrency: two cashiers collecting on the same bill cannot overpay (row lock on bill).
- Day close reconciliation matches the sum of payments exactly.
- Package scenarios: LSCS 3 days, stay 5 days, NICU exclusion, room upgrade on day 2 — expected bills match hand-calculated fixtures provided by the owner.
- Reprint shows DUPLICATE; cancelled receipts print with CANCELLED watermark.
