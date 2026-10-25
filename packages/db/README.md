# @hmis/db

Drizzle schema (`schema/`), committed SQL migrations (`migrations/`), and the transaction,
audit and number-series helpers (`src/`). Rules: `AGENTS.md` §3, `docs/02`, `docs/04`.

## Database roles

| Role                                     | Kind                        | Used by                                             | Rights                                                                                                                                                                         |
| ---------------------------------------- | --------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POSTGRES_USER` (e.g. `hmis`)            | LOGIN, owner                | `pnpm db:migrate`, pg-boss (creates its own schema) | Owns every table; runs DDL                                                                                                                                                     |
| `hmis_app`                               | NOLOGIN group               | — (created by migration `0001`)                     | `SELECT, INSERT, UPDATE` on `public` tables; **no DELETE** (except `idempotency`); `audit_log`: SELECT only; `access_log`, `print_log`: SELECT + INSERT; USAGE on `restricted` |
| `APP_DB_USER` (default `hmis_app_login`) | LOGIN, member of `hmis_app` | `apps/web` business queries                         | Inherits `hmis_app`                                                                                                                                                            |

`pnpm db:migrate` creates or updates the app login from `APP_DB_USER` / `APP_DB_PASSWORD`
(`ensureAppLoginRole`), then the web app connects with it (`resolveAppDatabaseUrl`). Without
`APP_DB_PASSWORD` the web app falls back to the owner URL; that is acceptable only on a dev
machine. Grants for future tables come from `ALTER DEFAULT PRIVILEGES` (same owner role);
`src/platform.test.ts` asserts the whole privilege matrix, so a new table that needs different
rights must update that test.

## Transactions: `withTx(ctx, fn)`

Every mutation runs inside `withTx`. Its first statement sets, transaction-locally:

| Setting                | Read by                                                                         |
| ---------------------- | ------------------------------------------------------------------------------- |
| `app.user_id`          | audit trigger (`changed_by`), `created_by`/`updated_by` defaults, touch trigger |
| `app.workstation_id`   | audit trigger (`workstation_id`)                                                |
| `app.facility_id`      | RLS policies                                                                    |
| `app.user_permissions` | `hmis_has_permission(key)` in RLS policies (comma-separated keys)               |

## Adding a business table

1. Add the table in `schema/` with `idColumn()`, a `facility_id` FK and `...auditColumns()`.
2. `pnpm db:generate --name <change>` and commit the SQL (additive only, AGENTS.md rule 14).
3. `pnpm --filter @hmis/db exec drizzle-kit generate --custom --name <change>_audit` and add:

   ```sql
   SELECT public.hmis_register_business_table('public.patient');
   -- secrets are stored as "[redacted]" / "[redacted:changed]" in audit_log:
   SELECT public.hmis_register_business_table('public.x', ARRAY['secret_col']);
   -- columns whose sole change is not worth an audit row (e.g. heartbeats):
   SELECT public.hmis_register_business_table('public.y', '{}', ARRAY['last_seen_at']);
   ```

   This attaches `hmis_touch` (BEFORE UPDATE: sets `updated_at`/`updated_by`; `id`,
   `facility_id`, `created_*` immutable) and `hmis_audit` (AFTER I/U/D: full before/after JSON
   into `audit_log`, `SECURITY DEFINER`). The trigger test fails for any public table that is
   neither registered nor listed in its `NOT_AUDITED` allow-list.

## Restricted schema (MTP, AGENTS.md rule 8)

`restricted` exists and is empty until MTP-01. PUBLIC has no access; `hmis_app` has USAGE.
Every table there must enable RLS keyed on the transaction's permissions and facility:

```sql
CREATE TABLE restricted.mtp_case (...);
ALTER TABLE restricted.mtp_case ENABLE ROW LEVEL SECURITY;
CREATE POLICY mtp_case_view ON restricted.mtp_case FOR SELECT TO hmis_app
  USING (hmis_has_permission('mtp.register.view')
         AND facility_id = nullif(current_setting('app.facility_id', true), '')::uuid);
CREATE POLICY mtp_case_edit ON restricted.mtp_case FOR INSERT TO hmis_app
  WITH CHECK (hmis_has_permission('mtp.register.edit')
              AND facility_id = nullif(current_setting('app.facility_id', true), '')::uuid);
-- likewise FOR UPDATE with USING + WITH CHECK
```

RLS is the second line of defence; `requirePermission` in the tRPC procedure stays the first,
and every read still writes `access_log`. `hmis_register_business_table` refuses restricted
tables on purpose: their before/after JSON must not land in the general `audit_log` (visible
to `admin.audit.view`). MTP-01 adds a restricted audit sink before the first restricted table.

## Number series (docs/02 §4)

- `allocateNumber(tx, facilityId, key, at)` inside the business transaction:
  `UPDATE number_series SET next_value = next_value + 1 ... RETURNING`. The row lock serialises
  allocators until commit; a rollback undoes the increment, so committed numbers are gap-free and
  a cancelled document keeps its number. The first allocation of a period inserts the row
  (`ON CONFLICT DO NOTHING`, then bump).
- Period on the IST calendar of `at`: `all` (UHID, never resets), FY `2026-27` (1 April 00:00
  IST), calendar `2026`. Pass the original business time for downtime back-entry.
- Defaults (prefix, padding, reset) live in `@hmis/shared` `NUMBER_SERIES`; setting
  `numberSeries.config` overrides them per key. A new period copies prefix/padding from the
  setting, else the previous period's row, else the default.
- `allocateDailyToken(tx, { facilityId, doctorId, at, currentMax })`: per doctor per IST day,
  under `pg_advisory_xact_lock`; READ COMMITTED only.

## Auth helpers (FND-02/03)

- `@hmis/db/auth`: `hashSecret`/`verifySecret` (argon2id, passwords and PINs), `insertUser`,
  `bootstrapFacility` (used by `pnpm db:seed`). Separate subpath so the worker bundle never loads
  the native argon2 binding.
- `rbac.ts`: `DEFAULT_ROLE_PERMISSIONS` (docs/03 §3), `ensureFacilityRbac(tx, facilityId)`
  (idempotent; never re-adds a grant an admin revoked), `loadUserAccess` (scoped to the user's
  facility). New permission keys go into `@hmis/shared` `PERMISSIONS`; re-running `db:seed`
  adds them to every facility.
- Secrets in `audit_log` are redacted: `app_user.password_hash/pin_hash/totp_secret_enc`,
  `session.token_hash`, `workstation.pairing_token_hash`.

## Masters, seeds and rates (FND-07)

- Tables (`schema/masters.ts`, docs/04 §2): `department`, `doctor_profile`, `consultation_rule`,
  `payer`, `tariff`, `service`, `service_rate`, `drug`, `lab_test`, `usg_procedure`, `locality`,
  `reason_code`. All carry `facility_id`, the audit columns, audit/touch triggers and the soft-cancel
  fields (`status`, `cancel_reason`, `cancelled_by/at`; `hmis_app` has no DELETE). `is_active` is the
  reversible "switched off" flag; `status = 'cancelled'` is the removal with a reason.
- `search_text` is a generated column (`hmis_search_text(...)`, migration 0005) with a trigram GIN
  index; query it with `search_text like '%q%' or q <% search_text` (see the masters router).
- Rates: `setServiceRate` adds an effective-dated row (a same-day correction cancels the old row
  with a reason), `getRate` resolves the price on a date (room-specific, else room-agnostic) and
  `pickTariff` the payer's tariff or the default one (docs/12 §1). Bills must snapshot the rate.
- `pnpm db:seed` runs `seed/masters.ts` (docs/33 §1–3, §6–7): idempotent, never overwrites edits,
  no rates. `--demo` runs the steps listed in `seed/demo/index.ts` (synthetic doctors and rates;
  `people.ts`/`rng.ts` generate Indian names and `9xxxxxxxxx` mobiles for later steps). Add a step
  module there when a PR adds data worth demoing.
- `seed/templates/*.xlsx` are the MIG-01 import templates (docs/33 §9), generated from
  `seed/templates/spec.ts` by `pnpm --filter @hmis/db db:templates`; `src/templates.test.ts` keeps
  files and spec in step. Never commit a filled-in template.
