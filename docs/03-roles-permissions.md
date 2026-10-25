# 03 — Roles and permissions

Roles are bundles of permission keys. Admin can create custom roles and assign multiple roles to a user. Permissions are checked server-side on every procedure.

## 1. Default roles

| Role key | Typical user | Home screen |
| --- | --- | --- |
| `owner` | Owner gynaecologist | Dashboard |
| `admin` | Hospital manager | Admin |
| `doctor` | Gynaecologist, paediatrician, later cardiologist | Doctor's queue (view patients, sign/verify) |
| `doctor_assistant` | Assistant who enters Rx from paper | Transcription queue |
| `reception` | Front desk | Registration & token |
| `cashier` | Billing desk (OPD + IPD) | Billing |
| `nurse` | Ward, labour room, ICU | Bed board / nursing |
| `pharmacist` | Pharmacy | Pharmacy counter |
| `lab_tech` | Lab | Lab worklist |
| `pathologist` | Report verifier (may be external) | Lab verification |
| `usg_doctor` | Doctor performing scans | USG worklist |
| `usg_assistant` | Helps with Form F data entry | USG worklist (no sign) |
| `mtp_doctor` | MTP-certified RMP(s) | MTP register |
| `store_keeper` | Main store (Phase 2) | Store |
| `pmjay_desk` | Arogya Mitra / insurance desk (Phase 2B) | Payer desk |
| `auditor` | CA/consultant, read-only | Reports |

## 2. Permission keys

```
admin.users.manage          admin.roles.manage          admin.settings.manage
admin.masters.manage        admin.tariff.manage         admin.audit.view
patient.create              patient.update              patient.merge
patient.view                patient.view.restricted     (never granted by default; see MTP)
visit.create                visit.cancel                queue.manage
queue.display.manage        vitals.record
rx.transcribe               rx.verify                   rx.view
order.create                order.cancel
clinical.anc.edit           clinical.paeds.edit         clinical.note.edit
billing.bill.create         billing.bill.finalize       billing.bill.cancel
billing.payment.collect     billing.refund.create       billing.discount.apply
billing.discount.approve    billing.dayclose.own        billing.dayclose.facility
billing.deposit.collect     billing.package.apply       billing.ipd.final
usg.report.edit             usg.report.sign             pcpndt.formf.edit
pcpndt.formf.sign           pcpndt.reports.view
mtp.register.view           mtp.register.edit           mtp.reports.view
pharmacy.sale               pharmacy.return             pharmacy.purchase
pharmacy.stock.adjust       pharmacy.h1.view            inventory.transfer
inventory.indent            inventory.consignment
lab.sample.collect          lab.result.enter            lab.result.verify
ipd.admit                   ipd.transfer                ipd.discharge
ipd.order.write             ipd.note.write              nursing.chart
nursing.mar                 ot.schedule                 ot.note.write
lr.note.write               newborn.register            registers.birth.view
discharge.write             discharge.sign
reports.collection          reports.clinical            reports.financial
reports.owner_dashboard     payer.pmjay.manage          payer.tpa.manage
payer.corporate.manage      cardiology.report.edit      icu.chart
cathlab.report.edit         implants.manage
```

## 3. Default role → permission matrix (summary)

- `owner`: all except `patient.view.restricted` and `mtp.*` unless the owner is also an MTP doctor (then add role `mtp_doctor`).
- `admin`: `admin.*`, all reports, `billing.dayclose.facility`, `billing.discount.approve`, `patient.merge`. No clinical edit.
- `doctor`: `patient.view`, `rx.verify`, `rx.view`, `order.create`, `clinical.*`, `ipd.order.write`, `ipd.note.write`, `discharge.*`, `ot.note.write`, `lr.note.write`, own `reports.clinical`.
- `doctor_assistant`: `patient.view`, `vitals.record`, `rx.transcribe`, `rx.view`, `order.create`, `clinical.anc.edit`, `clinical.paeds.edit`, `clinical.note.edit` (drafts), `ipd.order.write` (drafts requiring doctor verification when setting `ipd.ordersRequireVerify` = true).
- `reception`: `patient.create/update/view`, `visit.create`, `queue.manage`, `billing.bill.create`, `billing.bill.finalize` (OPD), `billing.payment.collect`, `billing.discount.apply` (within limit), `billing.dayclose.own`, `vitals.record` (optional).
- `cashier`: reception billing permissions + `billing.deposit.collect`, `billing.package.apply`, `billing.ipd.final`, `billing.refund.create`, `billing.bill.cancel` (requires approval above limit).
- `nurse`: `patient.view`, `vitals.record`, `nursing.*`, `ipd.transfer`, `inventory.indent`, `lr.note.write` (assist), `newborn.register`.
- `pharmacist`: `pharmacy.*` (except `stock.adjust` needs `admin` approval), `inventory.transfer`, `rx.view`.
- `lab_tech`: `lab.sample.collect`, `lab.result.enter`. `pathologist`: + `lab.result.verify`.
- `usg_doctor`: `usg.*`, `pcpndt.*`. `usg_assistant`: `usg.report.edit` (draft), `pcpndt.formf.edit` (draft).
- `mtp_doctor`: `mtp.*`, `patient.view.restricted`.
- `auditor`: `reports.*` (read), `admin.audit.view`.

## 4. Discount and approval rules

Setting `billing.discountLimits` (defaults):

| Role | Max discount without approval |
| --- | --- |
| reception | 0% (any discount needs approval) |
| cashier | 10% or ₹500, whichever is lower |
| admin / owner | unlimited |

Approval flow: cashier requests → approver enters their PIN on the same screen (in-person approval). The approver's user id is stored on the discount line. Reason required (pick list + text).

## 5. Restricted data rules

- MTP records live in schema `restricted`. Only users with `mtp.register.view` can query; the DB role for the app uses row-level security keyed on `app.user_permissions` session variable as a second line of defence.
- An MTP admission is a normal IPD encounter for billing and bed purposes, but the encounter has `is_restricted = true`. For users without `patient.view.restricted`:
  - diagnosis/procedure fields show "Gynae procedure (restricted)";
  - clinical notes are hidden;
  - the encounter is excluded from patient timeline and clinical reports;
  - billing shows a neutral package name configured per MTP package (e.g., "Gynae day-care procedure").
- Form F records: visible to `pcpndt.*` permission holders and owner only.
- Every view of restricted data writes `access_log`.

## 6. Sessions per workstation

Shared PCs: idle lock after 10 min (setting), PIN unlock for the same user, "Switch user" button always visible. A user may be logged in on multiple workstations; admin can see active sessions and revoke them.
