CREATE SCHEMA "finance_billing";
--> statement-breakpoint
CREATE TABLE "finance_billing"."finance_states" (
	"legal_entity_id" uuid,
	"revision" integer DEFAULT 0 NOT NULL,
	"state" jsonb NOT NULL,
	"tenant_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_states_pkey" PRIMARY KEY("tenant_id","legal_entity_id"),
	CONSTRAINT "finance_billing_revision_nonnegative" CHECK ("revision" >= 0),
	CONSTRAINT "finance_billing_state_object" CHECK (jsonb_typeof("state") = 'object')
);
--> statement-breakpoint
ALTER TABLE "finance_billing"."finance_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_billing"."gateway_assertion_redemptions" (
	"audience" text,
	"expires_at" timestamp with time zone NOT NULL,
	"issuer" text,
	"jti" text,
	CONSTRAINT "gateway_assertion_redemptions_pkey" PRIMARY KEY("issuer","audience","jti")
);
--> statement-breakpoint
CREATE INDEX "finance_billing_redemption_expiry" ON "finance_billing"."gateway_assertion_redemptions" ("expires_at");--> statement-breakpoint
CREATE POLICY "finance_billing_scope_select" ON "finance_billing"."finance_states" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("finance_billing"."finance_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "finance_billing"."finance_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_billing_scope_insert" ON "finance_billing"."finance_states" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("finance_billing"."finance_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "finance_billing"."finance_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_billing_scope_update" ON "finance_billing"."finance_states" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("finance_billing"."finance_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "finance_billing"."finance_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("finance_billing"."finance_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "finance_billing"."finance_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_billing_scope_delete" ON "finance_billing"."finance_states" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("finance_billing"."finance_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "finance_billing"."finance_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "finance_billing"."finance_states" FORCE ROW LEVEL SECURITY;
