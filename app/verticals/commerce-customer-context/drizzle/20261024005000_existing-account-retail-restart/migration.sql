CREATE FUNCTION commerce_customer_context.read_retail_enrollment_restart_context(
  p_tenant_id uuid, p_legal_entity_id uuid, p_attempt_id uuid, p_as_source boolean
) RETURNS TABLE(context jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
DECLARE
  anchor commerce_customer_context.portal_enrollment_attempts%ROWTYPE;
  previous commerce_customer_context.portal_enrollment_attempts%ROWTYPE;
  operation commerce_customer_context.portal_enrollment_owner_operations%ROWTYPE;
  source_id uuid;
  seen uuid[] := '{}';
  subject_id text;
  party_id text;
  directory_id text;
  profile_id text;
  provider_invocation uuid;
  directory_invocation uuid;
  directory_invocations uuid[] := '{}';
  registration jsonb;
  mask integer;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
     OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified enrollment scope mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO anchor FROM commerce_customer_context.portal_enrollment_attempts
    WHERE tenant_id = p_tenant_id AND target_legal_entity_id = p_legal_entity_id
      AND portal_enrollment_attempt_id = p_attempt_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF p_as_source THEN
    IF anchor.state <> 'FAILED' THEN RETURN; END IF;
    source_id := anchor.portal_enrollment_attempt_id;
  ELSE
    IF anchor.journey <> 'EXISTING_ACCOUNT'
      OR anchor.intent_key !~ '^commerce\.retail-restart:[0-9a-f-]{36}:[0137]$'
      OR split_part(anchor.intent_key, ':', 2) <> anchor.target_resource_id THEN RETURN; END IF;
    source_id := anchor.target_resource_id::uuid;
  END IF;
  SELECT * INTO previous FROM commerce_customer_context.portal_enrollment_attempts
    WHERE tenant_id = p_tenant_id AND portal_enrollment_attempt_id = source_id;
  LOOP
    IF previous.portal_enrollment_attempt_id IS NULL OR previous.state <> 'FAILED'
      OR previous.tenant_id <> anchor.tenant_id OR previous.target_legal_entity_id IS DISTINCT FROM anchor.target_legal_entity_id
      OR previous.created_by_principal_id <> anchor.created_by_principal_id
      OR previous.authentication_namespace_id IS DISTINCT FROM 'ontos.commerce.portal.better-auth.v1'
      OR previous.subject_type IS DISTINCT FROM 'user' OR previous.provider_subject_id IS NULL
      OR previous.portal_enrollment_attempt_id = ANY(seen) OR cardinality(seen) >= 32 THEN RETURN; END IF;
    subject_id := coalesce(subject_id, previous.provider_subject_id);
    IF previous.provider_subject_id <> subject_id
       OR (anchor.provider_subject_id IS NOT NULL AND anchor.provider_subject_id <> subject_id) THEN RETURN; END IF;
    seen := array_append(seen, previous.portal_enrollment_attempt_id);
      SELECT owner_invocation_id INTO directory_invocation
      FROM commerce_customer_context.portal_enrollment_owner_operations
      WHERE tenant_id = p_tenant_id AND portal_enrollment_attempt_id = previous.portal_enrollment_attempt_id
        AND owner_module_key = 'party.registry' AND transition_key = 'party.customer.enroll'
        AND actor_principal_id = anchor.created_by_principal_id AND required AND status IN ('SUCCEEDED', 'FAILED');
    IF directory_invocation IS NOT NULL THEN
      directory_invocations := array_append(directory_invocations, directory_invocation);
    END IF;
    FOR operation IN SELECT * FROM commerce_customer_context.portal_enrollment_owner_operations
      WHERE tenant_id = p_tenant_id AND portal_enrollment_attempt_id = previous.portal_enrollment_attempt_id
        AND status = 'SUCCEEDED' AND required AND completed_at IS NOT NULL
        AND actor_principal_id = anchor.created_by_principal_id
        AND (lease_expires_at IS NULL OR lease_expires_at <= statement_timestamp())
    LOOP
      IF operation.owner_module_key = 'party.registry' AND operation.transition_key = 'party.candidate.submit' THEN
        IF party_id IS NOT NULL AND party_id IS DISTINCT FROM operation.result_reference THEN RETURN; END IF;
        party_id := operation.result_reference;
      ELSIF operation.owner_module_key = 'party.registry' AND operation.transition_key = 'party.customer.enroll' THEN
        IF directory_id IS NOT NULL AND directory_id IS DISTINCT FROM operation.result_reference THEN RETURN; END IF;
        directory_id := operation.result_reference;
      ELSIF operation.owner_module_key = 'commerce.customer-context' AND operation.transition_key = 'commerce.customer-context.ensure-retail-customer-profile' THEN
        IF profile_id IS NOT NULL AND profile_id IS DISTINCT FROM operation.result_reference THEN RETURN; END IF;
        profile_id := operation.result_reference;
      ELSIF operation.owner_module_key = 'commerce.portal-auth' AND operation.transition_key = 'provider.account.create' THEN
        provider_invocation := operation.owner_invocation_id;
      END IF;
    END LOOP;
    IF previous.journey = 'RETAIL_SELF_ENROLLMENT' THEN
      registration := previous.retail_registration;
      EXIT;
    END IF;
    IF previous.journey <> 'EXISTING_ACCOUNT'
       OR previous.intent_key !~ '^commerce\.retail-restart:[0-9a-f-]{36}:[0137]$'
       OR split_part(previous.intent_key, ':', 2) <> previous.target_resource_id THEN RETURN; END IF;
    SELECT * INTO previous FROM commerce_customer_context.portal_enrollment_attempts
      WHERE tenant_id = p_tenant_id AND portal_enrollment_attempt_id = previous.target_resource_id::uuid;
  END LOOP;
  IF provider_invocation IS NULL OR registration IS NULL
     OR (directory_id IS NOT NULL AND directory_id IS DISTINCT FROM party_id)
     OR (profile_id IS NOT NULL AND (party_id IS NULL OR directory_id IS NULL)) THEN RETURN; END IF;
  mask := (CASE WHEN party_id IS NULL THEN 0 ELSE 1 END)
        + (CASE WHEN directory_id IS NULL THEN 0 ELSE 2 END)
        + (CASE WHEN profile_id IS NULL THEN 0 ELSE 4 END);
  IF NOT p_as_source AND split_part(anchor.intent_key, ':', 3)::integer <> mask THEN RETURN; END IF;
  RETURN QUERY SELECT jsonb_strip_nulls(jsonb_build_object(
    'sourceAttemptId', source_id, 'providerOwnerInvocationId', provider_invocation,
    'partyId', party_id, 'directoryPartyId', directory_id, 'profileId', profile_id,
    'directoryOwnerInvocationIds', to_jsonb(directory_invocations),
    'retainedMask', mask, 'registration', registration));
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.read_retail_enrollment_restart_context(uuid, uuid, uuid, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.read_retail_enrollment_restart_context(uuid, uuid, uuid, boolean) TO ontos_runtime;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION commerce_customer_context.read_retail_enrollment_registration(p_tenant_id uuid, p_attempt_id uuid)
RETURNS TABLE(registration jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
DECLARE le uuid := nullif(current_setting('ontos.legal_entity_id', true), '')::uuid;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified operation Tenant mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT attempt.retail_registration
    FROM commerce_customer_context.portal_enrollment_attempts attempt
    WHERE attempt.tenant_id = p_tenant_id AND attempt.portal_enrollment_attempt_id = p_attempt_id
      AND attempt.target_legal_entity_id = le AND attempt.retail_registration IS NOT NULL
  UNION ALL
  SELECT proof.context->'registration' FROM commerce_customer_context.read_retail_enrollment_restart_context(p_tenant_id, le, p_attempt_id, false) proof;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION commerce_customer_context.read_current_retail_enrollment(
  p_tenant_id uuid, p_legal_entity_id uuid, p_creator_id uuid,
  p_namespace text, p_subject_type text, p_provider_subject_id text
) RETURNS TABLE(attempt_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
     OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified enrollment scope mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY WITH RECURSIVE candidates AS (
    SELECT attempt.portal_enrollment_attempt_id id, 0 depth
    FROM commerce_customer_context.portal_enrollment_attempts attempt
    WHERE attempt.tenant_id = p_tenant_id AND attempt.target_legal_entity_id = p_legal_entity_id
      AND attempt.created_by_principal_id = p_creator_id AND attempt.journey = 'RETAIL_SELF_ENROLLMENT'
      AND attempt.authentication_namespace_id = p_namespace AND attempt.subject_type = p_subject_type
      AND attempt.provider_subject_id = p_provider_subject_id
    UNION ALL
    SELECT child.portal_enrollment_attempt_id, parent.depth + 1 FROM candidates parent
    JOIN commerce_customer_context.portal_enrollment_attempts child
      ON child.target_resource_id = parent.id::text AND child.journey = 'EXISTING_ACCOUNT'
      AND child.tenant_id = p_tenant_id AND child.target_legal_entity_id = p_legal_entity_id
      AND child.created_by_principal_id = p_creator_id
      AND child.intent_key LIKE 'commerce.retail-restart:%'
    WHERE parent.depth < 32 AND EXISTS (
      SELECT 1 FROM commerce_customer_context.read_retail_enrollment_restart_context(p_tenant_id, p_legal_entity_id, child.portal_enrollment_attempt_id, false)
    )
  ) SELECT candidate.id FROM candidates candidate
    WHERE NOT EXISTS (SELECT 1 FROM candidates child
      JOIN commerce_customer_context.portal_enrollment_attempts attempt ON attempt.portal_enrollment_attempt_id = child.id
      WHERE attempt.target_resource_id = candidate.id::text);
END;
$function$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION commerce_customer_context.read_retail_enrollment_account_party(
  p_tenant_id uuid, p_legal_entity_id uuid, p_provider_subject_id text, p_principal_id uuid, p_auth_binding_id uuid
) RETURNS TABLE(party_id uuid, profile_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
     OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified account scope mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT DISTINCT coalesce(operation.result_reference, predecessor.context->>'partyId')::uuid, binding.retail_customer_profile_id
    FROM commerce_customer_context.portal_enrollment_attempts attempt
    LEFT JOIN LATERAL commerce_customer_context.read_retail_enrollment_restart_context(p_tenant_id, p_legal_entity_id, attempt.portal_enrollment_attempt_id, false) predecessor ON true
    LEFT JOIN commerce_customer_context.portal_enrollment_owner_operations retention
      ON retention.tenant_id = attempt.tenant_id AND retention.portal_enrollment_attempt_id = attempt.portal_enrollment_attempt_id
      AND retention.owner_module_key = 'commerce.customer-context' AND retention.transition_key = 'commerce.customer-context.retain-enrollment-results'
      AND retention.status = 'SUCCEEDED' AND retention.required AND retention.actor_principal_id = attempt.created_by_principal_id
      AND retention.result_reference = predecessor.context->>'sourceAttemptId'
    LEFT JOIN commerce_customer_context.portal_enrollment_owner_operations operation
      ON operation.tenant_id = attempt.tenant_id AND operation.portal_enrollment_attempt_id = attempt.portal_enrollment_attempt_id
      AND operation.owner_module_key = 'party.registry' AND operation.transition_key = 'party.candidate.submit' AND operation.status = 'SUCCEEDED'
      AND operation.actor_principal_id = attempt.created_by_principal_id
    JOIN commerce_customer_context.portal_enrollment_owner_operations binding_operation
      ON binding_operation.tenant_id = attempt.tenant_id
      AND binding_operation.portal_enrollment_attempt_id = attempt.portal_enrollment_attempt_id
      AND binding_operation.owner_module_key = 'commerce.customer-context'
      AND binding_operation.transition_key = 'commerce.customer-context.bind-retail-portal-profile'
      AND binding_operation.status = 'SUCCEEDED'
      AND binding_operation.actor_principal_id = attempt.created_by_principal_id
    JOIN commerce_customer_context.retail_portal_profile_bindings binding
      ON binding.tenant_id = attempt.tenant_id AND binding.legal_entity_id = attempt.target_legal_entity_id
      AND binding.retail_portal_profile_binding_id::text = binding_operation.result_reference
      AND binding.lifecycle = 'ACTIVE' AND binding.authorization_state = 'ACTIVE'
      AND binding.authorization_operation = 'grant'
      AND binding.principal_id = p_principal_id
      AND binding.auth_binding_id = p_auth_binding_id
    JOIN commerce_customer_context.portal_enrollment_owner_operations provider_operation
      ON provider_operation.tenant_id = attempt.tenant_id
      AND provider_operation.portal_enrollment_attempt_id = attempt.portal_enrollment_attempt_id
      AND provider_operation.owner_module_key = 'commerce.portal-auth'
      AND provider_operation.transition_key = CASE WHEN attempt.journey = 'EXISTING_ACCOUNT' THEN 'provider.account.verify' ELSE 'provider.account.create' END
      AND provider_operation.status = 'SUCCEEDED'
      AND provider_operation.actor_principal_id = attempt.created_by_principal_id
    JOIN commerce_customer_context.retail_customer_profiles retail
      ON retail.tenant_id = binding.tenant_id AND retail.legal_entity_id = binding.legal_entity_id
      AND retail.retail_customer_profile_id = binding.retail_customer_profile_id
      AND retail.party_resource_id = coalesce(operation.result_reference, predecessor.context->>'partyId')
    JOIN commerce_customer_context.customer_profiles profile
      ON profile.tenant_id = retail.tenant_id AND profile.legal_entity_id = retail.legal_entity_id
      AND profile.customer_profile_id = retail.retail_customer_profile_id AND profile.lifecycle = 'ACTIVE'
    WHERE attempt.tenant_id = p_tenant_id AND attempt.target_legal_entity_id = p_legal_entity_id
      AND attempt.authentication_namespace_id = 'ontos.commerce.portal.better-auth.v1'
      AND attempt.provider_subject_id = p_provider_subject_id AND attempt.subject_type = 'user'
      AND attempt.state = 'COMPLETE'
      AND (operation.portal_enrollment_owner_operation_id IS NOT NULL OR
        (retention.portal_enrollment_owner_operation_id IS NOT NULL AND predecessor.context->>'partyId' IS NOT NULL))
      AND (attempt.journey <> 'EXISTING_ACCOUNT' OR (
        retention.portal_enrollment_owner_operation_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM commerce_customer_context.portal_enrollment_owner_operations activation
          WHERE activation.tenant_id = attempt.tenant_id AND activation.portal_enrollment_attempt_id = attempt.portal_enrollment_attempt_id
            AND activation.owner_module_key = 'core.identity' AND activation.transition_key = 'core.principal-binding.activate'
            AND activation.status = 'SUCCEEDED' AND activation.actor_principal_id = attempt.created_by_principal_id
            AND activation.result_reference = p_auth_binding_id::text
        )
      ));
END;
$function$;

--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.read_retail_enrollment_account_party(uuid, uuid, text, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.read_retail_enrollment_account_party(uuid, uuid, text, uuid, uuid) TO ontos_runtime;
