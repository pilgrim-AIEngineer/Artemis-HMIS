CREATE TABLE "bill" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"number" text,
	"kind" text NOT NULL,
	"encounter_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"payer_id" uuid NOT NULL,
	"tariff_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"bill_date" date NOT NULL,
	"gross_paise" bigint DEFAULT 0 NOT NULL,
	"discount_paise" bigint DEFAULT 0 NOT NULL,
	"taxable_paise" bigint DEFAULT 0 NOT NULL,
	"cgst_paise" bigint DEFAULT 0 NOT NULL,
	"sgst_paise" bigint DEFAULT 0 NOT NULL,
	"round_off_paise" bigint DEFAULT 0 NOT NULL,
	"net_paise" bigint DEFAULT 0 NOT NULL,
	"payer_share_paise" bigint DEFAULT 0 NOT NULL,
	"patient_share_paise" bigint DEFAULT 0 NOT NULL,
	"paid_paise" bigint DEFAULT 0 NOT NULL,
	"balance_paise" bigint DEFAULT 0 NOT NULL,
	"finalized_by" uuid,
	"finalized_at" timestamp with time zone,
	"cancel_note" text,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "bill_kind" CHECK ("bill"."kind" in ('opd', 'ipd_interim', 'ipd_final', 'pharmacy', 'daycare')),
	CONSTRAINT "bill_status" CHECK ("bill"."status" in ('draft', 'final', 'cancelled')),
	CONSTRAINT "bill_money_range" CHECK ("bill"."gross_paise" >= 0 and "bill"."gross_paise" <= 1000000000000 and "bill"."discount_paise" >= 0 and "bill"."discount_paise" <= 1000000000000 and "bill"."taxable_paise" >= 0 and "bill"."taxable_paise" <= 1000000000000
        and "bill"."cgst_paise" >= 0 and "bill"."cgst_paise" <= 1000000000000 and "bill"."sgst_paise" >= 0 and "bill"."sgst_paise" <= 1000000000000 and "bill"."net_paise" >= 0 and "bill"."net_paise" <= 1000000000000
        and "bill"."payer_share_paise" >= 0 and "bill"."payer_share_paise" <= 1000000000000 and "bill"."patient_share_paise" >= 0 and "bill"."patient_share_paise" <= 1000000000000
        and "bill"."paid_paise" >= 0 and "bill"."paid_paise" <= 1000000000000 and "bill"."balance_paise" >= -1000000000000 and "bill"."balance_paise" <= 1000000000000),
	CONSTRAINT "bill_net_math" CHECK ("bill"."net_paise" = "bill"."gross_paise" - "bill"."discount_paise" + "bill"."cgst_paise" + "bill"."sgst_paise" + "bill"."round_off_paise"),
	CONSTRAINT "bill_share_math" CHECK ("bill"."payer_share_paise" + "bill"."patient_share_paise" = "bill"."net_paise"),
	CONSTRAINT "bill_taxable_math" CHECK ("bill"."taxable_paise" = "bill"."gross_paise" - "bill"."discount_paise"),
	CONSTRAINT "bill_discount_le_gross" CHECK ("bill"."discount_paise" <= "bill"."gross_paise"),
	CONSTRAINT "bill_round_off_range" CHECK ("bill"."round_off_paise" between -50 and 50),
	CONSTRAINT "bill_balance_math" CHECK ("bill"."balance_paise" = "bill"."patient_share_paise" - "bill"."paid_paise"),
	CONSTRAINT "bill_no_overpayment" CHECK ("bill"."paid_paise" <= "bill"."patient_share_paise"),
	CONSTRAINT "bill_final_has_number" CHECK ("bill"."status" <> 'final' or "bill"."number" is not null),
	CONSTRAINT "bill_finalized_fields" CHECK (("bill"."number" is null) = ("bill"."finalized_at" is null)),
	CONSTRAINT "bill_cancel_fields" CHECK (("bill"."status" = 'cancelled') = ("bill"."cancelled_at" is not null and "bill"."cancel_note" is not null))
);
--> statement-breakpoint
CREATE TABLE "bill_line" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"source" text DEFAULT 'service' NOT NULL,
	"service_id" uuid,
	"service_rate_id" uuid,
	"description" text NOT NULL,
	"description_hi" text,
	"qty" numeric(12, 3) DEFAULT '1' NOT NULL,
	"unit_rate_paise" bigint DEFAULT 0 NOT NULL,
	"amount_paise" bigint DEFAULT 0 NOT NULL,
	"discount_paise" bigint DEFAULT 0 NOT NULL,
	"sac_hsn" text,
	"gst_rate_bp" integer DEFAULT 0 NOT NULL,
	"is_exempt" boolean DEFAULT true NOT NULL,
	"taxable_paise" bigint DEFAULT 0 NOT NULL,
	"cgst_paise" bigint DEFAULT 0 NOT NULL,
	"sgst_paise" bigint DEFAULT 0 NOT NULL,
	"payer_share_paise" bigint DEFAULT 0 NOT NULL,
	"patient_share_paise" bigint DEFAULT 0 NOT NULL,
	"service_date" date NOT NULL,
	"performed_by_doctor_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"cancel_reason" text,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "bill_line_source" CHECK ("bill_line"."source" in ('service', 'package', 'pharmacy_sale_item', 'bed_charge', 'consumable', 'implant')),
	CONSTRAINT "bill_line_status" CHECK ("bill_line"."status" in ('active', 'cancelled')),
	CONSTRAINT "bill_line_qty_positive" CHECK ("bill_line"."qty" > 0),
	CONSTRAINT "bill_line_gst_bp" CHECK ("bill_line"."gst_rate_bp" between 0 and 10000),
	CONSTRAINT "bill_line_exempt_no_gst" CHECK (not "bill_line"."is_exempt" or "bill_line"."gst_rate_bp" = 0),
	CONSTRAINT "bill_line_money_range" CHECK ("bill_line"."unit_rate_paise" >= 0 and "bill_line"."unit_rate_paise" <= 1000000000000 and "bill_line"."amount_paise" >= 0 and "bill_line"."amount_paise" <= 1000000000000 and "bill_line"."discount_paise" >= 0 and "bill_line"."discount_paise" <= 1000000000000
        and "bill_line"."taxable_paise" >= 0 and "bill_line"."taxable_paise" <= 1000000000000 and "bill_line"."cgst_paise" >= 0 and "bill_line"."cgst_paise" <= 1000000000000 and "bill_line"."sgst_paise" >= 0 and "bill_line"."sgst_paise" <= 1000000000000
        and "bill_line"."payer_share_paise" >= 0 and "bill_line"."payer_share_paise" <= 1000000000000 and "bill_line"."patient_share_paise" >= 0 and "bill_line"."patient_share_paise" <= 1000000000000),
	CONSTRAINT "bill_line_amount_math" CHECK ("bill_line"."amount_paise" = round("bill_line"."qty" * "bill_line"."unit_rate_paise")),
	CONSTRAINT "bill_line_discount_le_amount" CHECK ("bill_line"."discount_paise" <= "bill_line"."amount_paise"),
	CONSTRAINT "bill_line_taxable_math" CHECK ("bill_line"."taxable_paise" = "bill_line"."amount_paise" - "bill_line"."discount_paise"),
	CONSTRAINT "bill_line_gst_math" CHECK ("bill_line"."cgst_paise" = "bill_line"."sgst_paise" and "bill_line"."cgst_paise" = round("bill_line"."taxable_paise"::numeric * "bill_line"."gst_rate_bp" / 20000)),
	CONSTRAINT "bill_line_share_math" CHECK ("bill_line"."payer_share_paise" + "bill_line"."patient_share_paise" = "bill_line"."taxable_paise" + "bill_line"."cgst_paise" + "bill_line"."sgst_paise"),
	CONSTRAINT "bill_line_cancel_fields" CHECK (("bill_line"."status" = 'cancelled') = ("bill_line"."cancelled_at" is not null and "bill_line"."cancel_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "payment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"number" text NOT NULL,
	"collection_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid,
	"bill_id" uuid,
	"kind" text DEFAULT 'payment' NOT NULL,
	"mode" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"upi_ref" text,
	"upi_payer_name" text,
	"provider_ref" text,
	"card_last4" text,
	"card_auth_code" text,
	"cheque_no" text,
	"received_by" uuid,
	"received_at" timestamp with time zone NOT NULL,
	"workstation_id" uuid,
	"status" text DEFAULT 'valid' NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "payment_kind" CHECK ("payment"."kind" in ('payment', 'deposit', 'refund', 'deposit_adjustment', 'advance')),
	CONSTRAINT "payment_mode" CHECK ("payment"."mode" in ('cash', 'upi', 'card', 'bank_transfer', 'cheque', 'payer_settlement')),
	CONSTRAINT "payment_status" CHECK ("payment"."status" in ('valid', 'reversed')),
	CONSTRAINT "payment_amount_range" CHECK ("payment"."amount_paise" >= -1000000000000 and "payment"."amount_paise" <= 1000000000000),
	CONSTRAINT "payment_amount_sign" CHECK (("payment"."kind" = 'refund' and "payment"."amount_paise" < 0) or ("payment"."kind" <> 'refund' and "payment"."amount_paise" > 0)),
	CONSTRAINT "payment_bill_kind" CHECK ("payment"."kind" not in ('payment', 'refund') or "payment"."bill_id" is not null),
	CONSTRAINT "payment_upi_ref_format" CHECK ("payment"."upi_ref" is null or "payment"."upi_ref" ~ '^[0-9]{4,12}$'),
	CONSTRAINT "payment_upi_fields" CHECK ("payment"."mode" = 'upi' or ("payment"."upi_ref" is null and "payment"."upi_payer_name" is null)),
	CONSTRAINT "payment_card_last4_format" CHECK ("payment"."card_last4" is null or "payment"."card_last4" ~ '^[0-9]{4}$'),
	CONSTRAINT "payment_card_fields" CHECK ("payment"."mode" = 'card' or ("payment"."card_last4" is null and "payment"."card_auth_code" is null))
);
--> statement-breakpoint
ALTER TABLE "bill" ADD CONSTRAINT "bill_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill" ADD CONSTRAINT "bill_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill" ADD CONSTRAINT "bill_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill" ADD CONSTRAINT "bill_payer_id_payer_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."payer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill" ADD CONSTRAINT "bill_tariff_id_tariff_id_fk" FOREIGN KEY ("tariff_id") REFERENCES "public"."tariff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill" ADD CONSTRAINT "bill_finalized_by_app_user_id_fk" FOREIGN KEY ("finalized_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill" ADD CONSTRAINT "bill_cancelled_by_app_user_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_line" ADD CONSTRAINT "bill_line_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_line" ADD CONSTRAINT "bill_line_bill_id_bill_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bill"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_line" ADD CONSTRAINT "bill_line_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_line" ADD CONSTRAINT "bill_line_service_rate_id_service_rate_id_fk" FOREIGN KEY ("service_rate_id") REFERENCES "public"."service_rate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_line" ADD CONSTRAINT "bill_line_performed_by_doctor_id_doctor_profile_id_fk" FOREIGN KEY ("performed_by_doctor_id") REFERENCES "public"."doctor_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_line" ADD CONSTRAINT "bill_line_cancelled_by_app_user_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_bill_id_bill_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bill"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_received_by_app_user_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_workstation_id_workstation_id_fk" FOREIGN KEY ("workstation_id") REFERENCES "public"."workstation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bill_number_key" ON "bill" USING btree ("facility_id","number") WHERE "bill"."number" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "bill_opd_draft_key" ON "bill" USING btree ("encounter_id") WHERE "bill"."kind" = 'opd' and "bill"."status" = 'draft';--> statement-breakpoint
CREATE INDEX "bill_patient_date_idx" ON "bill" USING btree ("patient_id","bill_date");--> statement-breakpoint
CREATE INDEX "bill_status_date_idx" ON "bill" USING btree ("facility_id","status","bill_date");--> statement-breakpoint
CREATE INDEX "bill_encounter_idx" ON "bill" USING btree ("encounter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bill_line_seq_key" ON "bill_line" USING btree ("bill_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_number_mode_key" ON "payment" USING btree ("facility_id","number","mode");--> statement-breakpoint
CREATE INDEX "payment_received_idx" ON "payment" USING btree ("received_by","received_at");--> statement-breakpoint
CREATE INDEX "payment_bill_idx" ON "payment" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX "payment_collection_idx" ON "payment" USING btree ("collection_id");--> statement-breakpoint
CREATE INDEX "payment_facility_day_idx" ON "payment" USING btree ("facility_id","received_at");