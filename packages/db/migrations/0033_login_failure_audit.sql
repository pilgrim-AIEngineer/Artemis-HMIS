-- #96 / D-17: audit + touch triggers on login_failure (AGENTS.md rule 5). Holds user id, source IP
-- and kind only, never the credential that was tried.
SELECT public.hmis_register_business_table('public.login_failure');
