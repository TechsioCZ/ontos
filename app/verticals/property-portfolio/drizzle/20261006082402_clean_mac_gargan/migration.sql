CREATE SCHEMA "property_portfolio";
--> statement-breakpoint
CREATE TABLE "property_portfolio"."gateway_assertion_redemptions" (
	"issuer" text,
	"audience" text,
	"jti" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gateway_assertion_redemptions_pkey" PRIMARY KEY("issuer","audience","jti")
);
--> statement-breakpoint
CREATE TABLE "property_portfolio"."state" (
	"tenant_id" uuid,
	"legal_entity_id" uuid,
	"revision" integer DEFAULT 0 NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "state_pkey" PRIMARY KEY("tenant_id","legal_entity_id"),
	CONSTRAINT "property_revision_nonnegative" CHECK ("revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "property_portfolio"."state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "property_state_select" ON "property_portfolio"."state" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("property_portfolio"."state"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "property_portfolio"."state"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "property_state_insert" ON "property_portfolio"."state" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("property_portfolio"."state"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "property_portfolio"."state"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "property_state_update" ON "property_portfolio"."state" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("property_portfolio"."state"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "property_portfolio"."state"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("property_portfolio"."state"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "property_portfolio"."state"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "property_state_delete" ON "property_portfolio"."state" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("property_portfolio"."state"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "property_portfolio"."state"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "property_portfolio"."state" FORCE ROW LEVEL SECURITY;
