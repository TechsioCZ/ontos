CREATE SEQUENCE "symmy_integration"."job_route_change_tokens" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "symmy_integration"."route_enrollment_records" (
	"change" text NOT NULL,
	"change_token" integer NOT NULL,
	"database_session_user" text DEFAULT session_user NOT NULL,
	"legal_entity_id" uuid,
	"previous_change_token" integer,
	"previous_revision" text,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"record_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"route_id" uuid NOT NULL,
	"route_key" text NOT NULL,
	"route_revision" text NOT NULL,
	"stated_operator_ref" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "symmy_route_enrollment_records_change_ck" CHECK ("change" in ('enroll', 'replace', 'deactivate')
        and ("change" = 'enroll') = ("previous_revision" is null)
        and ("change" = 'enroll') = ("previous_change_token" is null)
        and ("previous_change_token" is null or "change_token" <> "previous_change_token")
        and "change_token" >= 1
        and ("change" <> 'deactivate' or "previous_revision" = "route_revision")),
	CONSTRAINT "symmy_route_enrollment_records_text_ck" CHECK (char_length("stated_operator_ref") between 1 and 200 and char_length("reason") between 1 and 500
        and char_length("route_revision") between 1 and 80
        and ("previous_revision" is null or char_length("previous_revision") between 1 and 80))
);
--> statement-breakpoint
ALTER TABLE "symmy_integration"."route_enrollment_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "symmy_integration"."job_routes" ADD COLUMN "change_token" integer DEFAULT nextval('symmy_integration.job_route_change_tokens'::regclass) NOT NULL;--> statement-breakpoint
CREATE INDEX "symmy_route_enrollment_records_route_idx" ON "symmy_integration"."route_enrollment_records" ("tenant_id","route_id","recorded_at");