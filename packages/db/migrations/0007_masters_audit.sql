-- FND-07: audit + touch triggers on the master tables (AGENTS.md rule 5). Grants need no change:
-- ALTER DEFAULT PRIVILEGES from 0001 gives hmis_app SELECT/INSERT/UPDATE and no DELETE.
SELECT public.hmis_register_business_table('public.department');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.doctor_profile');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.payer');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.tariff');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.usg_procedure');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.lab_test');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.service');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.service_rate');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.consultation_rule');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.drug');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.locality');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.reason_code');
