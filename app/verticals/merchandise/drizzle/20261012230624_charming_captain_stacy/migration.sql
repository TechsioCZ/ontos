CREATE SCHEMA "demo_merchandise";
--> statement-breakpoint
CREATE TABLE "demo_merchandise"."gateway_assertion_redemptions" (
	"audience" text,
	"expires_at" timestamp with time zone NOT NULL,
	"issuer" text,
	"jti" text,
	CONSTRAINT "gateway_assertion_redemptions_pkey" PRIMARY KEY("issuer","audience","jti")
);
--> statement-breakpoint
CREATE TABLE "demo_merchandise"."merchandise_states" (
	"legal_entity_id" uuid,
	"revision" integer DEFAULT 0 NOT NULL,
	"state" jsonb NOT NULL,
	"tenant_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchandise_states_pkey" PRIMARY KEY("tenant_id","legal_entity_id"),
	CONSTRAINT "demo_merchandise_revision_nonnegative" CHECK ("revision" >= 0),
	CONSTRAINT "demo_merchandise_state_object" CHECK (jsonb_typeof("state") = 'object')
);
--> statement-breakpoint
ALTER TABLE "demo_merchandise"."merchandise_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "demo_merchandise_redemption_expiry" ON "demo_merchandise"."gateway_assertion_redemptions" ("expires_at");--> statement-breakpoint
CREATE POLICY "demo_merchandise_state_scope_select" ON "demo_merchandise"."merchandise_states" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("demo_merchandise"."merchandise_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "demo_merchandise"."merchandise_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "demo_merchandise_state_scope_insert" ON "demo_merchandise"."merchandise_states" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("demo_merchandise"."merchandise_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "demo_merchandise"."merchandise_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "demo_merchandise_state_scope_update" ON "demo_merchandise"."merchandise_states" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("demo_merchandise"."merchandise_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "demo_merchandise"."merchandise_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("demo_merchandise"."merchandise_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "demo_merchandise"."merchandise_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "demo_merchandise_state_scope_delete" ON "demo_merchandise"."merchandise_states" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("demo_merchandise"."merchandise_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "demo_merchandise"."merchandise_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "demo_merchandise"."merchandise_states" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT USAGE ON SCHEMA "demo_merchandise" TO ontos_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "demo_merchandise"."merchandise_states", "demo_merchandise"."gateway_assertion_redemptions" TO ontos_runtime;
