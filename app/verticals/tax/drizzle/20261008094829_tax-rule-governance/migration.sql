CREATE SCHEMA "tax";
--> statement-breakpoint
CREATE TABLE "tax"."tax_fact_authority_contract_revisions" (
	"tax_fact_authority_contract_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"authority_from" timestamp with time zone NOT NULL,
	"authority_to" timestamp with time zone,
	"evidence_source_refs" jsonb NOT NULL,
	"revision_number" integer NOT NULL,
	"semantic_fingerprint" text NOT NULL,
	"system_of_record_ref" text NOT NULL,
	"tax_fact_authority_contract_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"provenance_ref" text NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_fact_authority_revisions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","tax_fact_authority_contract_revision_id"),
	CONSTRAINT "tax_fact_authority_revisions_number_uk" UNIQUE("tenant_id","tax_fact_authority_contract_id","revision_number"),
	CONSTRAINT "tax_fact_authority_revisions_idempotency_uk" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "tax_fact_authority_revisions_number_ck" CHECK ("revision_number" >= 1),
	CONSTRAINT "tax_fact_authority_revisions_period_ck" CHECK ("authority_to" is null or "authority_to" > "authority_from"),
	CONSTRAINT "tax_fact_authority_revisions_evidence_ck" CHECK (jsonb_typeof("evidence_source_refs") = 'array'),
	CONSTRAINT "tax_fact_authority_revisions_system_of_record_ck" CHECK ("system_of_record_ref" = btrim("system_of_record_ref") and length("system_of_record_ref") between 1 and 1000),
	CONSTRAINT "tax_fact_authority_revisions_fingerprint_ck" CHECK ("semantic_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "tax_fact_authority_revisions_provenance_ck" CHECK ("provenance_ref" = btrim("provenance_ref") and length("provenance_ref") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "tax"."tax_fact_authority_contract_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tax"."tax_fact_authority_contracts" (
	"tax_fact_authority_contract_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"fact_family" text NOT NULL,
	"stable_code" text NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"provenance_ref" text NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_fact_authority_contracts_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","tax_fact_authority_contract_id"),
	CONSTRAINT "tax_fact_authority_contracts_code_uk" UNIQUE("tenant_id","legal_entity_id","stable_code"),
	CONSTRAINT "tax_fact_authority_contracts_idempotency_uk" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "tax_fact_authority_contracts_family_ck" CHECK ("fact_family" = 'SELLING_LEGAL_ENTITY_VAT_REGISTRATION'),
	CONSTRAINT "tax_fact_authority_contracts_code_ck" CHECK ("stable_code" ~ '^[a-z][a-z0-9._-]{0,127}$'),
	CONSTRAINT "tax_fact_authority_contracts_provenance_ck" CHECK ("provenance_ref" = btrim("provenance_ref") and length("provenance_ref") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "tax"."tax_fact_authority_contracts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tax"."tax_rule_corrections" (
	"tax_rule_correction_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"confirmed_at" timestamp with time zone NOT NULL,
	"correcting_revision_id" uuid NOT NULL,
	"wrong_revision_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"provenance_ref" text NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_rule_corrections_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","tax_rule_correction_id"),
	CONSTRAINT "tax_rule_corrections_pair_uk" UNIQUE("tenant_id","wrong_revision_id","correcting_revision_id"),
	CONSTRAINT "tax_rule_corrections_idempotency_uk" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "tax_rule_corrections_distinct_ck" CHECK ("wrong_revision_id" <> "correcting_revision_id"),
	CONSTRAINT "tax_rule_corrections_provenance_ck" CHECK ("provenance_ref" = btrim("provenance_ref") and length("provenance_ref") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "tax"."tax_rule_corrections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tax"."tax_rule_revision_end_facts" (
	"tax_rule_revision_end_fact_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ended_effective_to" timestamp with time zone NOT NULL,
	"tax_rule_revision_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"provenance_ref" text NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_rule_revision_end_facts_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","tax_rule_revision_end_fact_id"),
	CONSTRAINT "tax_rule_revision_end_facts_revision_uk" UNIQUE("tenant_id","tax_rule_revision_id"),
	CONSTRAINT "tax_rule_revision_end_facts_idempotency_uk" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "tax_rule_revision_end_facts_provenance_ck" CHECK ("provenance_ref" = btrim("provenance_ref") and length("provenance_ref") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "tax"."tax_rule_revision_end_facts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tax"."tax_rule_revisions" (
	"tax_rule_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"composition_kind" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"jurisdiction" text NOT NULL,
	"rate_percent" text NOT NULL,
	"revision_number" integer NOT NULL,
	"semantic_fingerprint" text NOT NULL,
	"supersedes_revision_id" uuid,
	"tax_classification_code" text NOT NULL,
	"tax_rule_id" uuid NOT NULL,
	"treatment_category" text NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"provenance_ref" text NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_rule_revisions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","tax_rule_revision_id"),
	CONSTRAINT "tax_rule_revisions_rule_number_uk" UNIQUE("tenant_id","tax_rule_id","revision_number"),
	CONSTRAINT "tax_rule_revisions_idempotency_uk" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "tax_rule_revisions_number_ck" CHECK ("revision_number" >= 1),
	CONSTRAINT "tax_rule_revisions_jurisdiction_ck" CHECK ("jurisdiction" = 'CZ_DOMESTIC'),
	CONSTRAINT "tax_rule_revisions_treatment_ck" CHECK ("treatment_category" = 'TAXABLE'),
	CONSTRAINT "tax_rule_revisions_composition_ck" CHECK ("composition_kind" = 'EXCLUSIVE'),
	CONSTRAINT "tax_rule_revisions_rate_ck" CHECK ("rate_percent" ~ '^(0\.[0-9]*[1-9][0-9]*|[1-9][0-9]*(\.[0-9]+)?)$'),
	CONSTRAINT "tax_rule_revisions_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from"),
	CONSTRAINT "tax_rule_revisions_supersedes_ck" CHECK ("supersedes_revision_id" is null or "supersedes_revision_id" <> "tax_rule_revision_id"),
	CONSTRAINT "tax_rule_revisions_classification_ck" CHECK ("tax_classification_code" = btrim("tax_classification_code") and length("tax_classification_code") between 1 and 1000),
	CONSTRAINT "tax_rule_revisions_fingerprint_ck" CHECK ("semantic_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "tax_rule_revisions_provenance_ck" CHECK ("provenance_ref" = btrim("provenance_ref") and length("provenance_ref") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "tax"."tax_rule_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tax"."tax_rules" (
	"tax_rule_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"meaning_kind" text NOT NULL,
	"stable_code" text NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"provenance_ref" text NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_rules_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","tax_rule_id"),
	CONSTRAINT "tax_rules_code_uk" UNIQUE("tenant_id","legal_entity_id","stable_code"),
	CONSTRAINT "tax_rules_idempotency_uk" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "tax_rules_code_ck" CHECK ("stable_code" ~ '^[a-z][a-z0-9._-]{0,127}$'),
	CONSTRAINT "tax_rules_meaning_kind_ck" CHECK ("meaning_kind" = 'VAT_RATE'),
	CONSTRAINT "tax_rules_provenance_ck" CHECK ("provenance_ref" = btrim("provenance_ref") and length("provenance_ref") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "tax"."tax_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "tax_fact_authority_contracts_family_idx" ON "tax"."tax_fact_authority_contracts" ("tenant_id","legal_entity_id","fact_family");--> statement-breakpoint
CREATE INDEX "tax_rule_revisions_predicate_idx" ON "tax"."tax_rule_revisions" ("tenant_id","legal_entity_id","tax_classification_code","jurisdiction");--> statement-breakpoint
ALTER TABLE "tax"."tax_fact_authority_contract_revisions" ADD CONSTRAINT "tax_fact_authority_revisions_contract_fk" FOREIGN KEY ("tenant_id","legal_entity_id","tax_fact_authority_contract_id") REFERENCES "tax"."tax_fact_authority_contracts"("tenant_id","legal_entity_id","tax_fact_authority_contract_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "tax"."tax_rule_corrections" ADD CONSTRAINT "tax_rule_corrections_wrong_fk" FOREIGN KEY ("tenant_id","legal_entity_id","wrong_revision_id") REFERENCES "tax"."tax_rule_revisions"("tenant_id","legal_entity_id","tax_rule_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "tax"."tax_rule_corrections" ADD CONSTRAINT "tax_rule_corrections_correcting_fk" FOREIGN KEY ("tenant_id","legal_entity_id","correcting_revision_id") REFERENCES "tax"."tax_rule_revisions"("tenant_id","legal_entity_id","tax_rule_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "tax"."tax_rule_revision_end_facts" ADD CONSTRAINT "tax_rule_revision_end_facts_revision_fk" FOREIGN KEY ("tenant_id","legal_entity_id","tax_rule_revision_id") REFERENCES "tax"."tax_rule_revisions"("tenant_id","legal_entity_id","tax_rule_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "tax"."tax_rule_revisions" ADD CONSTRAINT "tax_rule_revisions_rule_fk" FOREIGN KEY ("tenant_id","legal_entity_id","tax_rule_id") REFERENCES "tax"."tax_rules"("tenant_id","legal_entity_id","tax_rule_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "tax"."tax_rule_revisions" ADD CONSTRAINT "tax_rule_revisions_supersedes_fk" FOREIGN KEY ("tenant_id","legal_entity_id","supersedes_revision_id") REFERENCES "tax"."tax_rule_revisions"("tenant_id","legal_entity_id","tax_rule_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "tax_fact_authority_revisions_scope_select" ON "tax"."tax_fact_authority_contract_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("tax"."tax_fact_authority_contract_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_fact_authority_contract_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_fact_authority_revisions_scope_insert" ON "tax"."tax_fact_authority_contract_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("tax"."tax_fact_authority_contract_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_fact_authority_contract_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_fact_authority_revisions_scope_update" ON "tax"."tax_fact_authority_contract_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("tax"."tax_fact_authority_contract_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_fact_authority_contract_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("tax"."tax_fact_authority_contract_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_fact_authority_contract_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_fact_authority_revisions_scope_delete" ON "tax"."tax_fact_authority_contract_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("tax"."tax_fact_authority_contract_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_fact_authority_contract_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_fact_authority_contracts_scope_select" ON "tax"."tax_fact_authority_contracts" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("tax"."tax_fact_authority_contracts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_fact_authority_contracts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_fact_authority_contracts_scope_insert" ON "tax"."tax_fact_authority_contracts" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("tax"."tax_fact_authority_contracts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_fact_authority_contracts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_fact_authority_contracts_scope_update" ON "tax"."tax_fact_authority_contracts" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("tax"."tax_fact_authority_contracts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_fact_authority_contracts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("tax"."tax_fact_authority_contracts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_fact_authority_contracts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_fact_authority_contracts_scope_delete" ON "tax"."tax_fact_authority_contracts" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("tax"."tax_fact_authority_contracts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_fact_authority_contracts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_rule_corrections_scope_select" ON "tax"."tax_rule_corrections" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("tax"."tax_rule_corrections"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_rule_corrections"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_rule_corrections_scope_insert" ON "tax"."tax_rule_corrections" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("tax"."tax_rule_corrections"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_rule_corrections"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_rule_corrections_scope_update" ON "tax"."tax_rule_corrections" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("tax"."tax_rule_corrections"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_rule_corrections"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("tax"."tax_rule_corrections"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_rule_corrections"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_rule_corrections_scope_delete" ON "tax"."tax_rule_corrections" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("tax"."tax_rule_corrections"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_rule_corrections"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_rule_revision_end_facts_scope_select" ON "tax"."tax_rule_revision_end_facts" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("tax"."tax_rule_revision_end_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_rule_revision_end_facts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_rule_revision_end_facts_scope_insert" ON "tax"."tax_rule_revision_end_facts" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("tax"."tax_rule_revision_end_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_rule_revision_end_facts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_rule_revision_end_facts_scope_update" ON "tax"."tax_rule_revision_end_facts" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("tax"."tax_rule_revision_end_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_rule_revision_end_facts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("tax"."tax_rule_revision_end_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_rule_revision_end_facts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_rule_revision_end_facts_scope_delete" ON "tax"."tax_rule_revision_end_facts" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("tax"."tax_rule_revision_end_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_rule_revision_end_facts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_rule_revisions_scope_select" ON "tax"."tax_rule_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("tax"."tax_rule_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_rule_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_rule_revisions_scope_insert" ON "tax"."tax_rule_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("tax"."tax_rule_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_rule_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_rule_revisions_scope_update" ON "tax"."tax_rule_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("tax"."tax_rule_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_rule_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("tax"."tax_rule_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_rule_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_rule_revisions_scope_delete" ON "tax"."tax_rule_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("tax"."tax_rule_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_rule_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_rules_scope_select" ON "tax"."tax_rules" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("tax"."tax_rules"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_rules"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_rules_scope_insert" ON "tax"."tax_rules" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("tax"."tax_rules"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_rules"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_rules_scope_update" ON "tax"."tax_rules" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("tax"."tax_rules"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_rules"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("tax"."tax_rules"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_rules"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_rules_scope_delete" ON "tax"."tax_rules" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("tax"."tax_rules"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_rules"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "tax"."tax_rules" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tax"."tax_rule_revisions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tax"."tax_rule_revision_end_facts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tax"."tax_rule_corrections" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tax"."tax_fact_authority_contracts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tax"."tax_fact_authority_contract_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION "tax"."reject_immutable_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'tax governance facts are append-only' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "tax_rules_append_only" BEFORE UPDATE OR DELETE ON "tax"."tax_rules" FOR EACH ROW EXECUTE FUNCTION "tax"."reject_immutable_mutation"();
CREATE TRIGGER "tax_rule_revisions_append_only" BEFORE UPDATE OR DELETE ON "tax"."tax_rule_revisions" FOR EACH ROW EXECUTE FUNCTION "tax"."reject_immutable_mutation"();
CREATE TRIGGER "tax_rule_revision_end_facts_append_only" BEFORE UPDATE OR DELETE ON "tax"."tax_rule_revision_end_facts" FOR EACH ROW EXECUTE FUNCTION "tax"."reject_immutable_mutation"();
CREATE TRIGGER "tax_rule_corrections_append_only" BEFORE UPDATE OR DELETE ON "tax"."tax_rule_corrections" FOR EACH ROW EXECUTE FUNCTION "tax"."reject_immutable_mutation"();
CREATE TRIGGER "tax_fact_authority_contracts_append_only" BEFORE UPDATE OR DELETE ON "tax"."tax_fact_authority_contracts" FOR EACH ROW EXECUTE FUNCTION "tax"."reject_immutable_mutation"();
CREATE TRIGGER "tax_fact_authority_contract_revisions_append_only" BEFORE UPDATE OR DELETE ON "tax"."tax_fact_authority_contract_revisions" FOR EACH ROW EXECUTE FUNCTION "tax"."reject_immutable_mutation"();
--> statement-breakpoint
REVOKE ALL ON FUNCTION "tax"."reject_immutable_mutation"() FROM PUBLIC;
GRANT USAGE ON SCHEMA "tax" TO "ontos_runtime";
