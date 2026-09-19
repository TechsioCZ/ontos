CREATE TABLE "commerce_auth"."recovery_reset_ledger" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email" text,
	"expires_at" timestamp with time zone NOT NULL,
	"identifier_digest" text PRIMARY KEY,
	"provider_subject_id" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"token_digest" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_auth_recovery_reset_ledger_token_digest_uk" ON "commerce_auth"."recovery_reset_ledger" ("token_digest");--> statement-breakpoint
CREATE INDEX "commerce_auth_recovery_reset_ledger_state_expires_at_idx" ON "commerce_auth"."recovery_reset_ledger" ("state","expires_at");