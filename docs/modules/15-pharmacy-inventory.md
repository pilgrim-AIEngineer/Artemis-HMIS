# 15 — Pharmacy and inventory [Phase 2A; implants/consignment Phase 3]

Feature IDs: INV-01 … INV-05, CTH-02.

## 1. Stores

Multi-store from day one: `Pharmacy` (saleable, drug licence), `Main store`, `OT store`, `Labour room`, `Ward stock`, later `ICU`, `CCU`, `Cath lab`, `Lab reagents`. Every movement is per store.

## 2. Item master (INV-01)

- Medicines link to `drug` (shared with Rx); consumables/implants/reagents are `item` only.
- Fields: name, generic, form, strength, manufacturer, HSN, GST %, schedule (H/H1/X/NDPS), UOM, pack size (e.g., strip of 10), sell by unit or pack, reorder level per store, rack, batch/expiry/serial tracking flags, price cap (for capped items like coronary stents/knee implants — value maintained by admin from the NPPA notification).
- Import from distributor/Excel template.

## 3. Purchase and GRN (INV-02)

- Supplier invoice entry: supplier, invoice no/date, items with batch, expiry (MM/YY), qty, free qty, purchase rate, MRP, discount, GST → GRN number, stock in.
- Validations: expiry not in the past; MRP ≥ sale rate; duplicate invoice no per supplier warning; total matches invoice total (enter invoice total to cross-check).
- Purchase return (expired/damaged) with debit note print.
- (Later) CSV import from distributor billing software.
- Consignment GRN (Phase 3, cath lab): `is_consignment = true`; stock owned by vendor until used; usage generates a vendor bill request report.

## 4. Pharmacy sale (INV-03)

- Sources: (a) Rx from the system — pharmacist opens patient/token, Rx items appear; (b) walk-in sale (customer name optional, doctor optional; H1 items require prescriber name and patient name/address); (c) IPD issue (see 5).
- Batch selection FEFO automatically; pharmacist can override batch (logged). Expired/blocked batches cannot be sold.
- Pricing: MRP-based (sale rate ≤ MRP), item/bill discount with role limit. GST computed back from MRP-inclusive price (MRP is tax-inclusive in India): taxable = amount × 100 / (100 + GST%).
- Invoice (A5 or 80 mm) with drug licence numbers, GSTIN, HSN, batch, expiry, MRP, GST breakup, pharmacist name.
- Returns within N days (setting) for unopened strips: credit note, stock back to the same batch.
- Substitution: if Rx brand unavailable, pharmacist can pick another brand of the same generic+strength; recorded as substitution.
- Payment modes as in `12`.

## 5. IPD medicine flow (INV-04)

- Doctor IPD orders → nurse indent (ward store → pharmacy) or direct issue to patient.
- Pharmacy issues against indent: stock moves to the patient (posted to IPD bill as lines, `source = pharmacy_sale_item`, IPD exempt per `12 §7.5`).
- Unused returns from ward → stock back, bill line reversed.
- Ward/OT/LR store stock (imprest) with par levels; consumption entries charge the patient or are absorbed per item setting `billable_on_consumption`.

## 6. Registers and reports (INV-05)

- **Schedule H1 register** auto-maintained: date, patient name and address, prescriber name, drug name, qty (retain at least 3 years). Printable by date range.
- NDPS/Schedule X registers if they stock such drugs (feature flag; separate balance register).
- Expiry report (90/60/30 days), near-expiry return list per supplier, expired write-off with approval.
- Reorder report per store (below reorder level, average daily usage last 30 days).
- Stock valuation (purchase rate and MRP), movement ledger per item/batch.
- Sales reports: daily, by doctor (which doctor's Rx), by item; margin report (owner only).
- GST: outward supplies summary by HSN/rate (GSTR-1 ready CSV), purchase register (for ITC reconciliation by CA).
- Stock audit/physical count: count sheet by rack → adjustments with reason and approval.

## 7. Implants and consignment (CTH-02, Phase 3)

- Serial/UDI barcode capture at GRN and at use (scan sticker). Implant sticker photo attached to the patient record and the bill.
- Price cap enforcement: billed rate cannot exceed `price_cap_paise` (if set) — hard block; bill shows implant brand, size, batch/serial and MRP as separate lines (needed for coronary stents per NPPA requirements; confirm current notification).
- Consignment usage report per vendor for replenishment and vendor billing.

## 8. Acceptance

- Stock never negative under concurrent sales (test with parallel sales of the last units).
- FEFO picks the earliest non-expired batch; expired batch sale blocked.
- MRP-inclusive GST back-calculation matches CA-provided examples to the paisa.
- H1 register entries created for every H1 sale, including walk-ins.
- Return restores the same batch quantity and reverses the bill line.
