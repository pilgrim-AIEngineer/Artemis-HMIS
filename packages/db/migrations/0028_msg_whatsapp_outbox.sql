CREATE TABLE "message_template" (
	"id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"channel" text DEFAULT 'whatsapp' NOT NULL,
	"kind" text NOT NULL,
	"language" text NOT NULL,
	"provider_template_name" text NOT NULL,
	"body_preview" text NOT NULL,
	"variables" jsonb NOT NULL,
	"is_approved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"updated_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	CONSTRAINT "message_template_channel" CHECK ("message_template"."channel" in ('whatsapp', 'sms')),
	CONSTRAINT "message_template_language" CHECK ("message_template"."language" in ('en', 'hi'))
);
--> statement-breakpoint
ALTER TABLE "message_outbox" DROP CONSTRAINT "message_outbox_status";--> statement-breakpoint
ALTER TABLE "message_outbox" ADD COLUMN "entity_id" uuid;--> statement-breakpoint
ALTER TABLE "message_outbox" ADD COLUMN "document_id" uuid;--> statement-breakpoint
ALTER TABLE "message_outbox" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message_outbox" ADD COLUMN "first_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message_outbox" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message_template" ADD CONSTRAINT "message_template_facility_id_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facility"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_template_key" ON "message_template" USING btree ("facility_id","channel","kind","language");--> statement-breakpoint
ALTER TABLE "message_outbox" ADD CONSTRAINT "message_outbox_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_outbox" ADD CONSTRAINT "message_outbox_status" CHECK ("message_outbox"."status" in ('queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'opted_out', 'skipped_no_consent', 'cancelled'));