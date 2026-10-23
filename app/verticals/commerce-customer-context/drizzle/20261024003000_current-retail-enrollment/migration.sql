CREATE FUNCTION commerce_customer_context.read_current_retail_enrollment(
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
  -- The provider subject is proved by this request's live, verified session, never by email.
  -- Return every exact match; the owner refuses ambiguity rather than selecting an arbitrary row.
  RETURN QUERY SELECT attempt.portal_enrollment_attempt_id
    FROM commerce_customer_context.portal_enrollment_attempts attempt
    WHERE attempt.tenant_id = p_tenant_id
      AND attempt.target_legal_entity_id = p_legal_entity_id
      AND attempt.created_by_principal_id = p_creator_id
      AND attempt.journey = 'RETAIL_SELF_ENROLLMENT'
      AND attempt.authentication_namespace_id = p_namespace
      AND attempt.subject_type = p_subject_type
      AND attempt.provider_subject_id = p_provider_subject_id;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.read_current_retail_enrollment(uuid, uuid, uuid, text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.read_current_retail_enrollment(uuid, uuid, uuid, text, text, text) TO ontos_runtime;
