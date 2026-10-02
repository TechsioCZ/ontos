CREATE TABLE "pricing"."external_price_source_authority_grants" (
	"grant_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"source_authority_ref" text NOT NULL,
	"source_authority_version" text NOT NULL,
	"mapping_contract_ref" text NOT NULL,
	"mapping_contract_version" text NOT NULL,
	"exact_identity_key" jsonb NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"verification_ref" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_external_price_authority_identity_uk" UNIQUE("tenant_id","legal_entity_id","source_authority_ref","source_authority_version","mapping_contract_ref","mapping_contract_version","exact_identity_key","effective_from"),
	CONSTRAINT "pricing_external_price_authority_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from"),
	CONSTRAINT "pricing_external_price_authority_text_ck" CHECK ("source_authority_ref" = btrim("source_authority_ref") and length("source_authority_ref") between 1 and 300 and "source_authority_version" = btrim("source_authority_version") and length("source_authority_version") between 1 and 100 and "mapping_contract_ref" = btrim("mapping_contract_ref") and length("mapping_contract_ref") between 1 and 300 and "mapping_contract_version" = btrim("mapping_contract_version") and length("mapping_contract_version") between 1 and 100 and "verification_ref" = btrim("verification_ref") and length("verification_ref") between 1 and 300),
	CONSTRAINT "pricing_external_price_authority_key_scope_ck" CHECK (jsonb_typeof("exact_identity_key") = 'object' and "exact_identity_key"#>>'{catalogSelection,productRef,tenantId}' = "tenant_id"::text and "exact_identity_key"#>>'{catalogSelection,variantRef,tenantId}' = "tenant_id"::text and "exact_identity_key"#>>'{unitBasis,unitRef,tenantId}' = "tenant_id"::text and "exact_identity_key"#>>'{commercialScope,sellingLegalEntityId}' = "legal_entity_id"::text)
);
--> statement-breakpoint
ALTER TABLE "pricing"."external_price_source_authority_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "pricing_external_price_authority_lookup_idx" ON "pricing"."external_price_source_authority_grants" ("tenant_id","legal_entity_id","source_authority_ref","source_authority_version","mapping_contract_ref","mapping_contract_version","effective_from");--> statement-breakpoint
CREATE POLICY "pricing_external_price_authority_scope_select" ON "pricing"."external_price_source_authority_grants" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."external_price_source_authority_grants"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."external_price_source_authority_grants"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_external_price_authority_scope_insert" ON "pricing"."external_price_source_authority_grants" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."external_price_source_authority_grants"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."external_price_source_authority_grants"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_external_price_authority_scope_update" ON "pricing"."external_price_source_authority_grants" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_external_price_authority_scope_delete" ON "pricing"."external_price_source_authority_grants" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);