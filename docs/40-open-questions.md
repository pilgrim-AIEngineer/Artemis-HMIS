# 40 — Open questions (do not guess; ask the human)

Answered on 23-Oct-2026: USG and MTP are in-house; pharmacy and lab are in-house; staff can operate computers but slowly; doctors write Rx on paper and an assistant enters it; packages exist; deposits are cash and UPI via static QR; Jio Fiber (upgradeable), hardware can be purchased; PM-JAY applied; cardiologist with cath lab, ICU and CCU next year.

## Still open

| # | Question | Affects | Default until answered |
| --- | --- | --- | --- |
| 1 | Is the pharmacy the same legal entity/GSTIN as the hospital, or a separate firm? | Pharmacy invoices, GST reports, `store` legal entity | Same entity; keep `store.legal_entity_id` column ready |
| 2 | Does the hospital have a GSTIN (for taxable lines like room rent > ₹5,000 and pharmacy)? | Invoice format | Assume yes |
| 3 | Is Form F currently filed on the UP online portal or on paper? Exact format the district uses? | `13` | Build official form; add export once format known |
| 4 | How many MTP-certified doctors; which MTP services (medical/surgical) and gestation range? | `14` | Configurable |
| 5 | Who verifies lab reports (in-house pathologist or visiting/remote)? | `16` | Remote verification supported |
| 6 | Exact consultation fees, follow-up validity days and free follow-up counts per doctor | `10`, `12` | Setting defaults 7 days, 1 free follow-up |
| 7 | Package list with inclusions/exclusions and rates by room category | `12` | Seeds without rates |
| 8 | Bed-day rule (midnight vs 24 h) and checkout time | `12`, `17` | Midnight |
| 9 | Staff list with roles (names for user accounts) and number of counters | `03`, hardware | — |
| 10 | Existing software/data to migrate (patients, pharmacy stock, rates)? | MIG-01 | Excel import |
| 11 | Should the OPD sheet print at reception or after vitals? Is there a vitals desk with a printer? | `10 §7` | After vitals |
| 12 | Card POS machine in use? | `12` | Supported, optional |
| 13 | WhatsApp: hospital's business number to use; provider preference | `21` | Meta Cloud API adapter |
| 14 | Does the paediatrician follow IAP or UIP schedule by default? | `11` | IAP |
| 15 | Rx verification mode the owner wants (off / sample / all) | `11 §2.7` | Sample |
| 16 | Does the hospital want typed Rx printed for patients in addition to the paper sheet? | `11` | No |
| 17 | NICU/baby warmer present now? Phototherapy? | `17`, `18` | Baby warmer + phototherapy, no NICU ventilation |
| 18 | PM-JAY empanelment status and the specialties/packages applied for; any obstetric packages reserved for public hospitals in UP | `22` | Configurable HBP import |
| 19 | Cardiologist's joining month; cath lab vendor; ICU/CCU bed counts | `23` planning | — |
| 20 | Hospital brand name/logo/colours for prints and UI accent | `05` | Neutral |
| 21 | Who at the hospital is the day-to-day decision maker for software questions? | process | Owner |
| 22 | Our product's commercial name (replace "HMIS (working name)") | branding | — |

## Decided by Hermes on Sumit's behalf (delegation 25 Oct – 1 Nov 2026)

Treat these as answered unless Sumit overrides them. Each one is also exposed as a setting where possible.

| # | Topic | Decision | Source |
| --- | --- | --- | --- |
| D-1 | Legal register numbering (Form F, MTP register, birth register) | Reset every **calendar year** (`FF/2026/0001`), configurable per key through `numberSeries.config`. Confirm with the Appropriate Authority before go-live. | PR #3 |
| D-2 | MTP audit trail | MTP tables never use the general `audit_log`. MTP-01 adds `restricted.audit_log` with RLS (view requires `mtp.register.view` / `mtp.audit.view`), and the general trigger keeps refusing `restricted.*`. | PR #3 |
| D-3 | Number series on rollback | No gap: a rolled-back allocation is reused. This is stricter than docs/02 §4 and is accepted. | PR #3 |
| D-4 | Who may grant MTP-bearing roles / owner role, or reset/deactivate their holders | **Owner only**. A user manager may appoint the first owner only while the facility has no active owner. | PR #6 |
| D-5 | Scope of the forbidden-term check (`strict` tier) | (a) Before matching, identifiers are normalised: `_`, `-`, `.` and camelCase boundaries become spaces, so `baby_gender`, `fetusSex`, `fetal-sex` match. (b) The `strict` tier (all terms) applies to **every** file under `packages/db/schema/**`, `packages/db/migrations/**` (and any `*.sql`), `packages/db/seed/**`, `packages/print/**`, plus any path with a segment matching `anc*`, `antenatal*`, `pregnan*`, `obstet*`, `usg*`, `ultrasound*`, `sonograph*`, `scan*`, `form-f*`/`form_f*`, `mtp*`, `labour*`, `prompts/`, `*.prompt.*`. (c) The only relaxation is for born-baby code: paths with a segment matching `newborn*`, `birth*`, `death*`, `vaccin*`, `paed*`/`pediatric*` stay on the `always` tier; elsewhere the sex of a born baby is stored as `sex` on the patient/newborn row, never `baby_gender`. Generic patient-demographic Hindi labels (`लिंग`) belong in i18n (key-scoped), not hard-coded in strict-scope files. The Form F `living_children[].sex` key allowlist stays. Widest safe scope chosen because a leaked column cannot be dropped in one step (rule 14). | Issue #14 |
| D-6 | Upper bound on money/rate inputs | Two layers. (a) **Policy cap** in `setting` key `money.max_rate_paise`, default **₹10,00,000** (`100000000` paise) per unit rate / single amount entry; zod input schemas and tRPC procedures reject values above it with a clear i18n error. (b) **Hard DB ceiling**: every rate/amount `bigint` column gets an additive CHECK `<= 1000000000000` paise (₹1,000 crore per row) so qty × rate and SUM() can never overflow bigint. `MAX_PAISE` in `packages/shared` drops to `Number.MAX_SAFE_INTEGER`-aligned safe value. UI shows a confirm prompt when a rate is ≥10× the previous rate for that service (typo guard). | Issue #27 |
| D-7 | Backdated / corrected service rates | `effective_from` must be **today or later** (Asia/Kolkata). Backdating (for downtime back-entry) needs permission `masters.rate.backdate` (owner/admin only) plus a mandatory reason code (`downtime_entry`, `price_error`, `other` + text), and is rejected if any non-cancelled bill line for that service already exists on/after the new date. Same-day corrections require a user-supplied reason (no canned reason). Both are audited. Already-posted bill lines are never re-priced; they keep their stored rate. | Issue #42 |
| D-8 | Room-specific vs room-agnostic rate precedence | Take the newest row on or before the date. Ties go to the room-specific row. A room-specific row therefore overrides only when its `effective_from` >= the latest base row's. When a base rate is changed and room-specific rates exist for that service, the rate screen shows a warning that lists them. | Issue #41 |
| D-9 | DPDP notice and consent at registration | Build it now as an additive follow-up to REG-01: a `patient_consent` table (purpose enum `treatment`, `whatsapp`, `abdm`; `granted` bool; `notice_version`; captured_by/at; withdrawn_at/by; append-only, no hard delete). The registration form shows a short bilingual notice: treatment consent is required, WhatsApp is an opt-in checkbox that is **unticked by default**. The WhatsApp outbox must skip (`status=skipped_no_consent`) any patient without an active `whatsapp` grant. Consent can be withdrawn from the patient profile. | Issue #39 |
| D-10 | Runtime forbidden-term guard on inputs | Server-side zod refinement with `findForbiddenTerms` on **every** free-text input: USG procedure code/name, all masters names, all patient free-text (referred_by, occupation, address, override reasons), and all clinical notes. USG/ANC/MTP/Form F contexts use the `strict` tier; other contexts use the `always` tier, so "sex" as a demographic field label stays allowed. Rejections return an i18n error and are logged to `access_log` without the text itself (rule 15). Guarding general free text too is the safest choice under rule 7 ("no free-text hint"). | Issue #37 |
