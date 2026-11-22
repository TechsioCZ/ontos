CREATE TABLE "commerce_auth"."communication_issuance" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"enrollment_owner_invocation_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"flow" text NOT NULL,
	"issuance_ref" text PRIMARY KEY,
	"issued_at" timestamp with time zone NOT NULL,
	"protected_value" text,
	"provider_subject_id" text NOT NULL,
	"settled_state" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commerce_auth"."communication_request_outbox" (
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issuance_ref" text PRIMARY KEY,
	"last_failure" text,
	"lease_expires_at" timestamp with time zone,
	"lease_owner" text,
	"outcome" text,
	"request" text NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"tenant_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "commerce_auth_communication_issuance_subject_idx" ON "commerce_auth"."communication_issuance" ("flow","provider_subject_id");--> statement-breakpoint
CREATE INDEX "commerce_auth_communication_issuance_expires_at_idx" ON "commerce_auth"."communication_issuance" ("expires_at");--> statement-breakpoint
CREATE INDEX "commerce_auth_communication_request_outbox_due_idx" ON "commerce_auth"."communication_request_outbox" ("state","available_at");--> statement-breakpoint
ALTER TABLE "commerce_auth"."communication_request_outbox" ADD CONSTRAINT "communication_request_outbox_O8a1S9LAKnWn_fkey" FOREIGN KEY ("issuance_ref") REFERENCES "commerce_auth"."communication_issuance"("issuance_ref");