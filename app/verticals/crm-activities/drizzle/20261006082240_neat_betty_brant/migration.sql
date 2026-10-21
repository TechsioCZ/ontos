CREATE SCHEMA "crm_activities";
--> statement-breakpoint
CREATE TABLE "crm_activities"."gateway_assertion_redemptions" (
	"audience" text,
	"expires_at" timestamp with time zone NOT NULL,
	"issuer" text,
	"jti" text,
	CONSTRAINT "gateway_assertion_redemptions_pkey" PRIMARY KEY("issuer","audience","jti")
);
--> statement-breakpoint
CREATE TABLE "crm_activities"."relationships_states" (
	"legal_entity_id" uuid,
	"revision" integer DEFAULT 0 NOT NULL,
	"state" jsonb NOT NULL,
	"tenant_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relationships_states_pkey" PRIMARY KEY("tenant_id","legal_entity_id"),
	CONSTRAINT "crm_activities_revision_nonnegative" CHECK ("revision" >= 0),
	CONSTRAINT "crm_activities_state_object" CHECK (jsonb_typeof("state") = 'object')
);
--> statement-breakpoint
ALTER TABLE "crm_activities"."relationships_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "crm_activities_redemption_expiry" ON "crm_activities"."gateway_assertion_redemptions" ("expires_at");--> statement-breakpoint
CREATE POLICY "crm_activities_state_scope_select" ON "crm_activities"."relationships_states" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("crm_activities"."relationships_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "crm_activities"."relationships_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "crm_activities_state_scope_insert" ON "crm_activities"."relationships_states" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("crm_activities"."relationships_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "crm_activities"."relationships_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "crm_activities_state_scope_update" ON "crm_activities"."relationships_states" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("crm_activities"."relationships_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "crm_activities"."relationships_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("crm_activities"."relationships_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "crm_activities"."relationships_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "crm_activities_state_scope_delete" ON "crm_activities"."relationships_states" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("crm_activities"."relationships_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "crm_activities"."relationships_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "crm_activities"."relationships_states" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT USAGE ON SCHEMA "crm_activities" TO ontos_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_activities"."relationships_states", "crm_activities"."gateway_assertion_redemptions" TO ontos_runtime;
