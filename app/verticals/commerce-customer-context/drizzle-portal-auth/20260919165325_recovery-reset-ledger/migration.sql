CREATE TABLE "commerce_auth"."recovery_reset_ledger" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email" text,
	"expires_at" timestamp with time zone NOT NULL,
	"identifier_digest" text NOT NULL,
	"provider_subject_id" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"token_digest" text PRIMARY KEY,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commerce_auth"."portal_auth_audit_event" ADD COLUMN "correlation_digest" text;--> statement-breakpoint
CREATE INDEX "commerce_auth_recovery_reset_ledger_identifier_digest_idx" ON "commerce_auth"."recovery_reset_ledger" ("identifier_digest");--> statement-breakpoint
CREATE INDEX "commerce_auth_recovery_reset_ledger_state_expires_at_idx" ON "commerce_auth"."recovery_reset_ledger" ("state","expires_at");--> statement-breakpoint
CREATE INDEX "commerce_auth_audit_event_correlation_digest_idx" ON "commerce_auth"."portal_auth_audit_event" ("correlation_digest");