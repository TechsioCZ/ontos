CREATE TABLE "pricing"."external_price_source_policies" (
	"policy_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"source_authority_ref" text NOT NULL,
	"source_authority_version" text NOT NULL,
	"mapping_contract_ref" text NOT NULL,
	"mapping_contract_version" text NOT NULL,
	"channel_id" text NOT NULL,
	"market_id" text NOT NULL,
	"currency_code" text NOT NULL,
	"unit_id" uuid NOT NULL,
	"unit_quantity" numeric(38,9) NOT NULL,
	"price_group_coverage" text NOT NULL,
	"price_group_id" uuid,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"verification_ref" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_external_price_policies_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","policy_id"),
	CONSTRAINT "pricing_external_price_policies_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from"),
	CONSTRAINT "pricing_external_price_policies_text_ck" CHECK ("source_authority_ref" = btrim("source_authority_ref") and length("source_authority_ref") between 1 and 300 and "source_authority_version" = btrim("source_authority_version") and length("source_authority_version") between 1 and 300 and "mapping_contract_ref" = btrim("mapping_contract_ref") and length("mapping_contract_ref") between 1 and 300 and "mapping_contract_version" = btrim("mapping_contract_version") and length("mapping_contract_version") between 1 and 300 and "verification_ref" = btrim("verification_ref") and length("verification_ref") between 1 and 300),
	CONSTRAINT "pricing_external_price_policies_scope_ck" CHECK ("channel_id" in ('B2C', 'B2B') and "market_id" = btrim("market_id") and length("market_id") between 1 and 300 and "market_id" <> '*' and "currency_code" ~ '^[A-Z]{3}$' and "unit_quantity" > 0),
	CONSTRAINT "pricing_external_price_policies_group_ck" CHECK (("price_group_coverage" = 'PRICE_GROUP' and "price_group_id" is not null) or ("price_group_coverage" in ('NO_GROUP', 'ANY_PRICE_GROUP') and "price_group_id" is null))
);
--> statement-breakpoint
ALTER TABLE "pricing"."external_price_source_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."external_price_source_policy_ends" (
	"tenant_id" uuid,
	"legal_entity_id" uuid,
	"policy_id" uuid,
	"effective_to" timestamp with time zone NOT NULL,
	"verification_ref" text NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_external_price_policy_ends_pk" PRIMARY KEY("tenant_id","legal_entity_id","policy_id"),
	CONSTRAINT "pricing_external_price_policy_ends_text_ck" CHECK ("verification_ref" = btrim("verification_ref") and length("verification_ref") between 1 and 300 and "effective_to" >= "ended_at")
);
--> statement-breakpoint
ALTER TABLE "pricing"."external_price_source_policy_ends" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "pricing_external_price_policies_coverage_idx" ON "pricing"."external_price_source_policies" ("tenant_id","legal_entity_id","channel_id","market_id","currency_code","unit_id","effective_from");--> statement-breakpoint
ALTER TABLE "pricing"."external_price_source_policy_ends" ADD CONSTRAINT "pricing_external_price_policy_ends_policy_fk" FOREIGN KEY ("tenant_id","legal_entity_id","policy_id") REFERENCES "pricing"."external_price_source_policies"("tenant_id","legal_entity_id","policy_id");--> statement-breakpoint
CREATE POLICY "pricing_external_price_policies_scope_select" ON "pricing"."external_price_source_policies" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."external_price_source_policies"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."external_price_source_policies"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_external_price_policies_scope_insert" ON "pricing"."external_price_source_policies" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."external_price_source_policies"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."external_price_source_policies"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_external_price_policies_scope_update" ON "pricing"."external_price_source_policies" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_external_price_policies_scope_delete" ON "pricing"."external_price_source_policies" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);--> statement-breakpoint
CREATE POLICY "pricing_external_price_policy_ends_scope_select" ON "pricing"."external_price_source_policy_ends" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."external_price_source_policy_ends"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."external_price_source_policy_ends"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_external_price_policy_ends_scope_insert" ON "pricing"."external_price_source_policy_ends" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."external_price_source_policy_ends"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."external_price_source_policy_ends"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_external_price_policy_ends_scope_update" ON "pricing"."external_price_source_policy_ends" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_external_price_policy_ends_scope_delete" ON "pricing"."external_price_source_policy_ends" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);