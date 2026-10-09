CREATE TABLE "assortment"."assortment_decision_evidence" (
	"decision_evidence_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"request_fingerprint" text NOT NULL,
	"outcome" text NOT NULL,
	"request_json" jsonb NOT NULL,
	"decision_json" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assortment_decision_evidence_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","decision_evidence_id"),
	CONSTRAINT "assortment_decision_evidence_fingerprint_ck" CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "assortment_decision_evidence_outcome_ck" CHECK ("outcome" in ('ELIGIBLE', 'INELIGIBLE'))
);
--> statement-breakpoint
ALTER TABLE "assortment"."assortment_decision_evidence" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "assortment"."assortment_decision_evidence" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX "assortment_decision_evidence_lookup_idx"
  ON "assortment"."assortment_decision_evidence" ("tenant_id", "legal_entity_id", "request_fingerprint");
--> statement-breakpoint
CREATE POLICY "assortment_decision_evidence_scope_select"
  ON "assortment"."assortment_decision_evidence" AS PERMISSIVE FOR SELECT TO "ontos_runtime"
  USING ("assortment"."assortment_decision_evidence"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid
    AND "assortment"."assortment_decision_evidence"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "assortment_decision_evidence_scope_insert"
  ON "assortment"."assortment_decision_evidence" AS PERMISSIVE FOR INSERT TO "ontos_runtime"
  WITH CHECK ("assortment"."assortment_decision_evidence"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid
    AND "assortment"."assortment_decision_evidence"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "assortment_decision_evidence_scope_update"
  ON "assortment"."assortment_decision_evidence" AS PERMISSIVE FOR UPDATE TO "ontos_runtime"
  USING ("assortment"."assortment_decision_evidence"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid
    AND "assortment"."assortment_decision_evidence"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid)
  WITH CHECK ("assortment"."assortment_decision_evidence"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid
    AND "assortment"."assortment_decision_evidence"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "assortment_decision_evidence_scope_delete"
  ON "assortment"."assortment_decision_evidence" AS PERMISSIVE FOR DELETE TO "ontos_runtime"
  USING ("assortment"."assortment_decision_evidence"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid
    AND "assortment"."assortment_decision_evidence"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
CREATE FUNCTION "assortment"."reject_decision_evidence_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'assortment decision evidence is append-only' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "assortment_decision_evidence_append_only"
  BEFORE UPDATE OR DELETE ON "assortment"."assortment_decision_evidence"
  FOR EACH ROW EXECUTE FUNCTION "assortment"."reject_decision_evidence_mutation"();
