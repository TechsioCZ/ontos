-- Operator-only exact intent recovery after Core has matched the original caller-owned request hash.
-- ontos_runtime is legacy_shared: settings are forgeable by that role, not an independent operator seal.
-- This grants one new routine capability, not table access or business Principal permissions.
CREATE FUNCTION "commerce_customer_context"."read_original_portal_enrollment"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_creator_principal_id uuid,
  p_intent_key text,
  p_intent_digest text
)
RETURNS TABLE (portal_enrollment_attempt_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
BEGIN
  IF p_tenant_id IS NULL OR p_legal_entity_id IS NULL
    OR p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT attempt.portal_enrollment_attempt_id
  FROM commerce_customer_context.portal_enrollment_attempts AS attempt
  WHERE attempt.tenant_id = p_tenant_id
    AND attempt.intent_key = p_intent_key
    AND attempt.intent_digest = p_intent_digest
    AND attempt.created_by_principal_id = p_creator_principal_id
    AND attempt.target_legal_entity_id = p_legal_entity_id
    AND attempt.journey = 'RETAIL_SELF_ENROLLMENT';
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."read_original_portal_enrollment"(uuid, uuid, uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_original_portal_enrollment"(uuid, uuid, uuid, text, text) TO "ontos_runtime";
