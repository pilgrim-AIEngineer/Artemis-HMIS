CREATE TABLE "drug_paeds_rule" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"generic_name" text NOT NULL,
	"mg_per_kg_min" numeric(8, 3) NOT NULL,
	"mg_per_kg_max" numeric(8, 3) NOT NULL,
	"max_mg_per_dose" numeric(10, 2),
	"max_doses_per_day" smallint,
	"concentration_mg_per_ml" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"note" text,
	"approved_by" text,
	"approved_on" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"cancel_reason" text,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "drug_paeds_rule_range" CHECK ("drug_paeds_rule"."mg_per_kg_min" > 0 and "drug_paeds_rule"."mg_per_kg_max" >= "drug_paeds_rule"."mg_per_kg_min"),
	CONSTRAINT "drug_paeds_rule_lower" CHECK ("drug_paeds_rule"."generic_name" = lower(btrim("drug_paeds_rule"."generic_name")) and "drug_paeds_rule"."generic_name" <> ''),
	CONSTRAINT "drug_paeds_rule_status" CHECK ("drug_paeds_rule"."status" in ('active', 'cancelled')),
	CONSTRAINT "drug_paeds_rule_cancel_fields" CHECK (("drug_paeds_rule"."status" = 'cancelled') = ("drug_paeds_rule"."cancelled_at" is not null and "drug_paeds_rule"."cancel_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "growth_measurement" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid,
	"measured_on" date NOT NULL,
	"age_days" integer NOT NULL,
	"weight_kg" numeric(6, 2),
	"length_height_cm" numeric(5, 1),
	"head_circ_cm" numeric(4, 1),
	"z_scores" jsonb NOT NULL,
	"source" text DEFAULT 'paeds' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"cancel_reason" text,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "growth_measurement_source" CHECK ("growth_measurement"."source" in ('vitals', 'paeds')),
	CONSTRAINT "growth_measurement_any" CHECK ("growth_measurement"."weight_kg" is not null or "growth_measurement"."length_height_cm" is not null or "growth_measurement"."head_circ_cm" is not null),
	CONSTRAINT "growth_measurement_status" CHECK ("growth_measurement"."status" in ('active', 'cancelled')),
	CONSTRAINT "growth_measurement_cancel_fields" CHECK (("growth_measurement"."status" = 'cancelled') = ("growth_measurement"."cancelled_at" is not null and "growth_measurement"."cancel_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "immunisation_given" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"item_code" text,
	"schedule_item_id" uuid,
	"schedule_name" text NOT NULL,
	"vaccine_name" text NOT NULL,
	"brand" text,
	"batch_no" text NOT NULL,
	"expiry" date NOT NULL,
	"site" text NOT NULL,
	"route" text NOT NULL,
	"given_on" date NOT NULL,
	"given_by" uuid NOT NULL,
	"encounter_id" uuid,
	"next_due_date" date,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"cancel_reason" text,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "immunisation_given_schedule" CHECK ("immunisation_given"."schedule_name" in ('IAP', 'UIP')),
	CONSTRAINT "immunisation_given_site" CHECK ("immunisation_given"."site" in ('left_thigh', 'right_thigh', 'left_arm', 'right_arm', 'oral', 'intradermal_left_arm', 'other')),
	CONSTRAINT "immunisation_given_route" CHECK ("immunisation_given"."route" in ('im', 'sc', 'id', 'oral')),
	CONSTRAINT "immunisation_given_batch" CHECK (btrim("immunisation_given"."batch_no") <> ''),
	CONSTRAINT "immunisation_given_expiry" CHECK ("immunisation_given"."expiry" >= "immunisation_given"."given_on"),
	CONSTRAINT "immunisation_given_status" CHECK ("immunisation_given"."status" in ('active', 'cancelled')),
	CONSTRAINT "immunisation_given_cancel_fields" CHECK (("immunisation_given"."status" = 'cancelled') = ("immunisation_given"."cancelled_at" is not null and "immunisation_given"."cancel_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "immunisation_profile" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"schedule_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "immunisation_profile_name" CHECK ("immunisation_profile"."schedule_name" in ('IAP', 'UIP'))
);
--> statement-breakpoint
CREATE TABLE "immunisation_schedule" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"schedule_name" text NOT NULL,
	"vaccine_code" text NOT NULL,
	"dose_no" smallint NOT NULL,
	"label" text NOT NULL,
	"label_hi" text NOT NULL,
	"due_age_days" integer NOT NULL,
	"min_age_days" integer NOT NULL,
	"max_age_days" integer,
	"min_interval_days" integer,
	"is_optional" boolean DEFAULT false NOT NULL,
	"only_sex" text,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "immunisation_schedule_name" CHECK ("immunisation_schedule"."schedule_name" in ('IAP', 'UIP')),
	CONSTRAINT "immunisation_schedule_dose_no" CHECK ("immunisation_schedule"."dose_no" >= 1),
	CONSTRAINT "immunisation_schedule_ages" CHECK ("immunisation_schedule"."min_age_days" >= 0 and "immunisation_schedule"."due_age_days" >= "immunisation_schedule"."min_age_days" and ("immunisation_schedule"."max_age_days" is null or "immunisation_schedule"."max_age_days" >= "immunisation_schedule"."due_age_days")),
	CONSTRAINT "immunisation_schedule_interval" CHECK ("immunisation_schedule"."min_interval_days" is null or "immunisation_schedule"."min_interval_days" >= 0),
	CONSTRAINT "immunisation_schedule_sex" CHECK ("immunisation_schedule"."only_sex" is null or "immunisation_schedule"."only_sex" in ('F', 'M'))
);
--> statement-breakpoint
CREATE TABLE "message_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"channel" text DEFAULT 'whatsapp' NOT NULL,
	"template_kind" text NOT NULL,
	"to_mobile" text NOT NULL,
	"language" text DEFAULT 'hi' NOT NULL,
	"variables" jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"last_error" text,
	"provider_message_id" text,
	"send_after" timestamp with time zone NOT NULL,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "message_outbox_channel" CHECK ("message_outbox"."channel" in ('whatsapp', 'sms')),
	CONSTRAINT "message_outbox_status" CHECK ("message_outbox"."status" in ('queued', 'sent', 'delivered', 'read', 'failed', 'opted_out', 'cancelled')),
	CONSTRAINT "message_outbox_language" CHECK ("message_outbox"."language" in ('en', 'hi'))
);
--> statement-breakpoint
CREATE TABLE "patient_consent" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"granted" boolean NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"captured_by" uuid,
	"method" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "patient_consent_kind" CHECK ("patient_consent"."kind" in ('whatsapp', 'data_processing', 'abdm_share')),
	CONSTRAINT "patient_consent_method" CHECK ("patient_consent"."method" in ('verbal_recorded', 'signed', 'otp'))
);
--> statement-breakpoint
ALTER TABLE "drug_paeds_rule" ADD CONSTRAINT "drug_paeds_rule_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_measurement" ADD CONSTRAINT "growth_measurement_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_measurement" ADD CONSTRAINT "growth_measurement_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_measurement" ADD CONSTRAINT "growth_measurement_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "immunisation_given" ADD CONSTRAINT "immunisation_given_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "immunisation_given" ADD CONSTRAINT "immunisation_given_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "immunisation_given" ADD CONSTRAINT "immunisation_given_schedule_item_id_immunisation_schedule_id_fk" FOREIGN KEY ("schedule_item_id") REFERENCES "public"."immunisation_schedule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "immunisation_given" ADD CONSTRAINT "immunisation_given_given_by_app_user_id_fk" FOREIGN KEY ("given_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "immunisation_given" ADD CONSTRAINT "immunisation_given_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "immunisation_profile" ADD CONSTRAINT "immunisation_profile_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "immunisation_profile" ADD CONSTRAINT "immunisation_profile_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "immunisation_schedule" ADD CONSTRAINT "immunisation_schedule_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_outbox" ADD CONSTRAINT "message_outbox_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_outbox" ADD CONSTRAINT "message_outbox_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_consent" ADD CONSTRAINT "patient_consent_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_consent" ADD CONSTRAINT "patient_consent_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_consent" ADD CONSTRAINT "patient_consent_captured_by_app_user_id_fk" FOREIGN KEY ("captured_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "drug_paeds_rule_generic_key" ON "drug_paeds_rule" USING btree ("facility_id","generic_name") WHERE "drug_paeds_rule"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "growth_measurement_day_key" ON "growth_measurement" USING btree ("patient_id","measured_on") WHERE "growth_measurement"."status" = 'active';--> statement-breakpoint
CREATE INDEX "growth_measurement_patient_idx" ON "growth_measurement" USING btree ("patient_id","measured_on" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "immunisation_given_dose_key" ON "immunisation_given" USING btree ("patient_id","item_code") WHERE "immunisation_given"."status" = 'active' and "immunisation_given"."item_code" is not null;--> statement-breakpoint
CREATE INDEX "immunisation_given_patient_idx" ON "immunisation_given" USING btree ("patient_id","given_on" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "immunisation_given_batch_idx" ON "immunisation_given" USING btree ("facility_id","batch_no");--> statement-breakpoint
CREATE UNIQUE INDEX "immunisation_profile_patient_key" ON "immunisation_profile" USING btree ("patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "immunisation_schedule_key" ON "immunisation_schedule" USING btree ("facility_id","schedule_name","vaccine_code","dose_no");--> statement-breakpoint
CREATE UNIQUE INDEX "message_outbox_dedupe_key" ON "message_outbox" USING btree ("facility_id","dedupe_key") WHERE "message_outbox"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "message_outbox_due_idx" ON "message_outbox" USING btree ("status","send_after");--> statement-breakpoint
CREATE INDEX "message_outbox_patient_idx" ON "message_outbox" USING btree ("patient_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "patient_consent_patient_idx" ON "patient_consent" USING btree ("patient_id","kind","at" DESC NULLS LAST);