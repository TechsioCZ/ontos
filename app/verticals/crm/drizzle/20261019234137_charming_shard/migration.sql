CREATE SCHEMA "demo_crm";
--> statement-breakpoint
CREATE TABLE "demo_crm"."crm_states" (
	"legal_entity_id" uuid,
	"revision" integer DEFAULT 0 NOT NULL,
	"state" jsonb NOT NULL,
	"tenant_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_states_pkey" PRIMARY KEY("tenant_id","legal_entity_id"),
	CONSTRAINT "demo_crm_revision_nonnegative" CHECK ("revision" >= 0),
	CONSTRAINT "demo_crm_state_object" CHECK (jsonb_typeof("state") = 'object')
);
--> statement-breakpoint
ALTER TABLE "demo_crm"."crm_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "demo_crm"."gateway_assertion_redemptions" (
	"audience" text,
	"expires_at" timestamp with time zone NOT NULL,
	"issuer" text,
	"jti" text,
	CONSTRAINT "gateway_assertion_redemptions_pkey" PRIMARY KEY("issuer","audience","jti")
);
--> statement-breakpoint
CREATE INDEX "demo_crm_redemption_expiry" ON "demo_crm"."gateway_assertion_redemptions" ("expires_at");--> statement-breakpoint
CREATE POLICY "demo_crm_state_scope_select" ON "demo_crm"."crm_states" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("demo_crm"."crm_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "demo_crm"."crm_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "demo_crm_state_scope_insert" ON "demo_crm"."crm_states" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("demo_crm"."crm_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "demo_crm"."crm_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "demo_crm_state_scope_update" ON "demo_crm"."crm_states" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("demo_crm"."crm_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "demo_crm"."crm_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("demo_crm"."crm_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "demo_crm"."crm_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "demo_crm_state_scope_delete" ON "demo_crm"."crm_states" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("demo_crm"."crm_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "demo_crm"."crm_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);