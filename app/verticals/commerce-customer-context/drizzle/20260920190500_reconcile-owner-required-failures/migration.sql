-- An owner that answered "reconcile later" (Party match AMBIGUOUS, profile RECONCILE) is journaled as
-- FAILED with failure_code owner_reconciliation_required. That outcome is reconcilable: the owner is
-- re-read and, once it has settled, the transition is recorded and the Attempt advances.
CREATE OR REPLACE FUNCTION "commerce_customer_context"."reconcile_portal_enrollment_outcome"(
  p_tenant_id uuid,
  p_attempt_id uuid,
  p_expected_revision integer,
  p_owner_module_key text,
  p_transition_key text,
  p_owner_invocation_id uuid,
  p_reconciliation_ref uuid,
  p_actor_principal_id uuid,
  p_status text,
  p_outcome_code text,
  p_result_reference text,
  p_result_digest text,
  p_failure_code text,
  p_failure_reason text,
  p_next_state text,
  p_authentication_namespace_id text,
  p_provider_subject_id text
)
RETURNS TABLE (
  portal_enrollment_attempt_id uuid,
  tenant_id uuid,
  journey text,
  intent_key text,
  intent_digest text,
  invitation_id uuid,
  target_legal_entity_id uuid,
  target_resource_id text,
  authentication_namespace_id text,
  subject_type text,
  provider_subject_id text,
  state text,
  revision integer,
  created_by_principal_id uuid,
  last_owner_invocation_id uuid,
  last_failure_code text,
  last_failure_reason text,
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  terminated_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  attempt_outcome text,
  operation_id uuid,
  owner_module_key text,
  transition_key text,
  owner_invocation_id uuid,
  request_digest text,
  required boolean,
  operation_status text,
  operation_revision integer,
  result_reference text,
  reconciliation_ref uuid,
  result_digest text,
  outcome_code text,
  failure_code text,
  failure_reason text,
  operation_actor_principal_id uuid,
  operation_lease_owner text,
  operation_lease_token uuid,
  operation_lease_expires_at timestamptz,
  completed_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $function$
DECLARE
  current_attempt commerce_customer_context.portal_enrollment_attempts%ROWTYPE;
  current_operation commerce_customer_context.portal_enrollment_owner_operations%ROWTYPE;
  now_at timestamptz := statement_timestamp();
  next_state text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified operation Tenant mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_reconciliation_ref IS NULL THEN
    RAISE EXCEPTION 'reconciliation requires an authoritative reference' USING ERRCODE = '22023';
  END IF;
  IF p_authentication_namespace_id IS NOT NULL
     AND p_authentication_namespace_id <> 'ontos.commerce.portal.better-auth.v1' THEN
    RAISE EXCEPTION 'unsupported Commerce authentication namespace' USING ERRCODE = '22023';
  END IF;
  IF p_provider_subject_id IS NOT NULL
     AND length(p_provider_subject_id) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'provider subject is outside the supported range' USING ERRCODE = '22023';
  END IF;
  IF p_status NOT IN ('SUCCEEDED', 'FAILED') THEN
    RAISE EXCEPTION 'reconciliation must resolve to a final owner outcome' USING ERRCODE = '22023';
  END IF;
  IF p_next_state IS NOT NULL
     AND p_next_state NOT IN ('IN_PROGRESS', 'VERIFICATION_REQUIRED', 'COMPLETE', 'RECONCILIATION_REQUIRED') THEN
    RAISE EXCEPTION 'invalid reconciliation next state' USING ERRCODE = '22023';
  END IF;
  SELECT attempt.* INTO current_attempt
    FROM commerce_customer_context.portal_enrollment_attempts AS attempt
   WHERE attempt.tenant_id = p_tenant_id AND attempt.portal_enrollment_attempt_id = p_attempt_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF current_attempt.state IN ('COMPLETE', 'TERMINATED') THEN
    RETURN QUERY SELECT * FROM commerce_customer_context.portal_enrollment_attempt_projection(
      p_tenant_id, p_attempt_id, 'TERMINAL', p_owner_module_key, p_transition_key
    );
    RETURN;
  END IF;
  SELECT operation.* INTO current_operation
    FROM commerce_customer_context.portal_enrollment_owner_operations AS operation
   WHERE operation.tenant_id = p_tenant_id
     AND operation.portal_enrollment_attempt_id = p_attempt_id
     AND operation.owner_module_key = p_owner_module_key
     AND operation.transition_key = p_transition_key
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT * FROM commerce_customer_context.portal_enrollment_attempt_projection(
      p_tenant_id, p_attempt_id, 'NOT_FOUND', p_owner_module_key, p_transition_key
    );
    RETURN;
  END IF;
  IF current_operation.owner_invocation_id IS DISTINCT FROM p_owner_invocation_id
     OR NOT (
       current_operation.status IN ('INDETERMINATE', 'RECONCILIATION_REQUIRED')
       OR (current_operation.status = 'FAILED' AND current_operation.failure_code = 'owner_reconciliation_required')
     )
     OR p_reconciliation_ref = current_operation.owner_invocation_id THEN
    RETURN QUERY SELECT * FROM commerce_customer_context.portal_enrollment_attempt_projection(
      p_tenant_id, p_attempt_id, 'CONFLICT', p_owner_module_key, p_transition_key
    );
    RETURN;
  END IF;
  IF (p_authentication_namespace_id IS NULL) <> (p_provider_subject_id IS NULL)
     OR (current_attempt.authentication_namespace_id IS NOT NULL AND p_authentication_namespace_id IS NOT NULL AND (
       current_attempt.authentication_namespace_id IS DISTINCT FROM p_authentication_namespace_id
       OR current_attempt.provider_subject_id IS DISTINCT FROM p_provider_subject_id
     )) THEN
    RETURN QUERY SELECT * FROM commerce_customer_context.portal_enrollment_attempt_projection(
      p_tenant_id, p_attempt_id, 'SUBJECT_CONFLICT', p_owner_module_key, p_transition_key
    );
    RETURN;
  END IF;
  IF current_attempt.revision <> p_expected_revision THEN
    RETURN QUERY SELECT * FROM commerce_customer_context.portal_enrollment_attempt_projection(
      p_tenant_id, p_attempt_id, 'REVISION_CONFLICT', p_owner_module_key, p_transition_key
    );
    RETURN;
  END IF;
  UPDATE commerce_customer_context.portal_enrollment_owner_operations AS operation
     SET revision = operation.revision + 1,
         status = p_status,
         reconciliation_ref = p_reconciliation_ref,
         result_reference = p_result_reference,
         result_digest = p_result_digest,
         outcome_code = p_outcome_code,
         failure_code = p_failure_code,
         failure_reason = p_failure_reason,
         actor_principal_id = p_actor_principal_id,
         lease_owner = NULL,
         lease_token = NULL,
         lease_expires_at = NULL,
         completed_at = now_at,
         updated_at = now_at
   WHERE operation.tenant_id = p_tenant_id
     AND operation.portal_enrollment_owner_operation_id = current_operation.portal_enrollment_owner_operation_id;
  IF p_authentication_namespace_id IS NOT NULL THEN
    UPDATE commerce_customer_context.portal_enrollment_attempts AS attempt
       SET authentication_namespace_id = p_authentication_namespace_id,
           subject_type = 'user',
           provider_subject_id = p_provider_subject_id
     WHERE attempt.tenant_id = p_tenant_id AND attempt.portal_enrollment_attempt_id = p_attempt_id;
  END IF;
  IF p_next_state = 'RECONCILIATION_REQUIRED'
     OR (p_status = 'FAILED' AND p_failure_code = 'owner_reconciliation_required')
     OR EXISTS (
       SELECT 1 FROM commerce_customer_context.portal_enrollment_owner_operations AS operation
        WHERE operation.tenant_id = p_tenant_id
          AND operation.portal_enrollment_attempt_id = p_attempt_id
          AND operation.status IN ('INDETERMINATE', 'RECONCILIATION_REQUIRED')
     ) THEN
    next_state := 'RECONCILIATION_REQUIRED';
  ELSIF EXISTS (
    SELECT 1 FROM commerce_customer_context.portal_enrollment_owner_operations AS operation
     WHERE operation.tenant_id = p_tenant_id
       AND operation.portal_enrollment_attempt_id = p_attempt_id
       AND operation.required
       AND operation.status <> 'SUCCEEDED'
  ) THEN
    next_state := CASE WHEN p_next_state = 'VERIFICATION_REQUIRED' THEN 'VERIFICATION_REQUIRED' ELSE 'IN_PROGRESS' END;
  ELSIF p_next_state = 'COMPLETE'
    AND EXISTS (
      SELECT 1 FROM commerce_customer_context.portal_enrollment_owner_operations AS operation
       WHERE operation.tenant_id = p_tenant_id
         AND operation.portal_enrollment_attempt_id = p_attempt_id
         AND operation.required
    )
    AND NOT EXISTS (
      SELECT 1 FROM commerce_customer_context.portal_enrollment_owner_operations AS operation
       WHERE operation.tenant_id = p_tenant_id
         AND operation.portal_enrollment_attempt_id = p_attempt_id
         AND operation.required
         AND operation.status <> 'SUCCEEDED'
    ) THEN
    next_state := 'COMPLETE';
  ELSE
    next_state := CASE WHEN p_next_state = 'VERIFICATION_REQUIRED' THEN 'VERIFICATION_REQUIRED' ELSE 'IN_PROGRESS' END;
  END IF;
  UPDATE commerce_customer_context.portal_enrollment_attempts AS attempt
     SET authentication_namespace_id = CASE WHEN p_authentication_namespace_id IS NULL THEN attempt.authentication_namespace_id ELSE p_authentication_namespace_id END,
         subject_type = CASE WHEN p_authentication_namespace_id IS NULL THEN attempt.subject_type ELSE 'user' END,
         provider_subject_id = CASE WHEN p_provider_subject_id IS NULL THEN attempt.provider_subject_id ELSE p_provider_subject_id END,
         state = next_state,
         revision = attempt.revision + 1,
         last_owner_invocation_id = current_operation.owner_invocation_id,
         last_failure_code = CASE WHEN p_status = 'SUCCEEDED' THEN NULL ELSE p_failure_code END,
         last_failure_reason = CASE WHEN p_status = 'SUCCEEDED' THEN NULL ELSE p_failure_reason END,
         lease_owner = NULL,
         lease_token = NULL,
         lease_expires_at = NULL,
         updated_at = now_at
   WHERE attempt.tenant_id = p_tenant_id AND attempt.portal_enrollment_attempt_id = p_attempt_id;
  RETURN QUERY SELECT * FROM commerce_customer_context.portal_enrollment_attempt_projection(
    p_tenant_id, p_attempt_id, 'RECORDED', p_owner_module_key, p_transition_key
  );
END;
$function$;
