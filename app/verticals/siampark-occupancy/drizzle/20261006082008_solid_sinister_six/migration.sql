CREATE SCHEMA "siampark_occupancy";
--> statement-breakpoint
CREATE TABLE "siampark_occupancy"."gateway_assertion_redemptions" (
	"audience" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"issuer" text NOT NULL,
	"jti" uuid NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "siampark_occupancy_assertion_identity_uk" UNIQUE("issuer","audience","jti")
);
--> statement-breakpoint
CREATE TABLE "siampark_occupancy"."state" (
	"legal_entity_id" uuid,
	"revision" integer DEFAULT 0 NOT NULL,
	"snapshot" jsonb NOT NULL,
	"tenant_id" uuid,
	CONSTRAINT "state_pkey" PRIMARY KEY("tenant_id","legal_entity_id"),
	CONSTRAINT "occupancy_state_revision_ck" CHECK ("revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "siampark_occupancy"."state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "siampark_occupancy_assertion_expiry_idx" ON "siampark_occupancy"."gateway_assertion_redemptions" ("expires_at");--> statement-breakpoint
CREATE POLICY "occupancy_state_scope_select" ON "siampark_occupancy"."state" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("siampark_occupancy"."state"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "siampark_occupancy"."state"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "occupancy_state_scope_insert" ON "siampark_occupancy"."state" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("siampark_occupancy"."state"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "siampark_occupancy"."state"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "occupancy_state_scope_update" ON "siampark_occupancy"."state" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("siampark_occupancy"."state"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "siampark_occupancy"."state"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("siampark_occupancy"."state"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "siampark_occupancy"."state"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "occupancy_state_scope_delete" ON "siampark_occupancy"."state" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("siampark_occupancy"."state"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "siampark_occupancy"."state"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "siampark_occupancy"."state" FORCE ROW LEVEL SECURITY;
