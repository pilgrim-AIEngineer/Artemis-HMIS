CREATE TABLE "encounter" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"type" text DEFAULT 'opd' NOT NULL,
	"number" text NOT NULL,
	"doctor_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"payer_id" uuid NOT NULL,
	"tariff_id" uuid NOT NULL,
	"visit_type" text NOT NULL,
	"chief_complaint_short" text,
	"priority" text DEFAULT 'normal' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"visit_date" date NOT NULL,
	"ended_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"cancel_reason" text,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"is_restricted" boolean DEFAULT false NOT NULL,
	"referral_source" text,
	"is_downtime_entry" boolean DEFAULT false NOT NULL,
	"consultation_service_id" uuid,
	"consultation_fee_paise" bigint DEFAULT 0 NOT NULL,
	"fee_basis" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "encounter_type" CHECK ("encounter"."type" in ('opd', 'ipd', 'daycare', 'emergency')),
	CONSTRAINT "encounter_status" CHECK ("encounter"."status" in ('open', 'closed', 'cancelled')),
	CONSTRAINT "encounter_priority" CHECK ("encounter"."priority" in ('normal', 'emergency', 'labour', 'elderly', 'staff', 'vip')),
	CONSTRAINT "encounter_visit_type" CHECK ("encounter"."visit_type" in ('new', 'follow_up', 'emergency', 'anc', 'paeds_vaccination')),
	CONSTRAINT "encounter_fee_basis" CHECK ("encounter"."fee_basis" in ('tariff', 'free_follow_up', 'no_rule', 'no_rate')),
	CONSTRAINT "encounter_fee_range" CHECK ("encounter"."consultation_fee_paise" >= 0 and "encounter"."consultation_fee_paise" <= 1000000000000),
	CONSTRAINT "encounter_cancel_fields" CHECK (("encounter"."status" = 'cancelled') = ("encounter"."cancelled_at" is not null and "encounter"."cancel_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "opd_token" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"doctor_id" uuid NOT NULL,
	"token_date" date NOT NULL,
	"token_no" integer NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"queue_state" text DEFAULT 'waiting' NOT NULL,
	"queue_order" integer NOT NULL,
	"issued_basis" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"vitals_at" timestamp with time zone,
	"called_at" timestamp with time zone,
	"seen_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"recall_count" integer DEFAULT 0 NOT NULL,
	"state_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "opd_token_priority" CHECK ("opd_token"."priority" in ('normal', 'emergency', 'labour', 'elderly', 'staff', 'vip')),
	CONSTRAINT "opd_token_state" CHECK ("opd_token"."queue_state" in ('waiting', 'vitals_done', 'with_doctor', 'seen', 'rx_entered', 'billed_orders', 'done', 'no_show', 'cancelled')),
	CONSTRAINT "opd_token_issued_basis" CHECK ("opd_token"."issued_basis" in ('free', 'before_payment_setting', 'payment', 'manual_fee_pending')),
	CONSTRAINT "opd_token_no_positive" CHECK ("opd_token"."token_no" >= 1),
	CONSTRAINT "opd_token_state_reason" CHECK ("opd_token"."queue_state" not in ('no_show', 'cancelled') or "opd_token"."state_reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "queue_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"token_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"by_user" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "queue_event_from" CHECK ("queue_event"."from_state" is null or "queue_event"."from_state" in ('waiting', 'vitals_done', 'with_doctor', 'seen', 'rx_entered', 'billed_orders', 'done', 'no_show', 'cancelled')),
	CONSTRAINT "queue_event_to" CHECK ("queue_event"."to_state" in ('waiting', 'vitals_done', 'with_doctor', 'seen', 'rx_entered', 'billed_orders', 'done', 'no_show', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_doctor_id_doctor_profile_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."doctor_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_department_id_department_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."department"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_payer_id_payer_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."payer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_tariff_id_tariff_id_fk" FOREIGN KEY ("tariff_id") REFERENCES "public"."tariff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_cancelled_by_app_user_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_consultation_service_id_service_id_fk" FOREIGN KEY ("consultation_service_id") REFERENCES "public"."service"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opd_token" ADD CONSTRAINT "opd_token_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opd_token" ADD CONSTRAINT "opd_token_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opd_token" ADD CONSTRAINT "opd_token_doctor_id_doctor_profile_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."doctor_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_event" ADD CONSTRAINT "queue_event_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_event" ADD CONSTRAINT "queue_event_token_id_opd_token_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."opd_token"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_event" ADD CONSTRAINT "queue_event_by_user_app_user_id_fk" FOREIGN KEY ("by_user") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "encounter_number_key" ON "encounter" USING btree ("facility_id","number");--> statement-breakpoint
CREATE INDEX "encounter_patient_idx" ON "encounter" USING btree ("patient_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "encounter_doctor_idx" ON "encounter" USING btree ("doctor_id","started_at");--> statement-breakpoint
CREATE INDEX "encounter_follow_up_idx" ON "encounter" USING btree ("patient_id","doctor_id","visit_date");--> statement-breakpoint
CREATE UNIQUE INDEX "opd_token_number_key" ON "opd_token" USING btree ("doctor_id","token_date","token_no");--> statement-breakpoint
CREATE UNIQUE INDEX "opd_token_encounter_key" ON "opd_token" USING btree ("encounter_id");--> statement-breakpoint
CREATE INDEX "opd_token_day_state_idx" ON "opd_token" USING btree ("facility_id","token_date","queue_state");--> statement-breakpoint
CREATE INDEX "queue_event_token_idx" ON "queue_event" USING btree ("token_id","at");--> statement-breakpoint
CREATE INDEX "queue_event_at_idx" ON "queue_event" USING btree ("facility_id","at");