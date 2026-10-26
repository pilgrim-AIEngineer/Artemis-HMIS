CREATE TABLE "clinical_note" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"prescription_id" uuid,
	"kind" text DEFAULT 'opd' NOT NULL,
	"complaints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"history" text,
	"examination" jsonb,
	"provisional_diagnosis" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"advice" text,
	"follow_up_date" date,
	"status" text DEFAULT 'final' NOT NULL,
	"superseded_at" timestamp with time zone,
	"entered_by" uuid NOT NULL,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "clinical_note_kind" CHECK ("clinical_note"."kind" in ('opd', 'ipd_progress', 'ipd_admission', 'procedure')),
	CONSTRAINT "clinical_note_status" CHECK ("clinical_note"."status" in ('draft', 'final', 'superseded')),
	CONSTRAINT "clinical_note_complaints_array" CHECK (jsonb_typeof("clinical_note"."complaints") = 'array'),
	CONSTRAINT "clinical_note_diagnosis_array" CHECK (jsonb_typeof("clinical_note"."provisional_diagnosis") = 'array'),
	CONSTRAINT "clinical_note_superseded_fields" CHECK (("clinical_note"."status" = 'superseded') = ("clinical_note"."superseded_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "clinical_order" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"prescription_id" uuid,
	"kind" text NOT NULL,
	"service_id" uuid,
	"lab_test_id" uuid,
	"lab_panel_id" uuid,
	"usg_procedure_id" uuid,
	"priority" text DEFAULT 'routine' NOT NULL,
	"notes" text,
	"expected_date" date,
	"status" text DEFAULT 'ordered' NOT NULL,
	"ordered_by" uuid,
	"entered_by" uuid NOT NULL,
	"bill_line_id" uuid,
	"billed_at" timestamp with time zone,
	"cancel_reason" text,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "clinical_order_kind" CHECK ("clinical_order"."kind" in ('lab', 'usg', 'procedure', 'admission', 'referral', 'cardiology_test')),
	CONSTRAINT "clinical_order_status" CHECK ("clinical_order"."status" in ('ordered', 'billed', 'in_progress', 'completed', 'cancelled')),
	CONSTRAINT "clinical_order_priority" CHECK ("clinical_order"."priority" in ('routine', 'urgent')),
	CONSTRAINT "clinical_order_service_kind" CHECK (("clinical_order"."kind" = 'admission') = ("clinical_order"."service_id" is null)),
	CONSTRAINT "clinical_order_expected_date" CHECK ("clinical_order"."expected_date" is null or "clinical_order"."kind" = 'admission'),
	CONSTRAINT "clinical_order_billed_fields" CHECK ("clinical_order"."status" <> 'billed' or ("clinical_order"."bill_line_id" is not null and "clinical_order"."billed_at" is not null)),
	CONSTRAINT "clinical_order_cancel_fields" CHECK (("clinical_order"."status" = 'cancelled') = ("clinical_order"."cancelled_at" is not null and "clinical_order"."cancel_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "prescription" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"doctor_id" uuid NOT NULL,
	"source" text DEFAULT 'transcribed_from_paper' NOT NULL,
	"status" text DEFAULT 'final' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"supersedes_id" uuid,
	"superseded_at" timestamp with time zone,
	"entered_by" uuid NOT NULL,
	"entered_at" timestamp with time zone NOT NULL,
	"needs_verification" boolean DEFAULT false NOT NULL,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"paper_scan_document_id" uuid,
	"notes" text,
	"rx_template_id" uuid,
	"cancel_reason" text,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "prescription_source" CHECK ("prescription"."source" in ('transcribed_from_paper', 'entered_by_doctor', 'discharge')),
	CONSTRAINT "prescription_status" CHECK ("prescription"."status" in ('draft', 'final', 'verified', 'cancelled', 'superseded')),
	CONSTRAINT "prescription_version_positive" CHECK ("prescription"."version" >= 1),
	CONSTRAINT "prescription_warnings_array" CHECK (jsonb_typeof("prescription"."warnings") = 'array'),
	CONSTRAINT "prescription_superseded_fields" CHECK (("prescription"."status" = 'superseded') = ("prescription"."superseded_at" is not null)),
	CONSTRAINT "prescription_verified_fields" CHECK (("prescription"."verified_at" is null) = ("prescription"."verified_by" is null)
        and ("prescription"."status" <> 'verified' or "prescription"."verified_at" is not null)),
	CONSTRAINT "prescription_cancel_fields" CHECK (("prescription"."status" = 'cancelled') = ("prescription"."cancelled_at" is not null and "prescription"."cancel_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "prescription_item" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"prescription_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"drug_id" uuid,
	"free_text_drug" text,
	"drug_name" text NOT NULL,
	"form" text,
	"dose_text" text,
	"frequency_code" text,
	"pattern" text,
	"timing" text,
	"route" text,
	"duration_value" smallint,
	"duration_unit" text,
	"quantity_calc" numeric(12, 3),
	"instructions_en" text,
	"instructions_hi" text,
	"source_line" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "prescription_item_drug" CHECK ("prescription_item"."drug_id" is not null or "prescription_item"."free_text_drug" is not null),
	CONSTRAINT "prescription_item_form" CHECK ("prescription_item"."form" is null or "prescription_item"."form" in ('tab', 'cap', 'syp', 'inj', 'drops', 'cream', 'pessary', 'sachet', 'inhaler', 'other')),
	CONSTRAINT "prescription_item_frequency" CHECK ("prescription_item"."frequency_code" is null or "prescription_item"."frequency_code" in ('OD', 'BD', 'TDS', 'QID', 'HS', 'SOS', 'STAT', 'WEEKLY', 'ALT')),
	CONSTRAINT "prescription_item_timing" CHECK ("prescription_item"."timing" is null or "prescription_item"."timing" in ('af', 'bf', 'with_food', 'empty_stomach', 'any')),
	CONSTRAINT "prescription_item_route" CHECK ("prescription_item"."route" is null or "prescription_item"."route" in ('oral', 'im', 'iv', 'sc', 'sl', 'pv', 'pr', 'topical', 'inhalation', 'nasal', 'eye', 'ear')),
	CONSTRAINT "prescription_item_duration_unit" CHECK ("prescription_item"."duration_unit" is null or "prescription_item"."duration_unit" in ('d', 'w', 'm')),
	CONSTRAINT "prescription_item_duration_pair" CHECK (("prescription_item"."duration_value" is null) = ("prescription_item"."duration_unit" is null) and ("prescription_item"."duration_value" is null or "prescription_item"."duration_value" > 0)),
	CONSTRAINT "prescription_item_qty_nonnegative" CHECK ("prescription_item"."quantity_calc" is null or "prescription_item"."quantity_calc" >= 0)
);
--> statement-breakpoint
CREATE TABLE "rx_draft" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"saved_at" timestamp with time zone NOT NULL,
	"saved_by" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "rx_draft_status" CHECK ("rx_draft"."status" in ('open', 'used', 'discarded')),
	CONSTRAINT "rx_draft_payload_object" CHECK (jsonb_typeof("rx_draft"."payload") = 'object')
);
--> statement-breakpoint
ALTER TABLE "bill_line" ADD COLUMN "clinical_order_id" uuid;--> statement-breakpoint
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_prescription_id_prescription_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescription"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_entered_by_app_user_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_verified_by_app_user_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_prescription_id_prescription_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescription"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_lab_test_id_lab_test_id_fk" FOREIGN KEY ("lab_test_id") REFERENCES "public"."lab_test"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_usg_procedure_id_usg_procedure_id_fk" FOREIGN KEY ("usg_procedure_id") REFERENCES "public"."usg_procedure"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_ordered_by_doctor_profile_id_fk" FOREIGN KEY ("ordered_by") REFERENCES "public"."doctor_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_entered_by_app_user_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_bill_line_id_bill_line_id_fk" FOREIGN KEY ("bill_line_id") REFERENCES "public"."bill_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_cancelled_by_app_user_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_doctor_id_doctor_profile_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."doctor_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_supersedes_id_prescription_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."prescription"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_entered_by_app_user_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_verified_by_app_user_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_paper_scan_document_id_document_id_fk" FOREIGN KEY ("paper_scan_document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_cancelled_by_app_user_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_item" ADD CONSTRAINT "prescription_item_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_item" ADD CONSTRAINT "prescription_item_prescription_id_prescription_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescription"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_item" ADD CONSTRAINT "prescription_item_drug_id_drug_id_fk" FOREIGN KEY ("drug_id") REFERENCES "public"."drug"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rx_draft" ADD CONSTRAINT "rx_draft_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rx_draft" ADD CONSTRAINT "rx_draft_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rx_draft" ADD CONSTRAINT "rx_draft_saved_by_app_user_id_fk" FOREIGN KEY ("saved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clinical_note_current_key" ON "clinical_note" USING btree ("encounter_id","kind") WHERE "clinical_note"."status" = 'final';--> statement-breakpoint
CREATE INDEX "clinical_note_follow_up_idx" ON "clinical_note" USING btree ("facility_id","follow_up_date") WHERE "clinical_note"."status" = 'final' and "clinical_note"."follow_up_date" is not null;--> statement-breakpoint
CREATE INDEX "clinical_order_encounter_idx" ON "clinical_order" USING btree ("encounter_id","status");--> statement-breakpoint
CREATE INDEX "clinical_order_status_idx" ON "clinical_order" USING btree ("facility_id","kind","status");--> statement-breakpoint
CREATE UNIQUE INDEX "clinical_order_service_key" ON "clinical_order" USING btree ("encounter_id","service_id") WHERE "clinical_order"."status" <> 'cancelled' and "clinical_order"."service_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "clinical_order_admission_key" ON "clinical_order" USING btree ("encounter_id") WHERE "clinical_order"."status" <> 'cancelled' and "clinical_order"."kind" = 'admission';--> statement-breakpoint
CREATE UNIQUE INDEX "prescription_current_key" ON "prescription" USING btree ("encounter_id") WHERE "prescription"."status" in ('final', 'verified');--> statement-breakpoint
CREATE INDEX "prescription_patient_idx" ON "prescription" USING btree ("patient_id","entered_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "prescription_doctor_idx" ON "prescription" USING btree ("doctor_id","entered_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "prescription_verify_idx" ON "prescription" USING btree ("facility_id","entered_at") WHERE "prescription"."status" = 'final' and "prescription"."needs_verification";--> statement-breakpoint
CREATE UNIQUE INDEX "prescription_item_seq_key" ON "prescription_item" USING btree ("prescription_id","seq");--> statement-breakpoint
CREATE INDEX "prescription_item_drug_idx" ON "prescription_item" USING btree ("drug_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rx_draft_encounter_key" ON "rx_draft" USING btree ("encounter_id");--> statement-breakpoint
ALTER TABLE "bill_line" ADD CONSTRAINT "bill_line_clinical_order_id_clinical_order_id_fk" FOREIGN KEY ("clinical_order_id") REFERENCES "public"."clinical_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bill_line_order_key" ON "bill_line" USING btree ("clinical_order_id") WHERE "bill_line"."status" = 'active' and "bill_line"."clinical_order_id" is not null;