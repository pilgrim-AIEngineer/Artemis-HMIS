CREATE TABLE "consultation_rule" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"doctor_id" uuid NOT NULL,
	"visit_type" text NOT NULL,
	"service_id" uuid NOT NULL,
	"follow_up_validity_days" integer,
	"free_follow_ups_count" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"cancel_reason" text,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "consultation_rule_visit_type" CHECK ("consultation_rule"."visit_type" in ('new', 'follow_up', 'emergency', 'anc', 'paeds_vaccination')),
	CONSTRAINT "consultation_rule_ranges" CHECK (("consultation_rule"."follow_up_validity_days" is null or "consultation_rule"."follow_up_validity_days" between 0 and 365)
        and ("consultation_rule"."free_follow_ups_count" is null or "consultation_rule"."free_follow_ups_count" between 0 and 20)),
	CONSTRAINT "consultation_rule_status" CHECK ("consultation_rule"."status" in ('active', 'cancelled')),
	CONSTRAINT "consultation_rule_cancel_fields" CHECK (("consultation_rule"."status" = 'cancelled') = ("consultation_rule"."cancelled_at" is not null and "consultation_rule"."cancel_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "department" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_hi" text,
	"code" text NOT NULL,
	"is_clinical" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"search_text" text GENERATED ALWAYS AS (hmis_search_text(name, name_hi, code, null)) STORED,
	"status" text DEFAULT 'active' NOT NULL,
	"cancel_reason" text,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "department_status" CHECK ("department"."status" in ('active', 'cancelled')),
	CONSTRAINT "department_cancel_fields" CHECK (("department"."status" = 'cancelled') = ("department"."cancelled_at" is not null and "department"."cancel_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "doctor_profile" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"user_id" uuid,
	"department_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"display_name_hi" text,
	"qualifications" text,
	"registration_council" text,
	"registration_no" text,
	"signature_file_id" uuid,
	"is_visiting" boolean DEFAULT false NOT NULL,
	"opd_days" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"search_text" text GENERATED ALWAYS AS (hmis_search_text(display_name, display_name_hi, qualifications, registration_no)) STORED,
	"status" text DEFAULT 'active' NOT NULL,
	"cancel_reason" text,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "doctor_profile_opd_days_array" CHECK (jsonb_typeof("doctor_profile"."opd_days") = 'array'),
	CONSTRAINT "doctor_profile_status" CHECK ("doctor_profile"."status" in ('active', 'cancelled')),
	CONSTRAINT "doctor_profile_cancel_fields" CHECK (("doctor_profile"."status" = 'cancelled') = ("doctor_profile"."cancelled_at" is not null and "doctor_profile"."cancel_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "drug" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"brand_name" text NOT NULL,
	"generic_name" text,
	"short_code" text,
	"strength" text,
	"form" text DEFAULT 'tab' NOT NULL,
	"manufacturer" text,
	"hsn_code" text,
	"gst_rate_bp" integer DEFAULT 0 NOT NULL,
	"schedule" text DEFAULT 'none' NOT NULL,
	"is_stocked" boolean DEFAULT true NOT NULL,
	"default_dose_text" text,
	"pack_size" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"search_text" text GENERATED ALWAYS AS (hmis_search_text(brand_name, generic_name, short_code, manufacturer)) STORED,
	"status" text DEFAULT 'active' NOT NULL,
	"cancel_reason" text,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "drug_form" CHECK ("drug"."form" in ('tab', 'cap', 'syp', 'inj', 'drops', 'cream', 'pessary', 'sachet', 'inhaler', 'other')),
	CONSTRAINT "drug_schedule" CHECK ("drug"."schedule" in ('none', 'H', 'H1', 'X', 'G', 'NDPS')),
	CONSTRAINT "drug_gst_bp" CHECK ("drug"."gst_rate_bp" between 0 and 10000),
	CONSTRAINT "drug_status" CHECK ("drug"."status" in ('active', 'cancelled')),
	CONSTRAINT "drug_cancel_fields" CHECK (("drug"."status" = 'cancelled') = ("drug"."cancelled_at" is not null and "drug"."cancel_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "lab_test" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"short_code" text,
	"department" text NOT NULL,
	"sample_type" text,
	"container" text,
	"method" text,
	"unit" text,
	"result_type" text DEFAULT 'numeric' NOT NULL,
	"formula" text,
	"options" jsonb,
	"decimals" integer,
	"tat_hours" integer,
	"is_outsourced" boolean DEFAULT false NOT NULL,
	"outsource_lab" text,
	"service_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"search_text" text GENERATED ALWAYS AS (hmis_search_text(name, code, short_code, null)) STORED,
	"status" text DEFAULT 'active' NOT NULL,
	"cancel_reason" text,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "lab_test_department" CHECK ("lab_test"."department" in ('haematology', 'biochemistry', 'serology', 'microbiology', 'clin_path', 'hormones', 'other')),
	CONSTRAINT "lab_test_result_type" CHECK ("lab_test"."result_type" in ('numeric', 'text', 'option', 'culture', 'formula')),
	CONSTRAINT "lab_test_status" CHECK ("lab_test"."status" in ('active', 'cancelled')),
	CONSTRAINT "lab_test_cancel_fields" CHECK (("lab_test"."status" = 'cancelled') = ("lab_test"."cancelled_at" is not null and "lab_test"."cancel_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "locality" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_hi" text,
	"district" text,
	"pincode" text,
	"learned" boolean DEFAULT false NOT NULL,
	"search_text" text GENERATED ALWAYS AS (hmis_search_text(name, name_hi, pincode, district)) STORED,
	"status" text DEFAULT 'active' NOT NULL,
	"cancel_reason" text,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "locality_pincode" CHECK ("locality"."pincode" is null or "locality"."pincode" ~ '^[1-9][0-9]{5}$'),
	CONSTRAINT "locality_status" CHECK ("locality"."status" in ('active', 'cancelled')),
	CONSTRAINT "locality_cancel_fields" CHECK (("locality"."status" = 'cancelled') = ("locality"."cancelled_at" is not null and "locality"."cancel_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "payer" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"code" text NOT NULL,
	"contact" text,
	"credit_days" integer DEFAULT 0 NOT NULL,
	"requires_preauth" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"search_text" text GENERATED ALWAYS AS (hmis_search_text(name, code, contact, null)) STORED,
	"status" text DEFAULT 'active' NOT NULL,
	"cancel_reason" text,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "payer_type" CHECK ("payer"."type" in ('self', 'pmjay', 'state_scheme', 'tpa', 'insurer', 'corporate', 'cghs', 'echs', 'other')),
	CONSTRAINT "payer_credit_days" CHECK ("payer"."credit_days" between 0 and 365),
	CONSTRAINT "payer_status" CHECK ("payer"."status" in ('active', 'cancelled')),
	CONSTRAINT "payer_cancel_fields" CHECK (("payer"."status" = 'cancelled') = ("payer"."cancelled_at" is not null and "payer"."cancel_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "reason_code" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"label_hi" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"search_text" text GENERATED ALWAYS AS (hmis_search_text(label, label_hi, code, kind)) STORED,
	"status" text DEFAULT 'active' NOT NULL,
	"cancel_reason" text,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "reason_code_kind" CHECK ("reason_code"."kind" in ('discount', 'cancel', 'refund', 'stock_adjust', 'no_show')),
	CONSTRAINT "reason_code_status" CHECK ("reason_code"."status" in ('active', 'cancelled')),
	CONSTRAINT "reason_code_cancel_fields" CHECK (("reason_code"."status" = 'cancelled') = ("reason_code"."cancelled_at" is not null and "reason_code"."cancel_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "service" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"name_hi" text,
	"short_code" text,
	"category" text NOT NULL,
	"department_id" uuid,
	"sac_code" text,
	"default_gst_rate_bp" integer DEFAULT 0 NOT NULL,
	"is_exempt" boolean DEFAULT true NOT NULL,
	"unit" text DEFAULT 'per_visit' NOT NULL,
	"linked_lab_test_id" uuid,
	"linked_usg_procedure_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"search_text" text GENERATED ALWAYS AS (hmis_search_text(name, name_hi, code, short_code)) STORED,
	"status" text DEFAULT 'active' NOT NULL,
	"cancel_reason" text,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "service_category" CHECK ("service"."category" in ('consultation', 'procedure', 'usg', 'lab', 'bed', 'nursing', 'ot', 'doctor_visit', 'equipment', 'misc', 'cardiology', 'icu')),
	CONSTRAINT "service_unit" CHECK ("service"."unit" in ('per_visit', 'per_day', 'per_hour', 'per_unit')),
	CONSTRAINT "service_gst_bp" CHECK ("service"."default_gst_rate_bp" between 0 and 10000),
	CONSTRAINT "service_exempt_no_gst" CHECK (not "service"."is_exempt" or "service"."default_gst_rate_bp" = 0),
	CONSTRAINT "service_status" CHECK ("service"."status" in ('active', 'cancelled')),
	CONSTRAINT "service_cancel_fields" CHECK (("service"."status" = 'cancelled') = ("service"."cancelled_at" is not null and "service"."cancel_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "service_rate" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"tariff_id" uuid NOT NULL,
	"room_category_id" uuid,
	"rate_paise" bigint NOT NULL,
	"effective_from" date NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"cancel_reason" text,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "service_rate_nonnegative" CHECK ("service_rate"."rate_paise" >= 0),
	CONSTRAINT "service_rate_status" CHECK ("service_rate"."status" in ('active', 'cancelled')),
	CONSTRAINT "service_rate_cancel_fields" CHECK (("service_rate"."status" = 'cancelled') = ("service_rate"."cancelled_at" is not null and "service_rate"."cancel_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "tariff" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"name" text NOT NULL,
	"payer_id" uuid,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"search_text" text GENERATED ALWAYS AS (hmis_search_text(name, null, null, null)) STORED,
	"status" text DEFAULT 'active' NOT NULL,
	"cancel_reason" text,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "tariff_dates" CHECK ("tariff"."effective_to" is null or "tariff"."effective_to" >= "tariff"."effective_from"),
	CONSTRAINT "tariff_status" CHECK ("tariff"."status" in ('active', 'cancelled')),
	CONSTRAINT "tariff_cancel_fields" CHECK (("tariff"."status" = 'cancelled') = ("tariff"."cancelled_at" is not null and "tariff"."cancel_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "usg_procedure" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"requires_form_f_if_pregnant" boolean DEFAULT true NOT NULL,
	"default_template_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"search_text" text GENERATED ALWAYS AS (hmis_search_text(name, code, null, null)) STORED,
	"status" text DEFAULT 'active' NOT NULL,
	"cancel_reason" text,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "usg_procedure_category" CHECK ("usg_procedure"."category" in ('obstetric', 'gynae', 'abdomen', 'pelvis', 'follicular', 'doppler', 'other')),
	CONSTRAINT "usg_procedure_status" CHECK ("usg_procedure"."status" in ('active', 'cancelled')),
	CONSTRAINT "usg_procedure_cancel_fields" CHECK (("usg_procedure"."status" = 'cancelled') = ("usg_procedure"."cancelled_at" is not null and "usg_procedure"."cancel_reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "consultation_rule" ADD CONSTRAINT "consultation_rule_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultation_rule" ADD CONSTRAINT "consultation_rule_doctor_id_doctor_profile_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."doctor_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultation_rule" ADD CONSTRAINT "consultation_rule_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department" ADD CONSTRAINT "department_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_profile" ADD CONSTRAINT "doctor_profile_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_profile" ADD CONSTRAINT "doctor_profile_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_profile" ADD CONSTRAINT "doctor_profile_department_id_department_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."department"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_profile" ADD CONSTRAINT "doctor_profile_signature_file_id_document_id_fk" FOREIGN KEY ("signature_file_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drug" ADD CONSTRAINT "drug_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_test" ADD CONSTRAINT "lab_test_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_test" ADD CONSTRAINT "lab_test_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locality" ADD CONSTRAINT "locality_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer" ADD CONSTRAINT "payer_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reason_code" ADD CONSTRAINT "reason_code_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_department_id_department_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."department"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_linked_lab_test_id_lab_test_id_fk" FOREIGN KEY ("linked_lab_test_id") REFERENCES "public"."lab_test"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_linked_usg_procedure_id_usg_procedure_id_fk" FOREIGN KEY ("linked_usg_procedure_id") REFERENCES "public"."usg_procedure"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_rate" ADD CONSTRAINT "service_rate_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_rate" ADD CONSTRAINT "service_rate_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_rate" ADD CONSTRAINT "service_rate_tariff_id_tariff_id_fk" FOREIGN KEY ("tariff_id") REFERENCES "public"."tariff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariff" ADD CONSTRAINT "tariff_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariff" ADD CONSTRAINT "tariff_payer_id_payer_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."payer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usg_procedure" ADD CONSTRAINT "usg_procedure_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "consultation_rule_active_key" ON "consultation_rule" USING btree ("facility_id","doctor_id","visit_type") WHERE "consultation_rule"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "department_code_key" ON "department" USING btree ("facility_id",lower("code"));--> statement-breakpoint
CREATE INDEX "doctor_profile_department_idx" ON "doctor_profile" USING btree ("department_id");--> statement-breakpoint
CREATE UNIQUE INDEX "doctor_profile_user_key" ON "doctor_profile" USING btree ("facility_id","user_id") WHERE "doctor_profile"."user_id" is not null and "doctor_profile"."status" = 'active';--> statement-breakpoint
CREATE INDEX "doctor_profile_search_trgm" ON "doctor_profile" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "drug_identity_key" ON "drug" USING btree ("facility_id",lower("brand_name"),lower(coalesce("strength", '')),"form",lower(coalesce("manufacturer", '')));--> statement-breakpoint
CREATE INDEX "drug_search_trgm" ON "drug" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "lab_test_code_key" ON "lab_test" USING btree ("facility_id",lower("code"));--> statement-breakpoint
CREATE INDEX "lab_test_search_trgm" ON "lab_test" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "locality_search_trgm" ON "locality" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "payer_code_key" ON "payer" USING btree ("facility_id",lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "payer_name_key" ON "payer" USING btree ("facility_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "reason_code_key" ON "reason_code" USING btree ("facility_id","kind","code");--> statement-breakpoint
CREATE UNIQUE INDEX "service_code_key" ON "service" USING btree ("facility_id",lower("code"));--> statement-breakpoint
CREATE INDEX "service_category_idx" ON "service" USING btree ("facility_id","category");--> statement-breakpoint
CREATE INDEX "service_search_trgm" ON "service" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "service_rate_active_key" ON "service_rate" USING btree ("facility_id","service_id","tariff_id",coalesce("room_category_id", '00000000-0000-0000-0000-000000000000'::uuid),"effective_from") WHERE "service_rate"."status" = 'active';--> statement-breakpoint
CREATE INDEX "service_rate_lookup_idx" ON "service_rate" USING btree ("tariff_id","service_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "tariff_name_key" ON "tariff" USING btree ("facility_id",lower("name"));--> statement-breakpoint
CREATE INDEX "tariff_payer_idx" ON "tariff" USING btree ("payer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "usg_procedure_code_key" ON "usg_procedure" USING btree ("facility_id",lower("code"));