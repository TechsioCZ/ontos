CREATE TABLE "core"."application_composition_authority" (
	"authority_key" text PRIMARY KEY DEFAULT 'active',
	"revision" text NOT NULL,
	"phase" text NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"subscriptions_json" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_application_composition_authority_key_ck" CHECK ("authority_key" = 'active'),
	CONSTRAINT "core_application_composition_authority_revision_ck" CHECK ("revision" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "core_application_composition_authority_phase_ck" CHECK ("phase" in ('active', 'draining'))
);
--> statement-breakpoint
ALTER TABLE "core"."application_composition_authority" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "core_application_composition_authority_select" ON "core"."application_composition_authority" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING (true);--> statement-breakpoint
REVOKE ALL ON TABLE "core"."application_composition_authority" FROM PUBLIC, "ontos_runtime";--> statement-breakpoint
GRANT SELECT ON TABLE "core"."application_composition_authority" TO "ontos_runtime";
