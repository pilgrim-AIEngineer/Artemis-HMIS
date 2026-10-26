-- OPD-02..04: audit + touch triggers on the new business tables (AGENTS.md rule 5). Grants need
-- no change: ALTER DEFAULT PRIVILEGES from 0001 gives hmis_app SELECT/INSERT/UPDATE and no DELETE.
SELECT public.hmis_register_business_table('public.prescription');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.prescription_item');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.clinical_order');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.clinical_note');
--> statement-breakpoint
-- The draft is overwritten by every 20-second autosave; those writes would copy the whole payload
-- into audit_log twice a minute per open screen. Creation and status changes (used / discarded)
-- are audited; a write that changes only the autosaved content is not. The saved Rx is audited
-- in full above.
SELECT public.hmis_register_business_table('public.rx_draft', '{}',
  ARRAY['payload', 'saved_at', 'saved_by']);
