-- Adopt the local dispatcher's existing ledger without losing never-twice keys.
CREATE SCHEMA IF NOT EXISTS "demo_email";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "demo_email"."deliveries" (
	"dedupe_key" text PRIMARY KEY,
	"source" text NOT NULL,
	"event" text NOT NULL,
	"event_label" text,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"subject_id" text NOT NULL,
	"subject_number" text DEFAULT '' NOT NULL,
	"recipient" text NOT NULL,
	"email_subject" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"message_id" text,
	"error_tag" text,
	"event_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "deliveries_source_check" CHECK ("source" in ('akros-order', 'facility-agenda', 'rent-reminder')),
	CONSTRAINT "deliveries_status_check" CHECK ("status" in ('SENDING', 'SENT', 'RETRY', 'FAILED', 'UNKNOWN', 'SKIPPED'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "demo_email"."settings" (
	"key" text PRIMARY KEY,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deliveries_subject_idx" ON "demo_email"."deliveries" ("source","subject_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deliveries_number_idx" ON "demo_email"."deliveries" ("source","subject_number");
--> statement-breakpoint
ALTER TABLE "demo_email"."deliveries" ADD COLUMN IF NOT EXISTS "event_label" text;
--> statement-breakpoint
ALTER TABLE "demo_email"."deliveries" DROP CONSTRAINT "deliveries_status_check",
  ADD CONSTRAINT "deliveries_status_check" CHECK (status IN ('SENDING', 'SENT', 'RETRY', 'FAILED', 'UNKNOWN', 'SKIPPED'));
--> statement-breakpoint
INSERT INTO "demo_email"."settings" (key, value)
  VALUES ('enabled_since', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ontos_runtime') THEN
    GRANT USAGE ON SCHEMA demo_email TO ontos_runtime;
    GRANT SELECT, INSERT, UPDATE ON demo_email.deliveries TO ontos_runtime;
    GRANT SELECT ON demo_email.settings TO ontos_runtime;
  END IF;
END $$;
