CREATE SCHEMA "property_leasing";
--> statement-breakpoint
CREATE TABLE "property_leasing"."gateway_assertion_redemptions" (
	"audience" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"issuer" text NOT NULL,
	"jti" uuid NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "property_leasing_assertion_identity_uk" UNIQUE("issuer","audience","jti")
);
--> statement-breakpoint
CREATE TABLE "property_leasing"."state" (
	"legal_entity_id" uuid,
	"revision" integer DEFAULT 0 NOT NULL,
	"snapshot" jsonb NOT NULL,
	"tenant_id" uuid,
	CONSTRAINT "state_pkey" PRIMARY KEY("tenant_id","legal_entity_id"),
	CONSTRAINT "occupancy_state_revision_ck" CHECK ("revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "property_leasing"."state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "property_leasing_assertion_expiry_idx" ON "property_leasing"."gateway_assertion_redemptions" ("expires_at");--> statement-breakpoint
CREATE POLICY "occupancy_state_scope_select" ON "property_leasing"."state" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("property_leasing"."state"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "property_leasing"."state"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "occupancy_state_scope_insert" ON "property_leasing"."state" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("property_leasing"."state"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "property_leasing"."state"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "occupancy_state_scope_update" ON "property_leasing"."state" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("property_leasing"."state"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "property_leasing"."state"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("property_leasing"."state"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "property_leasing"."state"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "occupancy_state_scope_delete" ON "property_leasing"."state" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("property_leasing"."state"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "property_leasing"."state"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "property_leasing"."state" FORCE ROW LEVEL SECURITY;
