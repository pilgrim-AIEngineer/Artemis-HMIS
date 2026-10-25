CREATE TABLE "patient" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"uhid" text NOT NULL,
	"first_name" text NOT NULL,
	"middle_name" text,
	"last_name" text,
	"full_name" text GENERATED ALWAYS AS (btrim(regexp_replace(coalesce(first_name, '') || ' ' || coalesce(middle_name, '') || ' ' || coalesce(last_name, ''), '\s+', ' ', 'g'))) STORED,
	"name_hi" text,
	"sex" text NOT NULL,
	"dob" date NOT NULL,
	"dob_is_estimated" boolean DEFAULT false NOT NULL,
	"mobile" text,
	"no_mobile_reason" text,
	"alt_mobile" text,
	"relation_to_mobile_owner" text,
	"guardian_name" text,
	"guardian_relation" text,
	"address_line" text,
	"locality_id" uuid,
	"district" text,
	"state" text,
	"pincode" text,
	"blood_group" text,
	"marital_status" text,
	"occupation" text,
	"referred_by" text,
	"photo_file_id" uuid,
	"is_deceased" boolean DEFAULT false NOT NULL,
	"deceased_at" timestamp with time zone,
	"merged_into_id" uuid,
	"identity_changed_at" timestamp with time zone,
	"duplicate_override_reason" text,
	"search_name_norm" text DEFAULT '' NOT NULL,
	"search_name_phonetic" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"cancel_reason" text,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "patient_sex" CHECK ("patient"."sex" in ('F', 'M', 'O')),
	CONSTRAINT "patient_guardian_relation" CHECK ("patient"."guardian_relation" is null or "patient"."guardian_relation" in ('husband', 'father', 'mother', 'other')),
	CONSTRAINT "patient_mobile_owner_relation" CHECK ("patient"."relation_to_mobile_owner" is null or "patient"."relation_to_mobile_owner" in ('self', 'husband', 'wife', 'father', 'mother', 'son', 'daughter', 'brother', 'sister', 'other')),
	CONSTRAINT "patient_marital_status" CHECK ("patient"."marital_status" is null or "patient"."marital_status" in ('single', 'married', 'widowed', 'divorced', 'separated')),
	CONSTRAINT "patient_blood_group" CHECK ("patient"."blood_group" is null or "patient"."blood_group" in ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')),
	CONSTRAINT "patient_mobile_format" CHECK ("patient"."mobile" is null or "patient"."mobile" ~ '^[6-9][0-9]{9}$'),
	CONSTRAINT "patient_alt_mobile_format" CHECK ("patient"."alt_mobile" is null or "patient"."alt_mobile" ~ '^[6-9][0-9]{9}$'),
	CONSTRAINT "patient_pincode_format" CHECK ("patient"."pincode" is null or "patient"."pincode" ~ '^[1-9][0-9]{5}$'),
	CONSTRAINT "patient_mobile_or_reason" CHECK ("patient"."mobile" is not null or "patient"."no_mobile_reason" is not null),
	CONSTRAINT "patient_deceased_fields" CHECK ("patient"."is_deceased" or "patient"."deceased_at" is null),
	CONSTRAINT "patient_status" CHECK ("patient"."status" in ('active', 'cancelled')),
	CONSTRAINT "patient_cancel_fields" CHECK (("patient"."status" = 'cancelled') = ("patient"."cancelled_at" is not null and "patient"."cancel_reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_locality_id_locality_id_fk" FOREIGN KEY ("locality_id") REFERENCES "public"."locality"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_photo_file_id_document_id_fk" FOREIGN KEY ("photo_file_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_merged_into_id_patient_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "patient_uhid_key" ON "patient" USING btree ("facility_id","uhid");--> statement-breakpoint
CREATE INDEX "patient_mobile_idx" ON "patient" USING btree ("facility_id","mobile");--> statement-breakpoint
CREATE INDEX "patient_alt_mobile_idx" ON "patient" USING btree ("facility_id","alt_mobile");--> statement-breakpoint
CREATE INDEX "patient_name_norm_trgm" ON "patient" USING gin ("search_name_norm" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "patient_name_phonetic_trgm" ON "patient" USING gin ("search_name_phonetic" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "patient_name_hi_trgm" ON "patient" USING gin ("name_hi" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "patient_locality_idx" ON "patient" USING btree ("locality_id");