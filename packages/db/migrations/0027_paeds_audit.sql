-- OPD-06: audit + touch triggers on the new business tables (AGENTS.md rule 5). Grants need no
-- change: ALTER DEFAULT PRIVILEGES from 0001 gives hmis_app SELECT/INSERT/UPDATE and no DELETE.
SELECT public.hmis_register_business_table('public.immunisation_schedule');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.immunisation_profile');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.immunisation_given');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.growth_measurement');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.drug_paeds_rule');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.patient_consent');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.message_outbox');
