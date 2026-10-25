# 02 — Coding conventions

## 1. Naming

- DB: `snake_case` tables (singular: `patient`, `bill_line`), columns `snake_case`. Drizzle exports camelCase.
- tRPC procedures: `module.verbNoun` (`billing.createOpdBill`, `queue.callNext`).
- Permission keys: `module.action` (`billing.discount.approve`). Full list in `docs/03`.
- Files: kebab-case. React components PascalCase.

## 2. Money and numbers

- Store paise as `bigint`. Use helpers in `packages/shared/money.ts`: `rupeesToPaise`, `paiseToRupees`, `formatINR` (Indian grouping: ₹1,23,456.00), `sumPaise`, `applyPercentBp`.
- Rounding: line amounts computed in paise exactly; bill total rounded to nearest rupee with a `round_off_paise` line (setting `billing.roundToRupee`, default true).
- GST: `gst_rate_bp` per line; tax computed per line, half CGST/half SGST for intra-state. Show taxable value, CGST, SGST per HSN/SAC on invoices that have taxable lines.
- Quantities: `numeric(12,3)`.

## 3. Dates and times

- Store `timestamptz` (UTC). Display `Asia/Kolkata`. Use `date-fns-tz`.
- Clinical dates (LMP, EDD, DOB, vaccine due) are `date` (no time zone).
- Display format: `23-Oct-2026`, `23-Oct-2026 10:42`. Hindi locale uses same digits (Latin numerals).
- Age display: `< 1 month → n days`, `< 2 years → n months`, else `n years`. Age-only registrations store `dob_is_estimated = true` with DOB = 1 July of computed year (or today minus months for infants).

## 4. Number series

`number_series(facility_id, key, fy, prefix, next_value, padding)`. Allocate with `UPDATE ... SET next_value = next_value + 1 RETURNING` inside the business transaction. Gaps are allowed only when a transaction rolls back; cancelled documents keep their numbers.

| Key | Format example | Reset |
| --- | --- | --- |
| uhid | `GH-000123` (prefix configurable) | never |
| opd_visit | `OP/26-27/004512` | FY |
| token | `12` per doctor per day | daily (not a series row; computed with advisory lock) |
| opd_bill | `OB/26-27/004512` | FY |
| ipd_admission | `IP/26-27/00321` | FY |
| ipd_bill | `IB/26-27/00321` | FY |
| receipt | `RC/26-27/010233` | FY |
| deposit | `DP/26-27/00456` | FY |
| refund / credit_note | `CN/26-27/00012` | FY |
| pharmacy_invoice | `PH/26-27/012345` | FY |
| purchase_grn | `GRN/26-27/00456` | FY |
| lab_order | `LB/26-27/007891` | FY |
| form_f | `FF/2026/0001` | calendar year (confirm with Appropriate Authority) |
| mtp_register | `MTP/2026/001` | calendar year |
| birth_register | `BR/2026/0001` | calendar year |

## 5. Audit and access logs

- `audit_log(id, facility_id, table_name, row_id, action [I/U], changed_by, changed_at, workstation_id, before jsonb, after jsonb)` via a generic PL/pgSQL trigger attached to every business table. `changed_by`/`workstation_id` come from `SET LOCAL app.user_id = ...` executed at the start of every transaction by the DB helper `withTx(ctx, fn)`.
- `access_log(id, facility_id, user_id, entity, entity_id, purpose, at)` written by the app for every read of MTP records, Form F records, and any "break-glass" view.
- Audit tables are append-only: revoke UPDATE/DELETE from the app role.

## 6. Cancellation, amendment, reversal

- Bills, receipts, deposits: `status` in (`draft`, `final`, `cancelled`). Cancelling a final document requires permission + reason and creates a `credit_note` (for bills) or a reversal `payment` row.
- Clinical notes and reports: once `signed`/`released`, edits create an `addendum` row linked to the original. Show "Amended" on reprint.
- Stock: never update quantities directly. Insert `stock_movement` rows; balances come from a materialised `stock_balance` updated in the same transaction.

## 7. API layer

- Every procedure: `protectedProcedure.meta({ permission: 'x.y' }).input(zodSchema)`. Middleware checks session, permission, facility.
- Mutations run inside `withTx`. Long operations go to the worker.
- Errors: throw `TRPCError` with i18n message keys; never leak SQL errors to the UI.
- Pagination: cursor-based (`id` + `created_at`).
- Idempotency: mutations that create money rows accept `idempotencyKey` (UUID from client); table `idempotency` unique on (facility_id, procedure, key) with `request_hash`; use `runIdempotent` (`packages/db`): same hash replays the stored result, a different hash is CONFLICT.

## 8. Frontend

- Forms: react-hook-form + zodResolver, schemas imported from `packages/shared`.
- Data fetching: tRPC + TanStack Query; optimistic updates only for queue state changes.
- Every list screen has: search box focused on load, keyboard navigation (↑/↓/Enter), empty state, loading skeleton.
- Shared components in `packages/ui`: `PatientHeader`, `MoneyInput`, `DrugPicker`, `ServicePicker`, `Keypad`, `ConfirmMoneyDialog`, `PrintButton`, `BilingualLabel`.

## 9. Testing

- Unit: pure functions in `packages/shared` (money, GST, EDD/GA, vaccine schedule, dose calc, search normalisation, number formats).
- Integration: tRPC procedures against real Postgres (transaction rollback per test).
- E2E: Playwright critical flows listed in `docs/32`.
- Seed: `pnpm db:seed --demo` creates realistic data (Indian names, mobiles `9xxxxxxxxx`, 500 patients, 30 days OPD, 50 pregnancies, 80 children).

## 10. Git

- Conventional commits with feature ID: `feat(BIL-02): split payments`.
- Migrations reviewed by the human before merge to `main`.
- `main` is always deployable; releases tagged `vYYYY.MM.DD.n`.
