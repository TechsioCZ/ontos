CREATE TABLE "tax"."tax_source_assertions" (
	"tax_source_assertion_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"authority_contract_revision_id" uuid,
	"authority_role" text NOT NULL,
	"delivery_ref" text,
	"eligibility" text NOT NULL,
	"fact_family" text NOT NULL,
	"issued_at" timestamp with time zone,
	"jurisdiction" text NOT NULL,
	"observed_at" timestamp with time zone,
	"registration_meaning" text NOT NULL,
	"semantic_fingerprint" text NOT NULL,
	"source_assertion_key" text NOT NULL,
	"source_record_ref" text NOT NULL,
	"source_ref" text NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"provenance_ref" text NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_source_assertions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","tax_source_assertion_id"),
	CONSTRAINT "tax_source_assertions_key_uk" UNIQUE("tenant_id","legal_entity_id","source_ref","source_assertion_key"),
	CONSTRAINT "tax_source_assertions_idempotency_uk" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "tax_source_assertions_family_ck" CHECK ("fact_family" = 'SELLING_LEGAL_ENTITY_VAT_REGISTRATION'),
	CONSTRAINT "tax_source_assertions_jurisdiction_ck" CHECK ("jurisdiction" = 'CZ_DOMESTIC'),
	CONSTRAINT "tax_source_assertions_meaning_ck" CHECK ("registration_meaning" in ('REGISTERED', 'ENDED', 'NON_REGISTERED')),
	CONSTRAINT "tax_source_assertions_eligibility_ck" CHECK ("eligibility" in ('ELIGIBLE', 'VALIDITY_UNKNOWN')),
	CONSTRAINT "tax_source_assertions_role_ck" CHECK ("authority_role" in ('SYSTEM_OF_RECORD', 'EVIDENCE', 'NONE')),
	CONSTRAINT "tax_source_assertions_validity_ck" CHECK ("valid_from" is null or "valid_to" is null or "valid_to" > "valid_from"),
	CONSTRAINT "tax_source_assertions_source_ck" CHECK ("source_ref" = btrim("source_ref") and length("source_ref") between 1 and 300),
	CONSTRAINT "tax_source_assertions_record_ck" CHECK ("source_record_ref" = btrim("source_record_ref") and length("source_record_ref") between 1 and 300),
	CONSTRAINT "tax_source_assertions_key_ck" CHECK ("source_assertion_key" = btrim("source_assertion_key") and length("source_assertion_key") between 1 and 300),
	CONSTRAINT "tax_source_assertions_delivery_ck" CHECK ("delivery_ref" is null or ("delivery_ref" = btrim("delivery_ref") and length("delivery_ref") between 1 and 300)),
	CONSTRAINT "tax_source_assertions_fingerprint_ck" CHECK ("semantic_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "tax_source_assertions_provenance_ck" CHECK ("provenance_ref" = btrim("provenance_ref") and length("provenance_ref") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "tax"."tax_source_assertions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tax"."tax_source_conflicts" (
	"tax_source_conflict_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conflict_kind" text NOT NULL,
	"detail" jsonb NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"fact_family" text NOT NULL,
	"related_assertion_id" uuid,
	"status" text NOT NULL,
	"subject_assertion_id" uuid,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"provenance_ref" text NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_source_conflicts_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","tax_source_conflict_id"),
	CONSTRAINT "tax_source_conflicts_idempotency_uk" UNIQUE NULLS NOT DISTINCT("tenant_id","idempotency_key","conflict_kind","related_assertion_id"),
	CONSTRAINT "tax_source_conflicts_family_ck" CHECK ("fact_family" = 'SELLING_LEGAL_ENTITY_VAT_REGISTRATION'),
	CONSTRAINT "tax_source_conflicts_kind_ck" CHECK ("conflict_kind" in ('ASSERTION_INTEGRITY', 'EVIDENCE_DISAGREEMENT', 'INCOMPATIBLE_AUTHORITATIVE_ASSERTIONS', 'AUTHORITY_CONFIGURATION')),
	CONSTRAINT "tax_source_conflicts_status_ck" CHECK ("status" = 'OPEN'),
	CONSTRAINT "tax_source_conflicts_detail_ck" CHECK (jsonb_typeof("detail") = 'object'),
	CONSTRAINT "tax_source_conflicts_distinct_ck" CHECK ("related_assertion_id" is null or "subject_assertion_id" is distinct from "related_assertion_id"),
	CONSTRAINT "tax_source_conflicts_provenance_ck" CHECK ("provenance_ref" = btrim("provenance_ref") and length("provenance_ref") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "tax"."tax_source_conflicts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "tax_source_assertions_family_idx" ON "tax"."tax_source_assertions" ("tenant_id","legal_entity_id","fact_family","source_ref");--> statement-breakpoint
CREATE INDEX "tax_source_conflicts_family_idx" ON "tax"."tax_source_conflicts" ("tenant_id","legal_entity_id","fact_family");--> statement-breakpoint
ALTER TABLE "tax"."tax_source_assertions" ADD CONSTRAINT "tax_source_assertions_authority_fk" FOREIGN KEY ("tenant_id","legal_entity_id","authority_contract_revision_id") REFERENCES "tax"."tax_fact_authority_contract_revisions"("tenant_id","legal_entity_id","tax_fact_authority_contract_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "tax"."tax_source_conflicts" ADD CONSTRAINT "tax_source_conflicts_subject_fk" FOREIGN KEY ("tenant_id","legal_entity_id","subject_assertion_id") REFERENCES "tax"."tax_source_assertions"("tenant_id","legal_entity_id","tax_source_assertion_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "tax"."tax_source_conflicts" ADD CONSTRAINT "tax_source_conflicts_related_fk" FOREIGN KEY ("tenant_id","legal_entity_id","related_assertion_id") REFERENCES "tax"."tax_source_assertions"("tenant_id","legal_entity_id","tax_source_assertion_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "tax_source_assertions_scope_select" ON "tax"."tax_source_assertions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("tax"."tax_source_assertions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_source_assertions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_source_assertions_scope_insert" ON "tax"."tax_source_assertions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("tax"."tax_source_assertions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_source_assertions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_source_assertions_scope_update" ON "tax"."tax_source_assertions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("tax"."tax_source_assertions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_source_assertions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("tax"."tax_source_assertions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_source_assertions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_source_assertions_scope_delete" ON "tax"."tax_source_assertions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("tax"."tax_source_assertions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_source_assertions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_source_conflicts_scope_select" ON "tax"."tax_source_conflicts" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("tax"."tax_source_conflicts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_source_conflicts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_source_conflicts_scope_insert" ON "tax"."tax_source_conflicts" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("tax"."tax_source_conflicts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_source_conflicts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_source_conflicts_scope_update" ON "tax"."tax_source_conflicts" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("tax"."tax_source_conflicts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_source_conflicts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("tax"."tax_source_conflicts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_source_conflicts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_source_conflicts_scope_delete" ON "tax"."tax_source_conflicts" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("tax"."tax_source_conflicts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_source_conflicts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "tax"."tax_source_assertions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tax"."tax_source_conflicts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "tax_source_assertions_append_only" BEFORE UPDATE OR DELETE ON "tax"."tax_source_assertions" FOR EACH ROW EXECUTE FUNCTION "tax"."reject_immutable_mutation"();
CREATE TRIGGER "tax_source_conflicts_append_only" BEFORE UPDATE OR DELETE ON "tax"."tax_source_conflicts" FOR EACH ROW EXECUTE FUNCTION "tax"."reject_immutable_mutation"();
--> statement-breakpoint
REVOKE ALL ON FUNCTION "tax"."reject_immutable_mutation"() FROM PUBLIC;
GRANT USAGE ON SCHEMA "tax" TO "ontos_runtime";
