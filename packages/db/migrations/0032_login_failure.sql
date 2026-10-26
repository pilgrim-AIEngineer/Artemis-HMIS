CREATE TABLE "login_failure" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"client_ip" text NOT NULL,
	"kind" text NOT NULL,
	"actor_user_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"lock_until" timestamp with time zone,
	"cleared_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "login_failure_kind" CHECK ("login_failure"."kind" in ('password', 'totp', 'approval_pin'))
);
--> statement-breakpoint
ALTER TABLE "login_failure" ADD CONSTRAINT "login_failure_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_failure" ADD CONSTRAINT "login_failure_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_failure" ADD CONSTRAINT "login_failure_actor_user_id_app_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "login_failure_pair_idx" ON "login_failure" USING btree ("user_id","client_ip","at");--> statement-breakpoint
CREATE INDEX "login_failure_ip_idx" ON "login_failure" USING btree ("client_ip","at");