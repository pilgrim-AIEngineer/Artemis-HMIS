-- FND-02: the workstation pairing secret hash joins the redacted columns (same trigger, new
-- argument list; CREATE OR REPLACE TRIGGER inside the helper keeps this additive).
SELECT public.hmis_register_business_table('public.workstation', ARRAY['pairing_token_hash']);
