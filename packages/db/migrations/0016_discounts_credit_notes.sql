CREATE TABLE "approval" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"bill_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"approver_id" uuid NOT NULL,
	"method" text NOT NULL,
	"amount_paise" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "approval_kind" CHECK ("approval"."kind" in ('discount', 'credit_note')),
	CONSTRAINT "approval_method" CHECK ("approval"."method" in ('pin', 'self', 'within_limit')),
	CONSTRAINT "approval_amount_range" CHECK ("approval"."amount_paise" >= 0 and "approval"."amount_paise" <= 1000000000000),
	CONSTRAINT "approval_who" CHECK (("approval"."method" = 'pin') = ("approval"."approver_id" <> "approval"."requested_by"))
);
--> statement-breakpoint
CREATE TABLE "bill_discount" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"bill_line_id" uuid,
	"mode" text NOT NULL,
	"percent_bp" integer,
	"amount_paise" bigint DEFAULT 0 NOT NULL,
	"reason_code_id" uuid NOT NULL,
	"reason_text" text,
	"approval_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"cancel_reason" text,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "bill_discount_mode" CHECK ("bill_discount"."mode" in ('percent', 'amount')),
	CONSTRAINT "bill_discount_amount_range" CHECK ("bill_discount"."amount_paise" >= 0 and "bill_discount"."amount_paise" <= 1000000000000 and "bill_discount"."amount_paise" > 0),
	CONSTRAINT "bill_discount_percent" CHECK (("bill_discount"."mode" = 'percent') = ("bill_discount"."percent_bp" is not null) and ("bill_discount"."percent_bp" is null or "bill_discount"."percent_bp" between 1 and 10000)),
	CONSTRAINT "bill_discount_status" CHECK ("bill_discount"."status" in ('active', 'cancelled')),
	CONSTRAINT "bill_discount_cancel_fields" CHECK (("bill_discount"."status" = 'cancelled') = ("bill_discount"."cancelled_at" is not null and "bill_discount"."cancel_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "credit_note" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"number" text NOT NULL,
	"bill_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"amount_paise" bigint DEFAULT 0 NOT NULL,
	"taxable_paise" bigint DEFAULT 0 NOT NULL,
	"cgst_paise" bigint DEFAULT 0 NOT NULL,
	"sgst_paise" bigint DEFAULT 0 NOT NULL,
	"reason_code_id" uuid NOT NULL,
	"reason_text" text,
	"approval_id" uuid,
	"issued_by" uuid NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"cancels_bill" boolean DEFAULT false NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "credit_note_amount_range" CHECK ("credit_note"."amount_paise" >= 0 and "credit_note"."amount_paise" <= 1000000000000 and "credit_note"."amount_paise" > 0),
	CONSTRAINT "credit_note_split" CHECK ("credit_note"."amount_paise" = "credit_note"."taxable_paise" + "credit_note"."cgst_paise" + "credit_note"."sgst_paise" and "credit_note"."cgst_paise" = "credit_note"."sgst_paise")
);
--> statement-breakpoint
ALTER TABLE "bill" DROP CONSTRAINT "bill_balance_math";--> statement-breakpoint
ALTER TABLE "bill" DROP CONSTRAINT "bill_no_overpayment";--> statement-breakpoint
ALTER TABLE "bill" DROP CONSTRAINT "bill_money_range";--> statement-breakpoint
ALTER TABLE "bill" ADD COLUMN "credited_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bill" ADD COLUMN "credited_cgst_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bill" ADD COLUMN "credited_sgst_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "approval_id" uuid;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "credit_note_id" uuid;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "reason_code_id" uuid;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "reason_text" text;--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_bill_id_bill_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bill"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_requested_by_app_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_approver_id_app_user_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_discount" ADD CONSTRAINT "bill_discount_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_discount" ADD CONSTRAINT "bill_discount_bill_id_bill_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bill"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_discount" ADD CONSTRAINT "bill_discount_bill_line_id_bill_line_id_fk" FOREIGN KEY ("bill_line_id") REFERENCES "public"."bill_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_discount" ADD CONSTRAINT "bill_discount_reason_code_id_reason_code_id_fk" FOREIGN KEY ("reason_code_id") REFERENCES "public"."reason_code"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_discount" ADD CONSTRAINT "bill_discount_approval_id_approval_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approval"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_bill_id_bill_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bill"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_reason_code_id_reason_code_id_fk" FOREIGN KEY ("reason_code_id") REFERENCES "public"."reason_code"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_approval_id_approval_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approval"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_issued_by_app_user_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_bill_idx" ON "approval" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX "approval_approver_idx" ON "approval" USING btree ("facility_id","approver_id","created_at");--> statement-breakpoint
CREATE INDEX "bill_discount_bill_idx" ON "bill_discount" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX "bill_discount_report_idx" ON "bill_discount" USING btree ("facility_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bill_discount_active_scope_key" ON "bill_discount" USING btree ("bill_id",coalesce("bill_line_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "bill_discount"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "credit_note_number_key" ON "credit_note" USING btree ("facility_id","number");--> statement-breakpoint
CREATE INDEX "credit_note_bill_idx" ON "credit_note" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX "credit_note_report_idx" ON "credit_note" USING btree ("facility_id","issued_at");--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_approval_id_approval_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approval"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_credit_note_id_credit_note_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."credit_note"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_reason_code_id_reason_code_id_fk" FOREIGN KEY ("reason_code_id") REFERENCES "public"."reason_code"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill" ADD CONSTRAINT "bill_balance_credit_math" CHECK ("bill"."balance_paise" = "bill"."patient_share_paise" - "bill"."credited_paise" - "bill"."paid_paise");--> statement-breakpoint
ALTER TABLE "bill" ADD CONSTRAINT "bill_no_overpayment_credit" CHECK ("bill"."credited_paise" <= "bill"."patient_share_paise" and "bill"."paid_paise" <= "bill"."patient_share_paise" - "bill"."credited_paise");--> statement-breakpoint
ALTER TABLE "bill" ADD CONSTRAINT "bill_credited_tax" CHECK ("bill"."credited_cgst_paise" <= "bill"."cgst_paise" and "bill"."credited_sgst_paise" <= "bill"."sgst_paise");--> statement-breakpoint
ALTER TABLE "bill" ADD CONSTRAINT "bill_money_range" CHECK ("bill"."gross_paise" >= 0 and "bill"."gross_paise" <= 1000000000000 and "bill"."discount_paise" >= 0 and "bill"."discount_paise" <= 1000000000000 and "bill"."taxable_paise" >= 0 and "bill"."taxable_paise" <= 1000000000000
        and "bill"."cgst_paise" >= 0 and "bill"."cgst_paise" <= 1000000000000 and "bill"."sgst_paise" >= 0 and "bill"."sgst_paise" <= 1000000000000 and "bill"."net_paise" >= 0 and "bill"."net_paise" <= 1000000000000
        and "bill"."payer_share_paise" >= 0 and "bill"."payer_share_paise" <= 1000000000000 and "bill"."patient_share_paise" >= 0 and "bill"."patient_share_paise" <= 1000000000000
        and "bill"."paid_paise" >= 0 and "bill"."paid_paise" <= 1000000000000 and "bill"."balance_paise" >= -1000000000000 and "bill"."balance_paise" <= 1000000000000
        and "bill"."credited_paise" >= 0 and "bill"."credited_paise" <= 1000000000000 and "bill"."credited_cgst_paise" >= 0 and "bill"."credited_cgst_paise" <= 1000000000000
        and "bill"."credited_sgst_paise" >= 0 and "bill"."credited_sgst_paise" <= 1000000000000);--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_refund_approval" CHECK ("payment"."kind" <> 'refund' or ("payment"."approval_id" is not null and "payment"."reason_code_id" is not null));--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_refund_only_fields" CHECK ("payment"."kind" = 'refund' or ("payment"."approval_id" is null and "payment"."credit_note_id" is null and "payment"."reason_code_id" is null and "payment"."reason_text" is null));