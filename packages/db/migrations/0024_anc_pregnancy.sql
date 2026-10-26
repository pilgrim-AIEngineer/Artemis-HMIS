CREATE TABLE "anc_schedule_item" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"label_hi" text NOT NULL,
	"kind" text NOT NULL,
	"ga_from_days" smallint DEFAULT 0 NOT NULL,
	"ga_to_days" smallint,
	"at_booking" boolean DEFAULT false NOT NULL,
	"rh_negative_only" boolean DEFAULT false NOT NULL,
	"after_code" text,
	"after_days" smallint DEFAULT 0 NOT NULL,
	"service_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "anc_schedule_item_kind" CHECK ("anc_schedule_item"."kind" in ('visit', 'test', 'scan', 'vaccine', 'supplement')),
	CONSTRAINT "anc_schedule_item_window" CHECK ("anc_schedule_item"."ga_from_days" >= 0 and ("anc_schedule_item"."ga_to_days" is null or "anc_schedule_item"."ga_to_days" >= "anc_schedule_item"."ga_from_days"))
);
--> statement-breakpoint
CREATE TABLE "anc_schedule_status" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"pregnancy_id" uuid NOT NULL,
	"schedule_item_id" uuid NOT NULL,
	"status" text NOT NULL,
	"done_date" date,
	"encounter_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "anc_schedule_status_status" CHECK ("anc_schedule_status"."status" in ('due', 'done', 'skipped')),
	CONSTRAINT "anc_schedule_status_done_date" CHECK (("anc_schedule_status"."status" = 'done') = ("anc_schedule_status"."done_date" is not null))
);
--> statement-breakpoint
CREATE TABLE "anc_visit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"pregnancy_id" uuid NOT NULL,
	"encounter_id" uuid,
	"visit_date" date NOT NULL,
	"ga_days" smallint NOT NULL,
	"weight_kg" numeric(5, 2),
	"bp_sys" smallint,
	"bp_dia" smallint,
	"fundal_height_cm" numeric(3, 1),
	"fhr" smallint,
	"presentation" text,
	"oedema" text,
	"urine_protein" text,
	"urine_sugar" text,
	"hb" numeric(3, 1),
	"remarks" text,
	"status" text DEFAULT 'active' NOT NULL,
	"cancel_reason" text,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "anc_visit_presentation" CHECK ("anc_visit"."presentation" is null or "anc_visit"."presentation" in ('cephalic', 'breech', 'transverse', 'oblique', 'not_assessed')),
	CONSTRAINT "anc_visit_oedema" CHECK ("anc_visit"."oedema" is null or "anc_visit"."oedema" in ('none', 'plus1', 'plus2')),
	CONSTRAINT "anc_visit_urine_protein" CHECK ("anc_visit"."urine_protein" is null or "anc_visit"."urine_protein" in ('nil', 'trace', 'plus1', 'plus2', 'plus3', 'plus4')),
	CONSTRAINT "anc_visit_urine_sugar" CHECK ("anc_visit"."urine_sugar" is null or "anc_visit"."urine_sugar" in ('nil', 'trace', 'plus1', 'plus2', 'plus3', 'plus4')),
	CONSTRAINT "anc_visit_bp_pair" CHECK (("anc_visit"."bp_sys" is null) = ("anc_visit"."bp_dia" is null) and ("anc_visit"."bp_dia" is null or "anc_visit"."bp_dia" < "anc_visit"."bp_sys")),
	CONSTRAINT "anc_visit_status" CHECK ("anc_visit"."status" in ('active', 'cancelled')),
	CONSTRAINT "anc_visit_cancel_fields" CHECK (("anc_visit"."status" = 'cancelled') = ("anc_visit"."cancelled_at" is not null and "anc_visit"."cancel_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "obstetric_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"pregnancy_no" smallint NOT NULL,
	"year" smallint,
	"outcome" text NOT NULL,
	"gestation_weeks" smallint,
	"place" text,
	"complications" text,
	"babies_alive" smallint DEFAULT 0 NOT NULL,
	"neonatal_death" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"cancel_reason" text,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "obstetric_history_outcome" CHECK ("obstetric_history"."outcome" in ('nvd', 'lscs', 'assisted', 'abortion', 'ectopic', 'stillbirth')),
	CONSTRAINT "obstetric_history_babies" CHECK ("obstetric_history"."babies_alive" between 0 and 4),
	CONSTRAINT "obstetric_history_status" CHECK ("obstetric_history"."status" in ('active', 'cancelled')),
	CONSTRAINT "obstetric_history_cancel_fields" CHECK (("obstetric_history"."status" = 'cancelled') = ("obstetric_history"."cancelled_at" is not null and "obstetric_history"."cancel_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "patient_alert" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"details" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pregnancy_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "patient_alert_kind" CHECK ("patient_alert"."kind" in ('high_risk_pregnancy', 'allergy', 'vip', 'mlc', 'other')),
	CONSTRAINT "patient_alert_resolved" CHECK ("patient_alert"."active" = ("patient_alert"."resolved_at" is null))
);
--> statement-breakpoint
CREATE TABLE "pregnancy" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"lmp" date,
	"edd_by_lmp" date,
	"edd_by_scan" date,
	"edd_final" date NOT NULL,
	"dating_basis" text NOT NULL,
	"scan_date" date,
	"scan_ga_days" smallint,
	"redating_decision" text,
	"booking_date" date NOT NULL,
	"gravida" smallint DEFAULT 1 NOT NULL,
	"para" smallint DEFAULT 0 NOT NULL,
	"abortions" smallint DEFAULT 0 NOT NULL,
	"living" smallint DEFAULT 0 NOT NULL,
	"gpal_manual" boolean DEFAULT false NOT NULL,
	"plurality" text DEFAULT 'single' NOT NULL,
	"blood_group_rh" text,
	"manual_risks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"outcome_date" date,
	"outcome_encounter_id" uuid,
	"close_reason" text,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "pregnancy_status" CHECK ("pregnancy"."status" in ('active', 'delivered', 'aborted', 'mtp', 'ectopic', 'lost_to_follow_up', 'transferred')),
	CONSTRAINT "pregnancy_dating_basis" CHECK ("pregnancy"."dating_basis" in ('lmp', 'scan')),
	CONSTRAINT "pregnancy_plurality" CHECK ("pregnancy"."plurality" in ('single', 'twins', 'higher')),
	CONSTRAINT "pregnancy_blood_group" CHECK ("pregnancy"."blood_group_rh" is null or "pregnancy"."blood_group_rh" in ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')),
	CONSTRAINT "pregnancy_redating_decision" CHECK ("pregnancy"."redating_decision" is null or "pregnancy"."redating_decision" in ('kept_lmp', 'switched_to_scan')),
	CONSTRAINT "pregnancy_manual_risks_array" CHECK (jsonb_typeof("pregnancy"."manual_risks") = 'array'),
	CONSTRAINT "pregnancy_lmp_edd" CHECK (("pregnancy"."lmp" is null) = ("pregnancy"."edd_by_lmp" is null) and ("pregnancy"."lmp" is null or "pregnancy"."edd_by_lmp" = "pregnancy"."lmp" + 280)),
	CONSTRAINT "pregnancy_scan_fields" CHECK (("pregnancy"."scan_date" is null) = ("pregnancy"."scan_ga_days" is null) and ("pregnancy"."scan_date" is null) = ("pregnancy"."edd_by_scan" is null)),
	CONSTRAINT "pregnancy_dating_source" CHECK (("pregnancy"."dating_basis" = 'lmp' and "pregnancy"."lmp" is not null and "pregnancy"."edd_final" = "pregnancy"."edd_by_lmp")
        or ("pregnancy"."dating_basis" = 'scan' and "pregnancy"."edd_by_scan" is not null and "pregnancy"."edd_final" = "pregnancy"."edd_by_scan")),
	CONSTRAINT "pregnancy_closed_fields" CHECK (("pregnancy"."status" = 'active') = ("pregnancy"."outcome_date" is null and "pregnancy"."closed_at" is null)),
	CONSTRAINT "pregnancy_gpal" CHECK ("pregnancy"."gravida" >= 1 and "pregnancy"."para" >= 0 and "pregnancy"."abortions" >= 0 and "pregnancy"."living" >= 0)
);
--> statement-breakpoint
ALTER TABLE "encounter" ADD COLUMN "pregnancy_id" uuid;--> statement-breakpoint
ALTER TABLE "anc_schedule_item" ADD CONSTRAINT "anc_schedule_item_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anc_schedule_status" ADD CONSTRAINT "anc_schedule_status_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anc_schedule_status" ADD CONSTRAINT "anc_schedule_status_pregnancy_id_pregnancy_id_fk" FOREIGN KEY ("pregnancy_id") REFERENCES "public"."pregnancy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anc_schedule_status" ADD CONSTRAINT "anc_schedule_status_schedule_item_id_anc_schedule_item_id_fk" FOREIGN KEY ("schedule_item_id") REFERENCES "public"."anc_schedule_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anc_schedule_status" ADD CONSTRAINT "anc_schedule_status_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anc_visit" ADD CONSTRAINT "anc_visit_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anc_visit" ADD CONSTRAINT "anc_visit_pregnancy_id_pregnancy_id_fk" FOREIGN KEY ("pregnancy_id") REFERENCES "public"."pregnancy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anc_visit" ADD CONSTRAINT "anc_visit_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obstetric_history" ADD CONSTRAINT "obstetric_history_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obstetric_history" ADD CONSTRAINT "obstetric_history_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_alert" ADD CONSTRAINT "patient_alert_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_alert" ADD CONSTRAINT "patient_alert_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_alert" ADD CONSTRAINT "patient_alert_pregnancy_id_pregnancy_id_fk" FOREIGN KEY ("pregnancy_id") REFERENCES "public"."pregnancy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pregnancy" ADD CONSTRAINT "pregnancy_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pregnancy" ADD CONSTRAINT "pregnancy_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pregnancy" ADD CONSTRAINT "pregnancy_outcome_encounter_id_encounter_id_fk" FOREIGN KEY ("outcome_encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pregnancy" ADD CONSTRAINT "pregnancy_closed_by_app_user_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "anc_schedule_item_code_key" ON "anc_schedule_item" USING btree ("facility_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "anc_schedule_status_key" ON "anc_schedule_status" USING btree ("pregnancy_id","schedule_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "anc_visit_pregnancy_date_key" ON "anc_visit" USING btree ("pregnancy_id","visit_date") WHERE "anc_visit"."status" = 'active';--> statement-breakpoint
CREATE INDEX "anc_visit_encounter_idx" ON "anc_visit" USING btree ("encounter_id");--> statement-breakpoint
CREATE INDEX "obstetric_history_patient_idx" ON "obstetric_history" USING btree ("patient_id","pregnancy_no");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_alert_pregnancy_key" ON "patient_alert" USING btree ("pregnancy_id") WHERE "patient_alert"."active" and "patient_alert"."kind" = 'high_risk_pregnancy';--> statement-breakpoint
CREATE INDEX "patient_alert_patient_idx" ON "patient_alert" USING btree ("patient_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "pregnancy_one_active_key" ON "pregnancy" USING btree ("patient_id") WHERE "pregnancy"."status" = 'active';--> statement-breakpoint
CREATE INDEX "pregnancy_patient_idx" ON "pregnancy" USING btree ("patient_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "pregnancy_status_edd_idx" ON "pregnancy" USING btree ("facility_id","status","edd_final");--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_pregnancy_id_pregnancy_id_fk" FOREIGN KEY ("pregnancy_id") REFERENCES "public"."pregnancy"("id") ON DELETE no action ON UPDATE no action;