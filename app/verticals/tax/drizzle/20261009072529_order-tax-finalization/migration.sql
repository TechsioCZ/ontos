CREATE TABLE "tax"."tax_order_tax_finalizations" (
	"tax_order_tax_finalization_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"decision_id" text NOT NULL,
	"decomposition_need" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"governing_rule_revisions" jsonb NOT NULL,
	"intent_fingerprint" text NOT NULL,
	"order_commitment_time" timestamp with time zone NOT NULL,
	"outcome" jsonb NOT NULL,
	"submission_ref" text NOT NULL,
	"tax_evaluation_time" timestamp with time zone NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"provenance_ref" text NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_order_tax_finalizations_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","tax_order_tax_finalization_id"),
	CONSTRAINT "tax_order_tax_finalizations_submission_uk" UNIQUE("tenant_id","legal_entity_id","submission_ref"),
	CONSTRAINT "tax_order_tax_finalizations_idempotency_uk" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "tax_order_tax_finalizations_submission_ck" CHECK ("submission_ref" = btrim("submission_ref") and length("submission_ref") between 1 and 300),
	CONSTRAINT "tax_order_tax_finalizations_decision_ck" CHECK ("decision_id" = btrim("decision_id") and length("decision_id") between 1 and 300),
	CONSTRAINT "tax_order_tax_finalizations_intent_ck" CHECK ("intent_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "tax_order_tax_finalizations_decomposition_ck" CHECK ("decomposition_need" in ('NOT_NEEDED', 'PER_TAXABLE_SUPPLY_UNIT')),
	CONSTRAINT "tax_order_tax_finalizations_outcome_ck" CHECK (jsonb_typeof("outcome") = 'object'),
	CONSTRAINT "tax_order_tax_finalizations_evidence_ck" CHECK (jsonb_typeof("evidence") = 'object'),
	CONSTRAINT "tax_order_tax_finalizations_governing_ck" CHECK (jsonb_typeof("governing_rule_revisions") = 'array'),
	CONSTRAINT "tax_order_tax_finalizations_times_ck" CHECK ("order_commitment_time" <= "tax_evaluation_time"),
	CONSTRAINT "tax_order_tax_finalizations_provenance_ck" CHECK ("provenance_ref" = btrim("provenance_ref") and length("provenance_ref") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "tax"."tax_order_tax_finalizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tax_order_tax_finalizations_scope_select" ON "tax"."tax_order_tax_finalizations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("tax"."tax_order_tax_finalizations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_order_tax_finalizations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_order_tax_finalizations_scope_insert" ON "tax"."tax_order_tax_finalizations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("tax"."tax_order_tax_finalizations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_order_tax_finalizations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_order_tax_finalizations_scope_update" ON "tax"."tax_order_tax_finalizations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("tax"."tax_order_tax_finalizations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_order_tax_finalizations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("tax"."tax_order_tax_finalizations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_order_tax_finalizations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_order_tax_finalizations_scope_delete" ON "tax"."tax_order_tax_finalizations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("tax"."tax_order_tax_finalizations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "tax"."tax_order_tax_finalizations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "tax"."tax_order_tax_finalizations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "tax_order_tax_finalizations_append_only" BEFORE UPDATE OR DELETE ON "tax"."tax_order_tax_finalizations" FOR EACH ROW EXECUTE FUNCTION "tax"."reject_immutable_mutation"();
