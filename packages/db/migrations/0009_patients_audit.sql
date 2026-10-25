-- REG-01: audit + touch triggers on the patient master (AGENTS.md rule 5). Grants need no change:
-- ALTER DEFAULT PRIVILEGES from 0001 gives hmis_app SELECT/INSERT/UPDATE and no DELETE.
SELECT public.hmis_register_business_table('public.patient');
