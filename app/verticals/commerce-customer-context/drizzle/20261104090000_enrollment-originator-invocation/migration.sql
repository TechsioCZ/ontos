-- The Action invocation that created an Attempt is the originator every later owner call acts for.
-- `last_owner_invocation_id` is overwritten by each owner transition, so it cannot serve that purpose.
-- Attempts created before this cutover have no recorded originator; the continuation fails them closed
-- rather than inventing one.
ALTER TABLE "commerce_customer_context"."portal_enrollment_attempts"
  ADD COLUMN "originator_action_invocation_id" uuid;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "commerce_customer_context"."create_portal_enrollment_attempt"(
  p_tenant_id uuid,
  p_action_invocation_id uuid,
  p_actor_principal_id uuid,
  p_journey text,
  p_intent_key text,
  p_intent_digest text,
  p_invitation_id uuid,
  p_target_legal_entity_id uuid,
  p_target_resource_id text,
  p_composition_revision text
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
  completed_at timestamptz,
  composition_revision text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
DECLARE
  existing_attempt commerce_customer_context.portal_enrollment_attempts%ROWTYPE;
  outcome text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified operation Tenant mismatch' USING ERRCODE = '42501';
  END IF;
  -- Serialize the first create for one exact Tenant/intent key.  The unique constraint remains
  -- the durable fence; this lock makes concurrent equivalent requests converge to EXISTING
  -- instead of surfacing a transient unique-violation as persistence unavailability.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || p_intent_key, 0::bigint));
  SELECT attempt.* INTO existing_attempt
    FROM commerce_customer_context.portal_enrollment_attempts AS attempt
   WHERE attempt.tenant_id = p_tenant_id AND attempt.intent_key = p_intent_key
   FOR UPDATE;
  IF FOUND THEN
    IF existing_attempt.journey IS NOT DISTINCT FROM p_journey
       AND existing_attempt.intent_digest IS NOT DISTINCT FROM p_intent_digest
       AND existing_attempt.invitation_id IS NOT DISTINCT FROM p_invitation_id
       AND existing_attempt.target_legal_entity_id IS NOT DISTINCT FROM p_target_legal_entity_id
       AND existing_attempt.target_resource_id IS NOT DISTINCT FROM p_target_resource_id
       AND existing_attempt.composition_revision IS NOT DISTINCT FROM p_composition_revision THEN
      outcome := 'EXISTING';
    ELSE
      outcome := 'CONFLICT';
    END IF;
    RETURN QUERY SELECT * FROM commerce_customer_context.portal_enrollment_attempt_projection(
      p_tenant_id, existing_attempt.portal_enrollment_attempt_id, outcome, NULL, NULL
    );
    RETURN;
  END IF;
  INSERT INTO commerce_customer_context.portal_enrollment_attempts (
    tenant_id, journey, intent_key, intent_digest, invitation_id, target_legal_entity_id,
    target_resource_id, created_by_principal_id, last_owner_invocation_id, composition_revision,
    originator_action_invocation_id
  ) VALUES (
    p_tenant_id, p_journey, p_intent_key, p_intent_digest, p_invitation_id, p_target_legal_entity_id,
    p_target_resource_id, p_actor_principal_id, p_action_invocation_id, p_composition_revision,
    p_action_invocation_id
  ) RETURNING portal_enrollment_attempts.* INTO existing_attempt;
  RETURN QUERY SELECT * FROM commerce_customer_context.portal_enrollment_attempt_projection(
    p_tenant_id, existing_attempt.portal_enrollment_attempt_id, 'CREATED', NULL, NULL
  );
END;
$function$;
--> statement-breakpoint

CREATE FUNCTION "commerce_customer_context"."read_portal_enrollment_originator"(
  p_tenant_id uuid,
  p_attempt_id uuid
)
RETURNS TABLE (
  originator_action_invocation_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified operation Tenant mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT attempt.originator_action_invocation_id
  FROM commerce_customer_context.portal_enrollment_attempts AS attempt
  WHERE attempt.tenant_id = p_tenant_id
    AND attempt.portal_enrollment_attempt_id = p_attempt_id;
END;
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION "commerce_customer_context"."read_portal_enrollment_originator"(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_portal_enrollment_originator"(uuid, uuid) TO "ontos_runtime";
