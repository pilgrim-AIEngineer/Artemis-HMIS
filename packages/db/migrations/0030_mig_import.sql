CREATE TABLE "patient_identifier" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"type" text NOT NULL,
	"label" text,
	"value" text NOT NULL,
	"verified_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"cancel_reason" text,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "patient_identifier_type" CHECK ("patient_identifier"."type" in ('abha_number', 'abha_address', 'aadhaar_masked', 'pmjay_id', 'insurance_member_id', 'employee_id', 'other')),
	CONSTRAINT "patient_identifier_status" CHECK ("patient_identifier"."status" in ('active', 'cancelled')),
	CONSTRAINT "patient_identifier_cancel_fields" CHECK (("patient_identifier"."status" = 'cancelled') = ("patient_identifier"."cancelled_at" is not null and "patient_identifier"."cancel_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "import_batch" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"file_name" text NOT NULL,
	"file_sha256" text NOT NULL,
	"headers" jsonb NOT NULL,
	"mapping" jsonb NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stage" text DEFAULT 'dry_run' NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"cancel_reason" text,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "import_batch_kind" CHECK ("import_batch"."kind" in ('patients', 'services_rates')),
	CONSTRAINT "import_batch_stage" CHECK ("import_batch"."stage" in ('dry_run', 'committing', 'committed', 'cancelled')),
	CONSTRAINT "import_batch_status" CHECK ("import_batch"."status" in ('active', 'cancelled')),
	CONSTRAINT "import_batch_cancel_fields" CHECK (("import_batch"."status" = 'cancelled') = ("import_batch"."cancelled_at" is not null and "import_batch"."cancel_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "import_row" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"source_row" integer NOT NULL,
	"raw" jsonb NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"preview" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"duplicate_of_id" uuid,
	"result_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "import_row_status_check" CHECK ("import_row"."status" in ('ok', 'error', 'duplicate', 'unchanged', 'committed', 'failed')),
	CONSTRAINT "import_row_seq_positive" CHECK ("import_row"."seq" >= 1)
);
--> statement-breakpoint
ALTER TABLE "patient_identifier" ADD CONSTRAINT "patient_identifier_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_identifier" ADD CONSTRAINT "patient_identifier_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_row" ADD CONSTRAINT "import_row_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_row" ADD CONSTRAINT "import_row_batch_id_import_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "patient_identifier_patient_idx" ON "patient_identifier" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "patient_identifier_lookup_idx" ON "patient_identifier" USING btree ("facility_id","type","value");--> statement-breakpoint
CREATE INDEX "import_batch_facility_idx" ON "import_batch" USING btree ("facility_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "import_row_seq_key" ON "import_row" USING btree ("batch_id","seq");--> statement-breakpoint
CREATE INDEX "import_row_status_idx" ON "import_row" USING btree ("batch_id","status","seq");