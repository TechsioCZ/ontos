-- `read_portal_enrollment_attempt` and `read_portal_enrollment_owner_operation` never compared
-- `p_tenant_id` with the verified Tenant scope, unlike every mutation routine on this Attempt. A
-- runtime transaction scoped to Tenant A could pass Tenant B as `p_tenant_id` and read Tenant B's
-- row. The sweeper always re-enters an Attempt's own Tenant scope before calling either read, so
-- the mutation routines' equality guard applies unchanged here.
CREATE OR REPLACE FUNCTION "commerce_customer_context"."read_portal_enrollment_attempt"(
  p_tenant_id uuid,
  p_attempt_id uuid
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
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified operation Tenant mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT * FROM commerce_customer_context.portal_enrollment_attempt_projection(
    p_tenant_id, p_attempt_id, 'READ', NULL, NULL
  );
END;
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "commerce_customer_context"."read_portal_enrollment_owner_operation"(
  p_tenant_id uuid,
  p_attempt_id uuid,
  p_owner_module_key text,
  p_transition_key text
)
RETURNS TABLE (
  portal_enrollment_owner_operation_id uuid,
  tenant_id uuid,
  portal_enrollment_attempt_id uuid,
  owner_module_key text,
  transition_key text,
  owner_invocation_id uuid,
  request_digest text,
  required boolean,
  status text,
  revision integer,
  result_reference text,
  reconciliation_ref uuid,
  result_digest text,
  outcome_code text,
  failure_code text,
  failure_reason text,
  actor_principal_id uuid,
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  operation_outcome text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $function$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified operation Tenant mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT
    operation.portal_enrollment_owner_operation_id,
    operation.tenant_id,
    operation.portal_enrollment_attempt_id,
    operation.owner_module_key,
    operation.transition_key,
    operation.owner_invocation_id,
    operation.request_digest,
    operation.required,
    operation.status,
    operation.revision,
    operation.result_reference,
    operation.reconciliation_ref,
    operation.result_digest,
    operation.outcome_code,
    operation.failure_code,
    operation.failure_reason,
    operation.actor_principal_id,
    operation.lease_owner,
    operation.lease_token,
    operation.lease_expires_at,
    operation.completed_at,
    operation.created_at,
    operation.updated_at,
    'FOUND'::text
  FROM commerce_customer_context.portal_enrollment_owner_operations AS operation
  WHERE operation.tenant_id = p_tenant_id
    AND operation.portal_enrollment_attempt_id = p_attempt_id
    AND operation.owner_module_key = p_owner_module_key
    AND operation.transition_key = p_transition_key;
END;
$function$;
--> statement-breakpoint
