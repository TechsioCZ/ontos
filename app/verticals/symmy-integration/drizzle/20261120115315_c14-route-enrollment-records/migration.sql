CREATE TABLE "symmy_integration"."route_enrollment_records" (
	"change" text NOT NULL,
	"legal_entity_id" uuid,
	"operator_ref" text NOT NULL,
	"previous_revision" text,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"record_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"route_id" uuid NOT NULL,
	"route_key" text NOT NULL,
	"route_revision" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "symmy_route_enrollment_records_change_ck" CHECK ("change" in ('enroll', 'replace', 'deactivate')
        and ("change" = 'enroll') = ("previous_revision" is null)
        and ("change" <> 'deactivate' or "previous_revision" = "route_revision")),
	CONSTRAINT "symmy_route_enrollment_records_text_ck" CHECK (char_length("operator_ref") between 1 and 200 and char_length("reason") between 1 and 500
        and char_length("route_revision") between 1 and 80
        and ("previous_revision" is null or char_length("previous_revision") between 1 and 80))
);
--> statement-breakpoint
ALTER TABLE "symmy_integration"."route_enrollment_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "symmy_route_enrollment_records_route_idx" ON "symmy_integration"."route_enrollment_records" ("tenant_id","route_id","recorded_at");