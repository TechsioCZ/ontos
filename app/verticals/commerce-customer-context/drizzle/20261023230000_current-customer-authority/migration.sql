DROP FUNCTION commerce_customer_context.read_retail_enrollment_account_party(uuid, uuid, text);
--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.read_retail_enrollment_account_party(
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
  RETURN QUERY SELECT DISTINCT operation.result_reference::uuid, binding.retail_customer_profile_id
    FROM commerce_customer_context.portal_enrollment_attempts attempt
    JOIN commerce_customer_context.portal_enrollment_owner_operations operation
      ON operation.tenant_id = attempt.tenant_id AND operation.portal_enrollment_attempt_id = attempt.portal_enrollment_attempt_id
    JOIN commerce_customer_context.portal_enrollment_owner_operations binding_operation
      ON binding_operation.tenant_id = attempt.tenant_id
      AND binding_operation.portal_enrollment_attempt_id = attempt.portal_enrollment_attempt_id
      AND binding_operation.owner_module_key = 'commerce.customer-context'
      AND binding_operation.transition_key = 'commerce.customer-context.bind-retail-portal-profile'
      AND binding_operation.status = 'SUCCEEDED'
    JOIN commerce_customer_context.retail_portal_profile_bindings binding
      ON binding.tenant_id = attempt.tenant_id AND binding.legal_entity_id = attempt.target_legal_entity_id
      AND binding.retail_portal_profile_binding_id::text = binding_operation.result_reference
      AND binding.lifecycle = 'ACTIVE' AND binding.authorization_state = 'ACTIVE'
      AND binding.authorization_operation = 'grant'
      AND binding.principal_id = p_principal_id
      AND binding.auth_binding_id = p_auth_binding_id
    JOIN commerce_customer_context.portal_enrollment_owner_operations core_activation
      ON core_activation.tenant_id = attempt.tenant_id
      AND core_activation.portal_enrollment_attempt_id = attempt.portal_enrollment_attempt_id
      AND core_activation.owner_module_key = 'core.identity'
      AND core_activation.transition_key = 'core.principal-binding.activate'
      AND core_activation.status = 'SUCCEEDED'
      AND core_activation.result_reference = p_auth_binding_id::text
    JOIN commerce_customer_context.retail_customer_profiles retail
      ON retail.tenant_id = binding.tenant_id AND retail.legal_entity_id = binding.legal_entity_id
      AND retail.retail_customer_profile_id = binding.retail_customer_profile_id
      AND retail.party_resource_id = operation.result_reference
    JOIN commerce_customer_context.customer_profiles profile
      ON profile.tenant_id = retail.tenant_id AND profile.legal_entity_id = retail.legal_entity_id
      AND profile.customer_profile_id = retail.retail_customer_profile_id AND profile.lifecycle = 'ACTIVE'
    WHERE attempt.tenant_id = p_tenant_id AND attempt.target_legal_entity_id = p_legal_entity_id
      AND attempt.authentication_namespace_id = 'ontos.commerce.portal.better-auth.v1'
      AND attempt.provider_subject_id = p_provider_subject_id AND attempt.subject_type = 'user'
      AND attempt.state = 'COMPLETE'
      AND operation.owner_module_key = 'party.registry'
      AND operation.transition_key = 'party.candidate.submit' AND operation.status = 'SUCCEEDED';
END;
$function$;

--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.read_retail_enrollment_account_party(uuid, uuid, text, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.read_retail_enrollment_account_party(uuid, uuid, text, uuid, uuid) TO ontos_runtime;
