-- MIG-01: audit + touch triggers on the new business tables (AGENTS.md rule 5). `import_row` is
-- staging rebuilt from the uploaded file (it would copy patient data into audit_log a second
-- time), so it is listed as not audited; the rows an import creates are audited through their own
-- tables and `import_batch` records who ran which file.
SELECT public.hmis_register_business_table('public.patient_identifier');--> statement-breakpoint
SELECT public.hmis_register_business_table('public.import_batch');
