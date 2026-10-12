CREATE SCHEMA "siampark_billing_finance";
--> statement-breakpoint
CREATE TABLE "siampark_billing_finance"."finance_states" (
	"legal_entity_id" uuid,
	"revision" integer DEFAULT 0 NOT NULL,
	"state" jsonb NOT NULL,
	"tenant_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_states_pkey" PRIMARY KEY("tenant_id","legal_entity_id"),
	CONSTRAINT "siampark_finance_revision_nonnegative" CHECK ("revision" >= 0),
	CONSTRAINT "siampark_finance_state_object" CHECK (jsonb_typeof("state") = 'object')
);
--> statement-breakpoint
ALTER TABLE "siampark_billing_finance"."finance_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "siampark_billing_finance"."gateway_assertion_redemptions" (
	"audience" text,
	"expires_at" timestamp with time zone NOT NULL,
	"issuer" text,
	"jti" text,
	CONSTRAINT "gateway_assertion_redemptions_pkey" PRIMARY KEY("issuer","audience","jti")
);
--> statement-breakpoint
CREATE INDEX "siampark_finance_redemption_expiry" ON "siampark_billing_finance"."gateway_assertion_redemptions" ("expires_at");--> statement-breakpoint
CREATE POLICY "siampark_finance_scope_select" ON "siampark_billing_finance"."finance_states" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("siampark_billing_finance"."finance_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "siampark_billing_finance"."finance_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "siampark_finance_scope_insert" ON "siampark_billing_finance"."finance_states" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("siampark_billing_finance"."finance_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "siampark_billing_finance"."finance_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "siampark_finance_scope_update" ON "siampark_billing_finance"."finance_states" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("siampark_billing_finance"."finance_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "siampark_billing_finance"."finance_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("siampark_billing_finance"."finance_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "siampark_billing_finance"."finance_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "siampark_finance_scope_delete" ON "siampark_billing_finance"."finance_states" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("siampark_billing_finance"."finance_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "siampark_billing_finance"."finance_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "siampark_billing_finance"."finance_states" FORCE ROW LEVEL SECURITY;
