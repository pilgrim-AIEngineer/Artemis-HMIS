CREATE TABLE "day_close" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"user_id" uuid,
	"close_date" date NOT NULL,
	"closed_at" timestamp with time zone NOT NULL,
	"cash_expected_paise" bigint DEFAULT 0 NOT NULL,
	"upi_expected_paise" bigint DEFAULT 0 NOT NULL,
	"card_expected_paise" bigint DEFAULT 0 NOT NULL,
	"other_expected_paise" bigint DEFAULT 0 NOT NULL,
	"cash_counted_paise" bigint DEFAULT 0 NOT NULL,
	"difference_paise" bigint DEFAULT 0 NOT NULL,
	"difference_reason" text,
	"denominations" jsonb,
	"payment_count" integer DEFAULT 0 NOT NULL,
	"facility_close_id" uuid,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"pending_acknowledged" boolean DEFAULT false NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "day_close_kind" CHECK ("day_close"."kind" in ('user', 'facility')),
	CONSTRAINT "day_close_user_fields" CHECK (("day_close"."kind" = 'user') = ("day_close"."user_id" is not null)),
	CONSTRAINT "day_close_denominations_user_only" CHECK (("day_close"."kind" = 'user') or "day_close"."denominations" is null),
	CONSTRAINT "day_close_money_range" CHECK (abs("day_close"."cash_expected_paise") <= 1000000000000 and abs("day_close"."upi_expected_paise") <= 1000000000000
        and abs("day_close"."card_expected_paise") <= 1000000000000 and abs("day_close"."other_expected_paise") <= 1000000000000
        and "day_close"."cash_counted_paise" between 0 and 1000000000000 and abs("day_close"."difference_paise") <= 1000000000000),
	CONSTRAINT "day_close_difference_math" CHECK ("day_close"."difference_paise" = "day_close"."cash_counted_paise" - "day_close"."cash_expected_paise"),
	CONSTRAINT "day_close_difference_reason" CHECK ("day_close"."difference_paise" = 0 or "day_close"."difference_reason" is not null),
	CONSTRAINT "day_close_facility_note" CHECK (not "day_close"."pending_acknowledged" or "day_close"."note" is not null),
	CONSTRAINT "day_close_attach_fields" CHECK (("day_close"."facility_close_id" is null) = ("day_close"."verified_at" is null) and ("day_close"."facility_close_id" is null) = ("day_close"."verified_by" is null))
);
--> statement-breakpoint
CREATE TABLE "upi_reconciliation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"recon_date" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"system_total_paise" bigint DEFAULT 0 NOT NULL,
	"statement_total_paise" bigint DEFAULT 0 NOT NULL,
	"difference_paise" bigint DEFAULT 0 NOT NULL,
	"difference_reason" text,
	"reconciled_by" uuid,
	"reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "upi_reconciliation_status" CHECK ("upi_reconciliation"."status" in ('open', 'reconciled')),
	CONSTRAINT "upi_reconciliation_money_range" CHECK (abs("upi_reconciliation"."system_total_paise") <= 1000000000000 and abs("upi_reconciliation"."statement_total_paise") <= 1000000000000
        and abs("upi_reconciliation"."difference_paise") <= 1000000000000),
	CONSTRAINT "upi_reconciliation_difference_math" CHECK ("upi_reconciliation"."difference_paise" = "upi_reconciliation"."statement_total_paise" - "upi_reconciliation"."system_total_paise"),
	CONSTRAINT "upi_reconciliation_done_fields" CHECK (("upi_reconciliation"."status" = 'reconciled') = ("upi_reconciliation"."reconciled_at" is not null and "upi_reconciliation"."reconciled_by" is not null)),
	CONSTRAINT "upi_reconciliation_difference_reason" CHECK ("upi_reconciliation"."status" <> 'reconciled' or "upi_reconciliation"."difference_paise" = 0 or "upi_reconciliation"."difference_reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "upi_reconciliation_item" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"reconciliation_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"matched" boolean DEFAULT true NOT NULL,
	"statement_utr" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "upi_reconciliation_item_utr" CHECK ("upi_reconciliation_item"."statement_utr" is null or "upi_reconciliation_item"."statement_utr" ~ '^[0-9]{6,22}$')
);
--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "business_date" date DEFAULT current_date NOT NULL;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "day_close_id" uuid;--> statement-breakpoint
ALTER TABLE "day_close" ADD CONSTRAINT "day_close_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "day_close" ADD CONSTRAINT "day_close_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "day_close" ADD CONSTRAINT "day_close_facility_close_id_day_close_id_fk" FOREIGN KEY ("facility_close_id") REFERENCES "public"."day_close"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "day_close" ADD CONSTRAINT "day_close_verified_by_app_user_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upi_reconciliation" ADD CONSTRAINT "upi_reconciliation_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upi_reconciliation" ADD CONSTRAINT "upi_reconciliation_reconciled_by_app_user_id_fk" FOREIGN KEY ("reconciled_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upi_reconciliation_item" ADD CONSTRAINT "upi_reconciliation_item_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upi_reconciliation_item" ADD CONSTRAINT "upi_reconciliation_item_reconciliation_id_upi_reconciliation_id_fk" FOREIGN KEY ("reconciliation_id") REFERENCES "public"."upi_reconciliation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upi_reconciliation_item" ADD CONSTRAINT "upi_reconciliation_item_payment_id_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "day_close_facility_date_key" ON "day_close" USING btree ("facility_id","close_date") WHERE "day_close"."kind" = 'facility';--> statement-breakpoint
CREATE INDEX "day_close_user_idx" ON "day_close" USING btree ("user_id","closed_at");--> statement-breakpoint
CREATE INDEX "day_close_date_idx" ON "day_close" USING btree ("facility_id","close_date");--> statement-breakpoint
CREATE INDEX "day_close_facility_close_idx" ON "day_close" USING btree ("facility_close_id");--> statement-breakpoint
CREATE UNIQUE INDEX "upi_reconciliation_date_key" ON "upi_reconciliation" USING btree ("facility_id","recon_date");--> statement-breakpoint
CREATE UNIQUE INDEX "upi_reconciliation_item_key" ON "upi_reconciliation_item" USING btree ("reconciliation_id","payment_id");--> statement-breakpoint
CREATE INDEX "upi_reconciliation_item_payment_idx" ON "upi_reconciliation_item" USING btree ("payment_id");--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_day_close_id_day_close_id_fk" FOREIGN KEY ("day_close_id") REFERENCES "public"."day_close"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_business_date_idx" ON "payment" USING btree ("facility_id","business_date");--> statement-breakpoint
CREATE INDEX "payment_open_by_user_idx" ON "payment" USING btree ("received_by") WHERE "payment"."day_close_id" is null;--> statement-breakpoint
CREATE INDEX "payment_day_close_idx" ON "payment" USING btree ("day_close_id");