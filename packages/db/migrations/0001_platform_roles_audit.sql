-- FND-04: DB roles, append-only grants, generic audit + touch triggers, restricted-schema helpers.
-- Hand-written (drizzle-kit generate --custom). Runs as the migration owner, which owns every
-- table. The app connects as a LOGIN role that is a member of `hmis_app` (packages/db/README.md).

-- 1. App role (cluster-wide, so guard against concurrent creation from another database).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hmis_app') THEN
    BEGIN
      CREATE ROLE hmis_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
      NULL;
    END;
  END IF;
END
$$;
--> statement-breakpoint

-- 2. UUIDv7 for rows generated inside the database (audit_log). App rows use the `uuidv7` package.
--    48-bit Unix ms, version 7 + 12-bit sub-millisecond fraction (RFC 9562 §6.2 method 3, as in
--    PostgreSQL 18's uuidv7()), then the random variant half of a v4 UUID.
CREATE OR REPLACE FUNCTION public.hmis_uuid_v7() RETURNS uuid
LANGUAGE sql VOLATILE PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT encode(
    substring(int8send(ms) FROM 3)
      || int2send((28672 + sub)::smallint)
      || substring(uuid_send(gen_random_uuid()) FROM 9),
    'hex')::uuid
  FROM (
    SELECT floor(e)::bigint AS ms, floor((e - floor(e)) * 4096)::int AS sub
    FROM (SELECT extract(epoch FROM clock_timestamp()) * 1000 AS e) AS now_ms
  ) AS parts
$$;
--> statement-breakpoint

-- 3. Actor from `withTx` (SET LOCAL app.user_id / app.workstation_id). NULL = system.
CREATE OR REPLACE FUNCTION public.hmis_current_user_id() RETURNS uuid
LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.hmis_current_workstation_id() RETURNS uuid
LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $$ SELECT nullif(current_setting('app.workstation_id', true), '')::uuid $$;
--> statement-breakpoint

-- 4. RLS helper for `restricted.*` policies: permission keys set per transaction by `withTx`.
CREATE OR REPLACE FUNCTION public.hmis_has_permission(perm text) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $$
  SELECT coalesce(
    perm = ANY (string_to_array(nullif(current_setting('app.user_permissions', true), ''), ',')),
    false)
$$;
--> statement-breakpoint

-- 5. BEFORE UPDATE: keep updated_at/updated_by current; identity and creation columns are immutable.
CREATE OR REPLACE FUNCTION public.hmis_touch_row() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.facility_id IS DISTINCT FROM OLD.facility_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'hmis: id, facility_id, created_at and created_by are immutable on %.%',
      TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  -- Unless the statement set updated_by explicitly, it is the current actor (NULL = system).
  IF NEW.updated_by IS NOT DISTINCT FROM OLD.updated_by THEN
    NEW.updated_by := public.hmis_current_user_id();
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- 6. AFTER INSERT/UPDATE/DELETE: one audit_log row with full before/after JSON.
--    TG_ARGV[0]: columns to redact (secrets), TG_ARGV[1]: columns whose sole change is not audited.
--    SECURITY DEFINER so the app role needs (and has) no INSERT on audit_log.
CREATE OR REPLACE FUNCTION public.hmis_audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  redact text[] := coalesce(TG_ARGV[0], '{}')::text[];
  ignore_cols text[] := coalesce(TG_ARGV[1], '{}')::text[] || ARRAY['updated_at', 'updated_by'];
  raw_old jsonb;
  raw_new jsonb;
  old_j jsonb;
  new_j jsonb;
  col text;
BEGIN
  IF TG_TABLE_SCHEMA <> 'public' THEN
    RAISE EXCEPTION 'hmis: audit for schema % needs its own audit sink', TG_TABLE_SCHEMA;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN raw_old := to_jsonb(OLD); END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN raw_new := to_jsonb(NEW); END IF;

  IF TG_OP = 'UPDATE' AND (raw_old - ignore_cols) = (raw_new - ignore_cols) THEN
    RETURN NULL;
  END IF;

  old_j := raw_old;
  new_j := raw_new;
  FOREACH col IN ARRAY redact LOOP
    IF old_j IS NOT NULL AND jsonb_typeof(old_j -> col) IS DISTINCT FROM 'null' AND old_j ? col THEN
      old_j := jsonb_set(old_j, ARRAY[col], '"[redacted]"');
    END IF;
    IF new_j IS NOT NULL AND jsonb_typeof(new_j -> col) IS DISTINCT FROM 'null' AND new_j ? col THEN
      new_j := jsonb_set(new_j, ARRAY[col],
        CASE WHEN TG_OP = 'UPDATE' AND (raw_old -> col) IS DISTINCT FROM (raw_new -> col)
          THEN '"[redacted:changed]"'::jsonb ELSE '"[redacted]"'::jsonb END);
    END IF;
  END LOOP;

  INSERT INTO public.audit_log
    (id, facility_id, table_name, row_id, action, changed_by, workstation_id, changed_at, before, after)
  VALUES (
    public.hmis_uuid_v7(),
    (coalesce(raw_new, raw_old) ->> 'facility_id')::uuid,
    TG_TABLE_NAME,
    (coalesce(raw_new, raw_old) ->> 'id')::uuid,
    left(TG_OP, 1),
    public.hmis_current_user_id(),
    public.hmis_current_workstation_id(),
    now(),
    old_j,
    new_j);
  RETURN NULL;
END
$$;
--> statement-breakpoint

-- 7. Helper for this and every future migration: `SELECT hmis_register_business_table('public.x');`
CREATE OR REPLACE FUNCTION public.hmis_register_business_table(
  tbl regclass,
  redact_columns text[] DEFAULT '{}',
  ignore_columns text[] DEFAULT '{}'
) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  schema_name text;
BEGIN
  SELECT n.nspname INTO schema_name
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.oid = tbl;
  IF schema_name <> 'public' THEN
    RAISE EXCEPTION 'hmis: % is outside public; restricted tables need RLS and a restricted audit sink', tbl;
  END IF;
  EXECUTE format(
    'CREATE OR REPLACE TRIGGER hmis_touch BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION public.hmis_touch_row()',
    tbl);
  EXECUTE format(
    'CREATE OR REPLACE TRIGGER hmis_audit AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION public.hmis_audit_row(%L, %L)',
    tbl, redact_columns::text, ignore_columns::text);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.hmis_register_business_table(regclass, text[], text[]) FROM PUBLIC;
--> statement-breakpoint

-- 8. Platform business tables. Not audited by trigger: audit_log/access_log/print_log (logs
--    themselves), idempotency (response cache), integration_event (delivery status churn).
SELECT public.hmis_register_business_table('public.facility');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.app_user',
  ARRAY['password_hash', 'pin_hash', 'totp_secret_enc']);
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.role');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.permission');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.role_permission');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.user_role');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.workstation');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.session', ARRAY['token_hash'], ARRAY['last_seen_at']);
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.setting');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.number_series');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.document');
--> statement-breakpoint

-- Non-audited tables still get the touch trigger where rows are updated.
CREATE OR REPLACE TRIGGER hmis_touch BEFORE UPDATE ON public.idempotency
  FOR EACH ROW EXECUTE FUNCTION public.hmis_touch_row();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER hmis_touch BEFORE UPDATE ON public.integration_event
  FOR EACH ROW EXECUTE FUNCTION public.hmis_touch_row();
--> statement-breakpoint

-- 9. Grants. Default privileges cover tables created by later migrations (same owner role);
--    a test asserts the resulting privilege matrix.
GRANT USAGE ON SCHEMA public TO hmis_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO hmis_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO hmis_app;
--> statement-breakpoint
-- Append-only logs (docs/02 §5): audit_log is written only by the trigger.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.audit_log FROM hmis_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.access_log FROM hmis_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.print_log FROM hmis_app;
--> statement-breakpoint
-- Expired idempotency keys may be purged by the worker; nothing else is ever hard-deleted.
GRANT DELETE ON public.idempotency TO hmis_app;
--> statement-breakpoint

-- 10. Restricted schema (MTP, AGENTS.md rule 8): no access for PUBLIC; tables get RLS policies
--     using hmis_has_permission() (pattern in packages/db/README.md).
REVOKE ALL ON SCHEMA restricted FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA restricted TO hmis_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA restricted GRANT SELECT, INSERT, UPDATE ON TABLES TO hmis_app;
