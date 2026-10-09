CREATE TABLE "commerce_auth"."recovery_reconciliation" (
	"conflict_class" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"current_provider_subject_id" text,
	"email" text NOT NULL,
	"id" text PRIMARY KEY,
	"operation" text NOT NULL,
	"provider_subject_id" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "commerce_auth_recovery_reconciliation_email_idx" ON "commerce_auth"."recovery_reconciliation" ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_auth_recovery_reconciliation_dedupe_uk" ON "commerce_auth"."recovery_reconciliation" ("operation","provider_subject_id","email","conflict_class");