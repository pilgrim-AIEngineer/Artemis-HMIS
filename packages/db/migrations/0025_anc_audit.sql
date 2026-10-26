-- OPD-05: audit + touch triggers on the new business tables (AGENTS.md rule 5). Grants need no
-- change: ALTER DEFAULT PRIVILEGES from 0001 gives hmis_app SELECT/INSERT/UPDATE and no DELETE.
SELECT public.hmis_register_business_table('public.pregnancy');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.obstetric_history');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.anc_visit');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.anc_schedule_item');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.anc_schedule_status');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.patient_alert');
