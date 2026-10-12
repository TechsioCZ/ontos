CREATE TABLE "party"."privacy_measure_executions" (
	"outcome_id" uuid PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"measure_id" text NOT NULL,
	"task_id" text NOT NULL,
	"owning_capability" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"source_decision_ref" text NOT NULL,
	"source_decision_revision" integer NOT NULL,
	"handoff_fingerprint" text NOT NULL,
	"handoff" jsonb NOT NULL,
	"outcome" jsonb NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "party_privacy_measure_executions_scope_outcome_uk" UNIQUE("tenant_id","legal_entity_id","outcome_id"),
	CONSTRAINT "party_privacy_measure_executions_idempotency_uk" UNIQUE("tenant_id","legal_entity_id","idempotency_key"),
	CONSTRAINT "party_privacy_measure_executions_measure_owner_uk" UNIQUE("tenant_id","legal_entity_id","measure_id","owning_capability"),
	CONSTRAINT "party_privacy_measure_executions_revision_ck" CHECK ("source_decision_revision" > 0),
	CONSTRAINT "party_privacy_measure_executions_handoff_ck" CHECK (jsonb_typeof("handoff") = 'object'),
	CONSTRAINT "party_privacy_measure_executions_outcome_ck" CHECK (jsonb_typeof("outcome") = 'object'),
	CONSTRAINT "party_privacy_measure_executions_fingerprint_ck" CHECK ("handoff_fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "party"."privacy_measure_executions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "party_privacy_measure_executions_scope_select" ON "party"."privacy_measure_executions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("party"."privacy_measure_executions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "party"."privacy_measure_executions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_privacy_measure_executions_scope_insert" ON "party"."privacy_measure_executions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("party"."privacy_measure_executions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "party"."privacy_measure_executions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_privacy_measure_executions_scope_update" ON "party"."privacy_measure_executions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("party"."privacy_measure_executions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "party"."privacy_measure_executions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("party"."privacy_measure_executions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "party"."privacy_measure_executions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_privacy_measure_executions_scope_delete" ON "party"."privacy_measure_executions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("party"."privacy_measure_executions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "party"."privacy_measure_executions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "party"."privacy_measure_executions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "party"."reject_privacy_measure_execution_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, party, pg_temp
AS $routine$
BEGIN
  RAISE EXCEPTION 'Party Registry Privacy Measure execution receipts are immutable'
    USING ERRCODE = '55000';
END
$routine$;
--> statement-breakpoint
CREATE TRIGGER "party_privacy_measure_executions_immutable"
BEFORE UPDATE OR DELETE ON "party"."privacy_measure_executions"
FOR EACH ROW EXECUTE FUNCTION "party"."reject_privacy_measure_execution_mutation"();
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "party"."reject_privacy_measure_execution_mutation"() FROM PUBLIC;
