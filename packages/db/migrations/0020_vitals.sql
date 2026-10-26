CREATE TABLE "vitals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"form_group" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"bp_sys" smallint,
	"bp_dia" smallint,
	"pulse" smallint,
	"temp_c" numeric(5, 2),
	"spo2" smallint,
	"rr" smallint,
	"weight_kg" numeric(5, 2),
	"height_cm" numeric(4, 1),
	"bmi" numeric(4, 1),
	"head_circ_cm" numeric(3, 1),
	"muac_cm" numeric(3, 1),
	"rbs_mgdl" smallint,
	"hb_gdl" numeric(3, 1),
	"pain_score" smallint,
	"fundal_height_cm" numeric(3, 1),
	"fhr" smallint,
	"oedema" text,
	"urine_albumin" text,
	"urine_sugar" text,
	"recorded_by" uuid NOT NULL,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "vitals_group" CHECK ("vitals"."form_group" in ('adult', 'pregnant', 'child')),
	CONSTRAINT "vitals_status" CHECK ("vitals"."status" in ('active', 'superseded')),
	CONSTRAINT "vitals_oedema" CHECK ("vitals"."oedema" is null or "vitals"."oedema" in ('none', 'plus1', 'plus2')),
	CONSTRAINT "vitals_urine_albumin" CHECK ("vitals"."urine_albumin" is null or "vitals"."urine_albumin" in ('nil', 'trace', 'plus1', 'plus2', 'plus3', 'plus4')),
	CONSTRAINT "vitals_urine_sugar" CHECK ("vitals"."urine_sugar" is null or "vitals"."urine_sugar" in ('nil', 'trace', 'plus1', 'plus2', 'plus3', 'plus4')),
	CONSTRAINT "vitals_flags_array" CHECK (jsonb_typeof("vitals"."flags") = 'array'),
	CONSTRAINT "vitals_superseded_fields" CHECK (("vitals"."status" = 'superseded') = ("vitals"."superseded_at" is not null)),
	CONSTRAINT "vitals_bp_pair" CHECK (("vitals"."bp_sys" is null) = ("vitals"."bp_dia" is null) and ("vitals"."bp_dia" is null or "vitals"."bp_dia" < "vitals"."bp_sys"))
);
--> statement-breakpoint
ALTER TABLE "vitals" ADD CONSTRAINT "vitals_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vitals" ADD CONSTRAINT "vitals_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vitals" ADD CONSTRAINT "vitals_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vitals" ADD CONSTRAINT "vitals_recorded_by_app_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vitals_active_encounter_key" ON "vitals" USING btree ("encounter_id") WHERE "vitals"."status" = 'active';--> statement-breakpoint
CREATE INDEX "vitals_encounter_idx" ON "vitals" USING btree ("encounter_id","recorded_at");--> statement-breakpoint
CREATE INDEX "vitals_patient_idx" ON "vitals" USING btree ("patient_id","recorded_at" DESC NULLS LAST);