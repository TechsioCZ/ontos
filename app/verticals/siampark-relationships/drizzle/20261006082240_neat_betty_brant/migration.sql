CREATE SCHEMA "siampark_relationships";
--> statement-breakpoint
CREATE TABLE "siampark_relationships"."gateway_assertion_redemptions" (
	"audience" text,
	"expires_at" timestamp with time zone NOT NULL,
	"issuer" text,
	"jti" text,
	CONSTRAINT "gateway_assertion_redemptions_pkey" PRIMARY KEY("issuer","audience","jti")
);
--> statement-breakpoint
CREATE TABLE "siampark_relationships"."relationships_states" (
	"legal_entity_id" uuid,
	"revision" integer DEFAULT 0 NOT NULL,
	"state" jsonb NOT NULL,
	"tenant_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relationships_states_pkey" PRIMARY KEY("tenant_id","legal_entity_id"),
	CONSTRAINT "siampark_relationships_revision_nonnegative" CHECK ("revision" >= 0),
	CONSTRAINT "siampark_relationships_state_object" CHECK (jsonb_typeof("state") = 'object')
);
--> statement-breakpoint
ALTER TABLE "siampark_relationships"."relationships_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "siampark_relationships_redemption_expiry" ON "siampark_relationships"."gateway_assertion_redemptions" ("expires_at");--> statement-breakpoint
CREATE POLICY "siampark_relationships_state_scope_select" ON "siampark_relationships"."relationships_states" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("siampark_relationships"."relationships_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "siampark_relationships"."relationships_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "siampark_relationships_state_scope_insert" ON "siampark_relationships"."relationships_states" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("siampark_relationships"."relationships_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "siampark_relationships"."relationships_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "siampark_relationships_state_scope_update" ON "siampark_relationships"."relationships_states" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("siampark_relationships"."relationships_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "siampark_relationships"."relationships_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("siampark_relationships"."relationships_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "siampark_relationships"."relationships_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "siampark_relationships_state_scope_delete" ON "siampark_relationships"."relationships_states" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("siampark_relationships"."relationships_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "siampark_relationships"."relationships_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "siampark_relationships"."relationships_states" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT USAGE ON SCHEMA "siampark_relationships" TO ontos_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "siampark_relationships"."relationships_states", "siampark_relationships"."gateway_assertion_redemptions" TO ontos_runtime;
