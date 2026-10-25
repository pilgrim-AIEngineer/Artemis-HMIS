ALTER TABLE "app_user" ADD COLUMN "totp_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "totp_last_step" bigint;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "failed_login_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "pin_failed_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "pin_locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "password_must_change" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "password_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "deactivated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "deactivated_by" uuid;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "deactivate_reason" text;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "mfa_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "mfa_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "client_ip" text;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "is_remote" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workstation" ADD COLUMN "pairing_token_hash" text;--> statement-breakpoint
ALTER TABLE "workstation" ADD COLUMN "paired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workstation" ADD COLUMN "paired_by" uuid;--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_failed_counts_nonnegative" CHECK ("app_user"."failed_login_count" >= 0 and "app_user"."pin_failed_count" >= 0);