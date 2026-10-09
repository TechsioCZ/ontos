CREATE TABLE "pricing"."price_source_assertion_deliveries" (
	"source_assertion_delivery_id" uuid PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"price_id" uuid NOT NULL,
	"source_assertion_id" uuid NOT NULL,
	"delivered_source_assertion_id" uuid NOT NULL,
	"delivered_evidence" jsonb NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"recorded_by_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"imported_at" timestamp with time zone NOT NULL,
	"request_correlation_id" text NOT NULL,
	"stored_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_price_source_deliveries_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","source_assertion_delivery_id"),
	CONSTRAINT "pricing_price_source_deliveries_invocation_uk" UNIQUE("tenant_id","action_invocation_id","price_id"),
	CONSTRAINT "pricing_price_source_deliveries_correlation_ck" CHECK ("request_correlation_id" = btrim("request_correlation_id") and length("request_correlation_id") between 1 and 500),
	CONSTRAINT "pricing_price_source_deliveries_evidence_ck" CHECK (jsonb_typeof("delivered_evidence") = 'object' and ("delivered_evidence"->>'sourceFactFingerprint') ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "pricing"."price_source_assertion_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."price_source_assertions" (
	"source_assertion_id" uuid PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"price_id" uuid NOT NULL,
	"price_revision_id" uuid NOT NULL,
	"source_owner_module_id" text NOT NULL,
	"source_system_ref" text NOT NULL,
	"source_record_ref" text NOT NULL,
	"source_record_version" text NOT NULL,
	"source_change_correlation" text NOT NULL,
	"source_authority_ref" text NOT NULL,
	"source_authority_version" text NOT NULL,
	"mapping_contract_ref" text NOT NULL,
	"mapping_contract_version" text NOT NULL,
	"source_fact_fingerprint" text NOT NULL,
	"original_assertion" jsonb NOT NULL,
	"pre_tax_normalization" jsonb,
	"source_effective_at" timestamp with time zone NOT NULL,
	"owner_business_effective_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"imported_at" timestamp with time zone NOT NULL,
	"lineage_kind" text NOT NULL,
	"corrected_source_assertion_id" uuid,
	"superseded_source_assertion_id" uuid,
	"lineage_acting_principal_id" uuid,
	"lineage_reason" text,
	"action_invocation_id" uuid NOT NULL,
	"recorded_by_principal_id" uuid NOT NULL,
	"request_correlation_id" text NOT NULL,
	"stored_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_price_source_assertions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","price_id","source_assertion_id"),
	CONSTRAINT "pricing_price_source_assertions_owner_fact_uk" UNIQUE("tenant_id","source_owner_module_id","source_system_ref","source_record_ref","source_record_version","source_change_correlation","mapping_contract_ref","mapping_contract_version"),
	CONSTRAINT "pricing_price_source_assertions_invocation_uk" UNIQUE("tenant_id","action_invocation_id","price_id"),
	CONSTRAINT "pricing_price_source_assertions_fingerprint_uk" UNIQUE("tenant_id","source_fact_fingerprint"),
	CONSTRAINT "pricing_price_source_assertions_source_identity_ck" CHECK ("source_owner_module_id" = btrim("source_owner_module_id") and length("source_owner_module_id") between 1 and 300 and "source_owner_module_id" <> '*' and "source_system_ref" = btrim("source_system_ref") and length("source_system_ref") between 1 and 300 and "source_system_ref" <> '*' and "source_record_ref" = btrim("source_record_ref") and length("source_record_ref") between 1 and 300 and "source_record_ref" <> '*' and "source_record_version" = btrim("source_record_version") and length("source_record_version") between 1 and 300 and "source_record_version" <> '*' and "source_change_correlation" = btrim("source_change_correlation") and length("source_change_correlation") between 1 and 300 and "source_change_correlation" <> '*'),
	CONSTRAINT "pricing_price_source_assertions_authority_mapping_ck" CHECK ("source_authority_ref" = btrim("source_authority_ref") and length("source_authority_ref") between 1 and 300 and "source_authority_ref" <> '*' and "source_authority_version" = btrim("source_authority_version") and length("source_authority_version") between 1 and 300 and "source_authority_version" <> '*' and "mapping_contract_ref" = btrim("mapping_contract_ref") and length("mapping_contract_ref") between 1 and 300 and "mapping_contract_ref" <> '*' and "mapping_contract_version" = btrim("mapping_contract_version") and length("mapping_contract_version") between 1 and 300 and "mapping_contract_version" <> '*'),
	CONSTRAINT "pricing_price_source_assertions_original_ck" CHECK (jsonb_typeof("original_assertion") = 'object' and jsonb_typeof("original_assertion"->'monetaryAmount') = 'object' and ("original_assertion"->'monetaryAmount'->>'amount') ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$' and ("original_assertion"->'monetaryAmount'->>'currencyCode') ~ '^[A-Z]{3}$' and "original_assertion"->>'monetaryBoundary' in ('PRE_TAX', 'TAX_INCLUSIVE') and jsonb_typeof("original_assertion"->'unitBasis') = 'object' and ("original_assertion"->'unitBasis'->>'quantity') ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$' and ("original_assertion"->'unitBasis'->>'quantity')::numeric > 0 and jsonb_typeof("original_assertion"->'unitBasis'->'unitRef') = 'object'),
	CONSTRAINT "pricing_price_source_assertions_normalization_ck" CHECK (("original_assertion"->>'monetaryBoundary' = 'PRE_TAX' and "pre_tax_normalization" is null) or ("original_assertion"->>'monetaryBoundary' = 'TAX_INCLUSIVE' and jsonb_typeof("pre_tax_normalization") = 'object' and "pre_tax_normalization"->'authority'->>'sourceAuthorityRef' = "source_authority_ref" and "pre_tax_normalization"->'authority'->>'sourceAuthorityVersion' = "source_authority_version" and ("pre_tax_normalization"->'normalizedMonetaryAmount'->>'amount') ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$' and ("pre_tax_normalization"->'normalizedMonetaryAmount'->>'currencyCode') ~ '^[A-Z]{3}$')),
	CONSTRAINT "pricing_price_source_assertions_lineage_ck" CHECK (("lineage_kind" = 'INITIAL' and "corrected_source_assertion_id" is null and "superseded_source_assertion_id" is null and "lineage_acting_principal_id" is null and "lineage_reason" is null) or ("lineage_kind" = 'CORRECTION' and "corrected_source_assertion_id" is not null and "superseded_source_assertion_id" is null and "lineage_acting_principal_id" is not null and "lineage_reason" = btrim("lineage_reason") and length("lineage_reason") between 1 and 1000) or ("lineage_kind" = 'SUPERSESSION' and "corrected_source_assertion_id" is null and "superseded_source_assertion_id" is not null and "lineage_acting_principal_id" is not null and "lineage_reason" = btrim("lineage_reason") and length("lineage_reason") between 1 and 1000)),
	CONSTRAINT "pricing_price_source_assertions_no_self_lineage_ck" CHECK ("corrected_source_assertion_id" is distinct from "source_assertion_id" and "superseded_source_assertion_id" is distinct from "source_assertion_id"),
	CONSTRAINT "pricing_price_source_assertions_correlation_ck" CHECK ("request_correlation_id" = btrim("request_correlation_id") and length("request_correlation_id") between 1 and 500),
	CONSTRAINT "pricing_price_source_assertions_fingerprint_ck" CHECK ("source_fact_fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "pricing"."price_source_assertions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "pricing_price_source_deliveries_assertion_idx" ON "pricing"."price_source_assertion_deliveries" ("tenant_id","legal_entity_id","price_id","source_assertion_id","stored_at");--> statement-breakpoint
CREATE INDEX "pricing_price_source_assertions_revision_idx" ON "pricing"."price_source_assertions" ("tenant_id","legal_entity_id","price_id","price_revision_id");--> statement-breakpoint
ALTER TABLE "pricing"."price_source_assertion_deliveries" ADD CONSTRAINT "pricing_price_source_deliveries_assertion_fk" FOREIGN KEY ("tenant_id","legal_entity_id","price_id","source_assertion_id") REFERENCES "pricing"."price_source_assertions"("tenant_id","legal_entity_id","price_id","source_assertion_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."price_source_assertions" ADD CONSTRAINT "pricing_price_source_assertions_revision_fk" FOREIGN KEY ("tenant_id","legal_entity_id","price_id","price_revision_id") REFERENCES "pricing"."price_revisions"("tenant_id","legal_entity_id","price_id","price_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."price_source_assertions" ADD CONSTRAINT "pricing_price_source_assertions_corrected_fk" FOREIGN KEY ("tenant_id","legal_entity_id","price_id","corrected_source_assertion_id") REFERENCES "pricing"."price_source_assertions"("tenant_id","legal_entity_id","price_id","source_assertion_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."price_source_assertions" ADD CONSTRAINT "pricing_price_source_assertions_superseded_fk" FOREIGN KEY ("tenant_id","legal_entity_id","price_id","superseded_source_assertion_id") REFERENCES "pricing"."price_source_assertions"("tenant_id","legal_entity_id","price_id","source_assertion_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "pricing_price_source_deliveries_scope_select" ON "pricing"."price_source_assertion_deliveries" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."price_source_assertion_deliveries"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_source_assertion_deliveries"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_price_source_deliveries_scope_insert" ON "pricing"."price_source_assertion_deliveries" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."price_source_assertion_deliveries"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_source_assertion_deliveries"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_price_source_deliveries_scope_update" ON "pricing"."price_source_assertion_deliveries" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_price_source_deliveries_scope_delete" ON "pricing"."price_source_assertion_deliveries" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);--> statement-breakpoint
CREATE POLICY "pricing_price_source_assertions_scope_select" ON "pricing"."price_source_assertions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."price_source_assertions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_source_assertions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_price_source_assertions_scope_insert" ON "pricing"."price_source_assertions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."price_source_assertions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_source_assertions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_price_source_assertions_scope_update" ON "pricing"."price_source_assertions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_price_source_assertions_scope_delete" ON "pricing"."price_source_assertions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);
--> statement-breakpoint
ALTER TABLE pricing.price_source_assertions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pricing.price_source_assertion_deliveries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE pricing.price_source_assertions,
  pricing.price_source_assertion_deliveries
FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE pricing.price_source_assertions,
  pricing.price_source_assertion_deliveries
TO ontos_runtime;
