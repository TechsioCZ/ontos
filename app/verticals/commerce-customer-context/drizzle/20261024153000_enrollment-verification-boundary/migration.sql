-- Provider verification parks/resumes an Attempt, never an owner operation. The caller reads
-- current verification for the exact journalled provider invocation before this revision CAS.
CREATE FUNCTION commerce_customer_context.set_portal_enrollment_verification_state(
  p_tenant_id uuid, p_attempt_id uuid, p_expected_revision integer, p_verification_required boolean
) RETURNS TABLE(updated boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
DECLARE
  attempt commerce_customer_context.portal_enrollment_attempts%ROWTYPE;
  next_state text := CASE WHEN p_verification_required THEN 'VERIFICATION_REQUIRED' ELSE 'IN_PROGRESS' END;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified operation Tenant mismatch' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('ontos.application-composition-authority', 0));
  SELECT * INTO attempt FROM commerce_customer_context.portal_enrollment_attempts journal
    WHERE journal.tenant_id = p_tenant_id AND journal.portal_enrollment_attempt_id = p_attempt_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;
  IF nullif(current_setting('ontos.legal_entity_id', true), '') IS NOT NULL
    AND attempt.target_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified operation Legal Entity mismatch' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM core.application_composition_authority authority
    WHERE authority.authority_key = 'active'
      AND authority.revision = coalesce(attempt.continuation_composition_revision, attempt.composition_revision)
      AND authority.phase = 'active' AND authority.valid_until > clock_timestamp()
      AND authority.durable_work_admission = 'open'
  ) THEN
    RAISE EXCEPTION 'Enrollment verification requires the current open active composition' USING ERRCODE = '55000';
  END IF;
  IF p_expected_revision IS NULL OR attempt.revision <> p_expected_revision OR p_verification_required IS NULL
    OR attempt.journey <> 'RETAIL_SELF_ENROLLMENT'
    OR attempt.state NOT IN ('IN_PROGRESS', 'VERIFICATION_REQUIRED')
    OR attempt.authentication_namespace_id IS DISTINCT FROM 'ontos.commerce.portal.better-auth.v1'
    OR attempt.provider_subject_id IS NULL
    OR attempt.lease_token IS NOT NULL OR attempt.lease_expires_at IS NOT NULL
    OR NOT EXISTS (
      SELECT 1 FROM commerce_customer_context.portal_enrollment_owner_operations operation
      WHERE operation.tenant_id = p_tenant_id AND operation.portal_enrollment_attempt_id = p_attempt_id
        AND operation.owner_module_key = 'commerce.portal-auth'
        AND operation.transition_key = 'provider.account.create'
        AND operation.status = 'SUCCEEDED' AND operation.required
    )
    OR EXISTS (
      SELECT 1 FROM commerce_customer_context.portal_enrollment_owner_operations operation
      WHERE operation.tenant_id = p_tenant_id AND operation.portal_enrollment_attempt_id = p_attempt_id
        AND (operation.status IN ('IN_PROGRESS', 'INDETERMINATE', 'RECONCILIATION_REQUIRED')
          OR (operation.status = 'FAILED' AND operation.failure_code = 'owner_reconciliation_required')
          OR operation.lease_token IS NOT NULL OR operation.lease_expires_at IS NOT NULL)
    ) THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;
  IF attempt.state IS DISTINCT FROM next_state THEN
    UPDATE commerce_customer_context.portal_enrollment_attempts journal
      SET state = next_state, revision = journal.revision + 1, updated_at = clock_timestamp()
      WHERE journal.tenant_id = p_tenant_id AND journal.portal_enrollment_attempt_id = p_attempt_id;
  END IF;
  RETURN QUERY SELECT true;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.set_portal_enrollment_verification_state(uuid, uuid, integer, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.set_portal_enrollment_verification_state(uuid, uuid, integer, boolean) TO ontos_runtime;
