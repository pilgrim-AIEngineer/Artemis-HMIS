ALTER TABLE "idempotency" DROP CONSTRAINT "idempotency_key_key";--> statement-breakpoint
ALTER TABLE "idempotency" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "idempotency" ADD COLUMN "request_hash" text NOT NULL DEFAULT '';--> statement-breakpoint
-- Pre-existing cache rows (none written by the app yet) keep '', which never matches a real hash.
ALTER TABLE "idempotency" ALTER COLUMN "request_hash" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "idempotency" ADD CONSTRAINT "idempotency_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency" ADD CONSTRAINT "idempotency_facility_procedure_key_key" UNIQUE("facility_id","procedure","key");