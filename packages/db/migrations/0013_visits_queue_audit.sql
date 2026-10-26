-- REG-03 / REG-04: audit + touch triggers (AGENTS.md rule 5) and the queue change notification.
-- Grants need no change: ALTER DEFAULT PRIVILEGES from 0001 gives hmis_app SELECT/INSERT/UPDATE
-- and no DELETE on the new tables.
SELECT public.hmis_register_business_table('public.encounter');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.opd_token');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.queue_event');
--> statement-breakpoint
-- Real-time updates (docs/01 §2): any write to a token notifies channel `hmis_events` on commit.
-- The payload carries ids only (facility, doctor), never patient data; the web app fans it out
-- over SSE and clients re-read through permission-checked procedures. Identical notifications in
-- one transaction are delivered once by Postgres.
CREATE FUNCTION public.hmis_notify_queue() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify(
    'hmis_events',
    json_build_object('f', NEW.facility_id, 't', 'queue', 'd', NEW.doctor_id)::text
  );
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER opd_token_notify AFTER INSERT OR UPDATE ON public.opd_token
FOR EACH ROW EXECUTE FUNCTION public.hmis_notify_queue();
