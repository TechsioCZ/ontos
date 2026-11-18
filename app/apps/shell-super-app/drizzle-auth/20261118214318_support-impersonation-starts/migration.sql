CREATE TABLE "auth"."support_impersonation_starts" (
	"tenant_id" uuid NOT NULL,
	"original_principal_id" uuid NOT NULL,
	"action_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "auth_support_impersonation_starts_key_uk" ON "auth"."support_impersonation_starts" ("tenant_id","original_principal_id","action_id");