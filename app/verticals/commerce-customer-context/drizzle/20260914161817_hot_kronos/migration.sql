CREATE TABLE "commerce_customer_context"."privacy_measure_executions" (
	"outcome_id" uuid PRIMARY KEY,
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
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
	CONSTRAINT "ccc_privacy_measure_executions_scope_outcome_uk" UNIQUE("tenant_id","legal_entity_id","outcome_id"),
	CONSTRAINT "ccc_privacy_measure_executions_idempotency_uk" UNIQUE("tenant_id","legal_entity_id","idempotency_key"),
	CONSTRAINT "ccc_privacy_measure_executions_measure_owner_uk" UNIQUE("tenant_id","legal_entity_id","measure_id","owning_capability"),
	CONSTRAINT "ccc_privacy_measure_executions_revision_ck" CHECK ("source_decision_revision" > 0),
	CONSTRAINT "ccc_privacy_measure_executions_handoff_ck" CHECK (jsonb_typeof("handoff") = 'object'),
	CONSTRAINT "ccc_privacy_measure_executions_outcome_ck" CHECK (jsonb_typeof("outcome") = 'object'),
	CONSTRAINT "ccc_privacy_measure_executions_fingerprint_ck" CHECK ("handoff_fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."privacy_measure_executions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "ccc_privacy_measure_executions_scope_select" ON "commerce_customer_context"."privacy_measure_executions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."privacy_measure_executions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."privacy_measure_executions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_privacy_measure_executions_scope_insert" ON "commerce_customer_context"."privacy_measure_executions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."privacy_measure_executions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."privacy_measure_executions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_privacy_measure_executions_scope_update" ON "commerce_customer_context"."privacy_measure_executions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."privacy_measure_executions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."privacy_measure_executions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."privacy_measure_executions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."privacy_measure_executions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_privacy_measure_executions_scope_delete" ON "commerce_customer_context"."privacy_measure_executions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."privacy_measure_executions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."privacy_measure_executions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_privacy_measure_executions_scope_owner_routine" ON "commerce_customer_context"."privacy_measure_executions" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."privacy_measure_executions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."privacy_measure_executions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."privacy_measure_executions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."privacy_measure_executions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."privacy_measure_executions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "commerce_customer_context"."reject_privacy_measure_execution_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
BEGIN
  RAISE EXCEPTION 'Commerce Privacy Measure execution receipts are immutable'
    USING ERRCODE = '55000';
END
$routine$;
--> statement-breakpoint
CREATE TRIGGER "ccc_privacy_measure_executions_immutable"
BEFORE UPDATE OR DELETE ON "commerce_customer_context"."privacy_measure_executions"
FOR EACH ROW EXECUTE FUNCTION "commerce_customer_context"."reject_privacy_measure_execution_mutation"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "commerce_customer_context"."apply_privacy_measure_profile_restriction"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_profile_ids uuid[],
  p_profile_kinds text[],
  p_occurred_at timestamptz,
  p_action_invocation_id uuid,
  p_actor_principal_id uuid
) RETURNS TABLE(status text, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
DECLARE
  v_expected_count integer;
  v_matched_count integer;
BEGIN
  PERFORM assert_profile_operation_scope(p_tenant_id, p_legal_entity_id);
  v_expected_count := cardinality(p_profile_ids);
  IF v_expected_count < 1 OR cardinality(p_profile_kinds) <> v_expected_count
     OR p_occurred_at IS NULL OR p_action_invocation_id IS NULL OR p_actor_principal_id IS NULL THEN
    RETURN QUERY SELECT 'INDETERMINATE', 'The exact Customer Profile scope could not be established';
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(p_profile_kinds) AS requested(kind)
    WHERE requested.kind NOT IN ('RETAIL', 'COUNTERPARTY')
  ) THEN
    RETURN QUERY SELECT 'BUSINESS_REJECTED', 'The requested resource type is not an owned Customer Profile capability';
    RETURN;
  END IF;

  PERFORM 1 FROM customer_profiles profile
  JOIN unnest(p_profile_ids, p_profile_kinds) AS requested(profile_id, profile_kind)
    ON requested.profile_id = profile.customer_profile_id AND requested.profile_kind = profile.profile_kind
  WHERE profile.tenant_id = p_tenant_id AND profile.legal_entity_id = p_legal_entity_id
  ORDER BY profile.customer_profile_id
  FOR UPDATE OF profile;
  SELECT count(*) INTO v_matched_count
  FROM customer_profiles profile
  JOIN unnest(p_profile_ids, p_profile_kinds) AS requested(profile_id, profile_kind)
    ON requested.profile_id = profile.customer_profile_id AND requested.profile_kind = profile.profile_kind
  WHERE profile.tenant_id = p_tenant_id AND profile.legal_entity_id = p_legal_entity_id;
  IF v_matched_count <> v_expected_count THEN
    RETURN QUERY SELECT 'INDETERMINATE', 'At least one scoped Customer Profile could not be authoritatively resolved';
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM customer_profiles profile
    WHERE profile.tenant_id = p_tenant_id AND profile.legal_entity_id = p_legal_entity_id
      AND profile.customer_profile_id = ANY(p_profile_ids) AND profile.lifecycle = 'ARCHIVED'
  ) THEN
    RETURN QUERY SELECT 'BUSINESS_REJECTED', 'An archived Customer Profile cannot be changed to SUSPENDED';
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM profile_reconciliation_case_members member
    JOIN profile_reconciliation_cases reconciliation
      USING (tenant_id, legal_entity_id, profile_reconciliation_case_id)
    WHERE member.tenant_id = p_tenant_id AND member.legal_entity_id = p_legal_entity_id
      AND member.customer_profile_id = ANY(p_profile_ids) AND reconciliation.lifecycle <> 'COMPLETED'
  ) THEN
    RETURN QUERY SELECT 'INDETERMINATE', 'A scoped Customer Profile has unresolved reconciliation state';
    RETURN;
  END IF;

  WITH changed AS (
    UPDATE customer_profiles profile
    SET lifecycle = 'SUSPENDED', revision = profile.revision + 1, updated_at = p_occurred_at
    WHERE profile.tenant_id = p_tenant_id AND profile.legal_entity_id = p_legal_entity_id
      AND profile.customer_profile_id = ANY(p_profile_ids) AND profile.lifecycle = 'ACTIVE'
    RETURNING profile.customer_profile_id, profile.revision
  )
  INSERT INTO customer_profile_lifecycle_history(
    tenant_id, legal_entity_id, customer_profile_id, from_lifecycle, revision, to_lifecycle,
    action_invocation_id, actor_principal_id, reason, recorded_at
  )
  SELECT p_tenant_id, p_legal_entity_id, changed.customer_profile_id, 'ACTIVE', changed.revision,
    'SUSPENDED', p_action_invocation_id, p_actor_principal_id,
    'Privacy Measure processing restriction', p_occurred_at
  FROM changed;
  RETURN QUERY SELECT 'SUCCEEDED', 'Every scoped Customer Profile is suspended from active commerce processing';
END
$routine$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "commerce_customer_context"."read_privacy_measure_execution"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_idempotency_key text
) RETURNS TABLE(action_invocation_id uuid, handoff_fingerprint text, outcome jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
BEGIN
  PERFORM assert_profile_operation_scope(p_tenant_id, p_legal_entity_id);
  RETURN QUERY
  SELECT execution.action_invocation_id, execution.handoff_fingerprint, execution.outcome
  FROM privacy_measure_executions execution
  WHERE execution.tenant_id = p_tenant_id AND execution.legal_entity_id = p_legal_entity_id
    AND execution.idempotency_key = p_idempotency_key
  LIMIT 1;
END
$routine$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "commerce_customer_context"."record_privacy_measure_execution"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_outcome_id uuid,
  p_measure_id text,
  p_task_id text,
  p_owning_capability text,
  p_idempotency_key text,
  p_source_decision_ref text,
  p_source_decision_revision integer,
  p_handoff_fingerprint text,
  p_handoff jsonb,
  p_outcome jsonb,
  p_action_invocation_id uuid,
  p_actor_principal_id uuid,
  p_occurred_at timestamptz
) RETURNS TABLE(action_invocation_id uuid, handoff_fingerprint text, outcome jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
BEGIN
  PERFORM assert_profile_operation_scope(p_tenant_id, p_legal_entity_id);
  INSERT INTO privacy_measure_executions(
    outcome_id, tenant_id, legal_entity_id, measure_id, task_id, owning_capability,
    idempotency_key, source_decision_ref, source_decision_revision, handoff_fingerprint,
    handoff, outcome, action_invocation_id, actor_principal_id, occurred_at, recorded_at
  ) VALUES (
    p_outcome_id, p_tenant_id, p_legal_entity_id, p_measure_id, p_task_id, p_owning_capability,
    p_idempotency_key, p_source_decision_ref, p_source_decision_revision, p_handoff_fingerprint,
    p_handoff, p_outcome, p_action_invocation_id, p_actor_principal_id, p_occurred_at, p_occurred_at
  ) ON CONFLICT (tenant_id, legal_entity_id, idempotency_key) DO NOTHING;
  RETURN QUERY
  SELECT execution.action_invocation_id, execution.handoff_fingerprint, execution.outcome
  FROM privacy_measure_executions execution
  WHERE execution.tenant_id = p_tenant_id AND execution.legal_entity_id = p_legal_entity_id
    AND execution.idempotency_key = p_idempotency_key
  LIMIT 1;
END
$routine$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "commerce_customer_context"."reject_privacy_measure_execution_mutation"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "commerce_customer_context"."apply_privacy_measure_profile_restriction"(uuid,uuid,uuid[],text[],timestamptz,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION "commerce_customer_context"."read_privacy_measure_execution"(uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION "commerce_customer_context"."record_privacy_measure_execution"(uuid,uuid,uuid,text,text,text,text,text,integer,text,jsonb,jsonb,uuid,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."apply_privacy_measure_profile_restriction"(uuid,uuid,uuid[],text[],timestamptz,uuid,uuid) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_privacy_measure_execution"(uuid,uuid,text) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."record_privacy_measure_execution"(uuid,uuid,uuid,text,text,text,text,text,integer,text,jsonb,jsonb,uuid,uuid,timestamptz) TO "ontos_runtime";
