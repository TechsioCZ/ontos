CREATE TABLE "tax"."tax_seller_vat_regime_declarations" (
	"tax_seller_vat_regime_declaration_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"idempotency_key" text NOT NULL,
	"intent_fingerprint" text NOT NULL,
	"provenance" text NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone NOT NULL,
	"regime" text NOT NULL,
	"replaces_scheduled" boolean NOT NULL,
	"revision" integer NOT NULL,
	CONSTRAINT "tax_seller_vat_regime_declarations_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","tax_seller_vat_regime_declaration_id"),
	CONSTRAINT "tax_seller_vat_regime_declarations_revision_uk" UNIQUE("tenant_id","legal_entity_id","revision"),
	CONSTRAINT "tax_seller_vat_regime_declarations_idempotency_uk" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "tax_seller_vat_regime_declarations_revision_ck" CHECK ("revision" >= 1),
	CONSTRAINT "tax_seller_vat_regime_declarations_regime_ck" CHECK ("regime" in ('VAT_PAYER', 'NON_PAYER')),
	CONSTRAINT "tax_seller_vat_regime_declarations_provenance_ck" CHECK ("provenance" in ('MERCHANT_DECLARED', 'MIGRATED')),
	CONSTRAINT "tax_seller_vat_regime_declarations_reason_ck" CHECK ("reason" is null or ("reason" = btrim("reason") and length("reason") between 1 and 1000)),
	CONSTRAINT "tax_seller_vat_regime_declarations_backdating_reason_ck" CHECK ("reason" is not null or "effective_from" >= "recorded_at"),
	CONSTRAINT "tax_seller_vat_regime_declarations_fingerprint_ck" CHECK ("intent_fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "tax"."tax_seller_vat_regime_declarations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY "tax_fact_authority_revisions_scope_select" ON "tax"."tax_fact_authority_contract_revisions";--> statement-breakpoint
DROP POLICY "tax_fact_authority_revisions_scope_insert" ON "tax"."tax_fact_authority_contract_revisions";--> statement-breakpoint
DROP POLICY "tax_fact_authority_revisions_scope_update" ON "tax"."tax_fact_authority_contract_revisions";--> statement-breakpoint
DROP POLICY "tax_fact_authority_revisions_scope_delete" ON "tax"."tax_fact_authority_contract_revisions";--> statement-breakpoint
DROP POLICY "tax_fact_authority_contracts_scope_select" ON "tax"."tax_fact_authority_contracts";--> statement-breakpoint
DROP POLICY "tax_fact_authority_contracts_scope_insert" ON "tax"."tax_fact_authority_contracts";--> statement-breakpoint
DROP POLICY "tax_fact_authority_contracts_scope_update" ON "tax"."tax_fact_authority_contracts";--> statement-breakpoint
DROP POLICY "tax_fact_authority_contracts_scope_delete" ON "tax"."tax_fact_authority_contracts";--> statement-breakpoint
DROP POLICY "tax_source_assertions_scope_select" ON "tax"."tax_source_assertions";--> statement-breakpoint
DROP POLICY "tax_source_assertions_scope_insert" ON "tax"."tax_source_assertions";--> statement-breakpoint
DROP POLICY "tax_source_assertions_scope_update" ON "tax"."tax_source_assertions";--> statement-breakpoint
DROP POLICY "tax_source_assertions_scope_delete" ON "tax"."tax_source_assertions";--> statement-breakpoint
DROP POLICY "tax_source_conflicts_scope_select" ON "tax"."tax_source_conflicts";--> statement-breakpoint
DROP POLICY "tax_source_conflicts_scope_insert" ON "tax"."tax_source_conflicts";--> statement-breakpoint
DROP POLICY "tax_source_conflicts_scope_update" ON "tax"."tax_source_conflicts";--> statement-breakpoint
DROP POLICY "tax_source_conflicts_scope_delete" ON "tax"."tax_source_conflicts";--> statement-breakpoint
ALTER TABLE "tax"."tax_fact_authority_contract_revisions" DROP CONSTRAINT "tax_fact_authority_revisions_contract_fk";--> statement-breakpoint
ALTER TABLE "tax"."tax_source_assertions" DROP CONSTRAINT "tax_source_assertions_authority_fk";--> statement-breakpoint
ALTER TABLE "tax"."tax_source_conflicts" DROP CONSTRAINT "tax_source_conflicts_subject_fk";--> statement-breakpoint
ALTER TABLE "tax"."tax_source_conflicts" DROP CONSTRAINT "tax_source_conflicts_related_fk";--> statement-breakpoint
DROP TABLE "tax"."tax_fact_authority_contract_revisions";--> statement-breakpoint
DROP TABLE "tax"."tax_fact_authority_contracts";--> statement-breakpoint
DROP TABLE "tax"."tax_source_assertions";--> statement-breakpoint
DROP TABLE "tax"."tax_source_conflicts";--> statement-breakpoint
CREATE POLICY "tax_seller_vat_regime_declarations_scope_select" ON "tax"."tax_seller_vat_regime_declarations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("tax"."tax_seller_vat_regime_declarations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_seller_vat_regime_declarations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_seller_vat_regime_declarations_scope_insert" ON "tax"."tax_seller_vat_regime_declarations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("tax"."tax_seller_vat_regime_declarations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_seller_vat_regime_declarations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_seller_vat_regime_declarations_scope_update" ON "tax"."tax_seller_vat_regime_declarations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("tax"."tax_seller_vat_regime_declarations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_seller_vat_regime_declarations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("tax"."tax_seller_vat_regime_declarations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_seller_vat_regime_declarations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_seller_vat_regime_declarations_scope_delete" ON "tax"."tax_seller_vat_regime_declarations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("tax"."tax_seller_vat_regime_declarations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_seller_vat_regime_declarations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "tax"."tax_seller_vat_regime_declarations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "tax_seller_vat_regime_declarations_append_only" BEFORE UPDATE OR DELETE ON "tax"."tax_seller_vat_regime_declarations" FOR EACH ROW EXECUTE FUNCTION "tax"."reject_immutable_mutation"();
--> statement-breakpoint
REVOKE ALL ON FUNCTION "tax"."reject_immutable_mutation"() FROM PUBLIC;
GRANT USAGE ON SCHEMA "tax" TO "ontos_runtime";
