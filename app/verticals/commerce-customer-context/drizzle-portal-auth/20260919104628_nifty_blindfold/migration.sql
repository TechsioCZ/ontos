CREATE TABLE "commerce_auth"."portal_auth_audit_event" (
	"audit_event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"event_type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"operation" text,
	"outcome" text NOT NULL,
	"provider_subject_id" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"schema_version" smallint NOT NULL,
	"session_ref" text,
	"subject_digest" text
);
--> statement-breakpoint
CREATE INDEX "commerce_auth_audit_event_occurred_at_idx" ON "commerce_auth"."portal_auth_audit_event" ("occurred_at");--> statement-breakpoint
CREATE INDEX "commerce_auth_audit_event_type_occurred_at_idx" ON "commerce_auth"."portal_auth_audit_event" ("event_type","occurred_at");--> statement-breakpoint
CREATE INDEX "commerce_auth_audit_event_subject_digest_idx" ON "commerce_auth"."portal_auth_audit_event" ("subject_digest");--> statement-breakpoint
CREATE INDEX "commerce_auth_audit_event_provider_subject_id_idx" ON "commerce_auth"."portal_auth_audit_event" ("provider_subject_id");