-- MSG-01: audit + touch triggers on the new template table (AGENTS.md rule 5). message_outbox
-- already has them (0027); grants come from ALTER DEFAULT PRIVILEGES in 0001.
SELECT public.hmis_register_business_table('public.message_template');
