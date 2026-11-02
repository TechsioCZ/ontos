-- Custom SQL migration file, put your code below! --
CREATE OR REPLACE FUNCTION "commerce_customer_context"."transition_profile"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_profile_id uuid,
  p_profile_kind text,
  p_expected_state text,
  p_expected_revision integer,
  p_target_state text,
  p_effective_at timestamptz,
  p_reason text,
  p_dependencies_satisfied boolean,
  p_reconfirmation_satisfied boolean,
  p_action_invocation_id uuid,
  p_actor_principal_id uuid
) RETURNS TABLE(outcome text, payload jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
DECLARE
  v_profile customer_profiles%ROWTYPE;
  v_canonical_profile_ids uuid[];
  v_resource_type text;
BEGIN
  PERFORM assert_profile_operation_scope(p_tenant_id, p_legal_entity_id);
  IF p_action_invocation_id IS NULL OR p_actor_principal_id IS NULL OR p_effective_at IS NULL
     OR p_dependencies_satisfied IS NULL OR p_reconfirmation_satisfied IS NULL
     OR nullif(btrim(p_reason), '') IS NULL THEN
    RETURN QUERY SELECT 'CURRENT_STATE_CONFLICT', NULL::jsonb;
    RETURN;
  END IF;

  SELECT * INTO v_profile FROM customer_profiles
  WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
    AND customer_profile_id = p_profile_id AND profile_kind = p_profile_kind
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'PROFILE_NOT_FOUND', NULL::jsonb;
    RETURN;
  END IF;
  IF v_profile.lifecycle IS DISTINCT FROM p_expected_state
     OR v_profile.revision IS DISTINCT FROM p_expected_revision THEN
    RETURN QUERY SELECT 'CURRENT_STATE_CONFLICT', NULL::jsonb;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM profile_reconciliation_case_members m
    JOIN profile_reconciliation_cases c USING (tenant_id, legal_entity_id, profile_reconciliation_case_id)
    WHERE m.tenant_id = p_tenant_id AND m.legal_entity_id = p_legal_entity_id
      AND m.customer_profile_id = p_profile_id AND c.lifecycle <> 'COMPLETED'
  ) THEN
    RETURN QUERY SELECT 'PROFILE_RECONCILIATION_REQUIRED', NULL::jsonb;
    RETURN;
  END IF;
  IF NOT ((p_expected_state = 'ACTIVE' AND p_target_state IN ('SUSPENDED','ARCHIVED'))
       OR (p_expected_state = 'SUSPENDED' AND p_target_state IN ('ACTIVE','ARCHIVED'))
       OR (p_expected_state = 'ARCHIVED' AND p_target_state = 'ACTIVE')) THEN
    RETURN QUERY SELECT 'INVALID_LIFECYCLE_TRANSITION', NULL::jsonb;
    RETURN;
  END IF;
  IF p_target_state = 'ACTIVE' AND (NOT p_dependencies_satisfied OR NOT p_reconfirmation_satisfied) THEN
    RETURN QUERY SELECT 'REACTIVATION_RECONFIRMATION_REQUIRED', NULL::jsonb;
    RETURN;
  END IF;

  UPDATE customer_profiles
  SET lifecycle = p_target_state, revision = revision + 1, updated_at = clock_timestamp()
  WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
    AND customer_profile_id = p_profile_id;
  INSERT INTO customer_profile_lifecycle_history(
    tenant_id, legal_entity_id, customer_profile_id, revision, from_lifecycle, to_lifecycle,
    recorded_at, action_invocation_id, actor_principal_id, reason
  ) VALUES (
    p_tenant_id, p_legal_entity_id, p_profile_id, v_profile.revision + 1,
    v_profile.lifecycle, p_target_state, p_effective_at, p_action_invocation_id,
    p_actor_principal_id, btrim(p_reason)
  );

  v_resource_type := CASE p_profile_kind WHEN 'RETAIL'
    THEN 'commerce.customer-context.retail-customer-profile'
    ELSE 'commerce.customer-context.counterparty-purchasing-profile' END;
  RETURN QUERY SELECT
    CASE p_target_state WHEN 'ACTIVE' THEN 'PROFILE_REACTIVATED'
      WHEN 'SUSPENDED' THEN 'PROFILE_SUSPENDED' ELSE 'PROFILE_ARCHIVED' END,
    jsonb_build_object(
      'effectiveAt', to_char(p_effective_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'outcome', CASE p_target_state WHEN 'ACTIVE' THEN 'PROFILE_REACTIVATED'
        WHEN 'SUSPENDED' THEN 'PROFILE_SUSPENDED' ELSE 'PROFILE_ARCHIVED' END,
      'previousState', v_profile.lifecycle,
      'profileRef', jsonb_build_object('kind',p_profile_kind,'moduleId','commerce.customer-context','resourceId',p_profile_id,'resourceType',v_resource_type,'tenantId',p_tenant_id),
      'revision', v_profile.revision + 1,
      'state', p_target_state
    );
END
$routine$;
