ALTER TABLE commerce_customer_context.portal_enrollment_attempts
  ADD COLUMN retail_registration jsonb,
  ADD CONSTRAINT ccc_retail_registration_object_ck CHECK (
    retail_registration IS NULL OR (
      journey = 'RETAIL_SELF_ENROLLMENT' AND jsonb_typeof(retail_registration) = 'object'
      AND length(retail_registration::text) <= 2000
      AND retail_registration ? 'displayName' AND retail_registration ? 'email'
      AND retail_registration - ARRAY['displayName', 'email', 'phone'] = '{}'::jsonb
    )
  );
--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.write_retail_enrollment_registration(
  p_tenant_id uuid, p_attempt_id uuid, p_registration text
) RETURNS TABLE(written boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
DECLARE current_registration jsonb; current_journey text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified operation Tenant mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT attempt.retail_registration, attempt.journey INTO current_registration, current_journey
    FROM commerce_customer_context.portal_enrollment_attempts attempt
    WHERE attempt.tenant_id = p_tenant_id AND attempt.portal_enrollment_attempt_id = p_attempt_id
      AND attempt.target_legal_entity_id = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
    FOR UPDATE;
  IF NOT FOUND OR current_journey <> 'RETAIL_SELF_ENROLLMENT' THEN
    RAISE EXCEPTION 'retail enrollment not found' USING ERRCODE = '23514';
  END IF;
  IF current_registration IS NOT NULL AND current_registration IS DISTINCT FROM p_registration::jsonb THEN
    RAISE EXCEPTION 'retail registration intent is immutable' USING ERRCODE = '23514';
  END IF;
  UPDATE commerce_customer_context.portal_enrollment_attempts SET retail_registration = p_registration::jsonb
    WHERE tenant_id = p_tenant_id AND portal_enrollment_attempt_id = p_attempt_id;
  RETURN QUERY SELECT true;
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.read_retail_enrollment_registration(p_tenant_id uuid, p_attempt_id uuid)
RETURNS TABLE(registration jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified operation Tenant mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT attempt.retail_registration
    FROM commerce_customer_context.portal_enrollment_attempts attempt
    WHERE attempt.tenant_id = p_tenant_id AND attempt.portal_enrollment_attempt_id = p_attempt_id
      AND attempt.target_legal_entity_id = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
      AND attempt.retail_registration IS NOT NULL;
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.read_retail_enrollment_account_party(
  p_tenant_id uuid, p_legal_entity_id uuid, p_provider_subject_id text
) RETURNS TABLE(party_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
     OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified account scope mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT DISTINCT operation.result_reference::uuid
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
REVOKE ALL ON FUNCTION commerce_customer_context.write_retail_enrollment_registration(uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.read_retail_enrollment_registration(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.read_retail_enrollment_account_party(uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.write_retail_enrollment_registration(uuid, uuid, text) TO ontos_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.read_retail_enrollment_registration(uuid, uuid) TO ontos_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.read_retail_enrollment_account_party(uuid, uuid, text) TO ontos_runtime;
