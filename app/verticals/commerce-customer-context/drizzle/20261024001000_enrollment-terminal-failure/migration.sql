-- A terminal owner rejection is failure, never an unresolved retry or a new owner invocation.
ALTER TABLE commerce_customer_context.portal_enrollment_attempts
  DROP CONSTRAINT ccc_portal_enrollment_attempts_state_ck,
  ADD CONSTRAINT ccc_portal_enrollment_attempts_state_ck
    CHECK (state IN ('IN_PROGRESS', 'VERIFICATION_REQUIRED', 'COMPLETE', 'RECONCILIATION_REQUIRED', 'TERMINATED', 'FAILED'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "commerce_customer_context"."guard_enrollment_composition_revision"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
DECLARE
  expected_revision text;
  active_revision text;
  active_phase text;
  active_valid_until timestamptz;
  attempt_state text;
  work_id text;
  pending boolean;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Enrollment release admission requires READ COMMITTED' USING ERRCODE = '55000';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('ontos.application-composition-authority', 0));

  IF TG_TABLE_NAME = 'portal_enrollment_attempts' THEN
    expected_revision := NEW.composition_revision;
    IF TG_OP = 'UPDATE' AND NEW.composition_revision IS DISTINCT FROM OLD.composition_revision THEN
      RAISE EXCEPTION 'An Enrollment Attempt cannot change its original composition revision' USING ERRCODE = '22023';
    END IF;
  ELSE
    SELECT attempt.composition_revision, attempt.state INTO expected_revision, attempt_state
    FROM commerce_customer_context.portal_enrollment_attempts AS attempt
    WHERE attempt.tenant_id = NEW.tenant_id
      AND attempt.portal_enrollment_attempt_id = NEW.portal_enrollment_attempt_id
    FOR UPDATE;
    IF TG_OP = 'UPDATE' AND (
      NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.portal_enrollment_attempt_id IS DISTINCT FROM OLD.portal_enrollment_attempt_id
    ) THEN
      RAISE EXCEPTION 'An Enrollment owner operation cannot change its original Attempt' USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT authority.revision, authority.phase, authority.valid_until
    INTO active_revision, active_phase, active_valid_until
  FROM core.application_composition_authority AS authority
  WHERE authority.authority_key = 'active';

  IF expected_revision IS NULL OR active_revision IS DISTINCT FROM expected_revision
    OR active_valid_until IS NULL OR active_valid_until <= clock_timestamp() THEN
    RAISE EXCEPTION 'The original Enrollment composition revision is no longer admitted' USING ERRCODE = '55000';
  END IF;
  IF active_phase NOT IN ('active', 'draining') THEN
    RAISE EXCEPTION 'Enrollment work cannot mutate a sealed or migrated composition' USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'portal_enrollment_attempts' AND TG_OP = 'INSERT' AND active_phase <> 'active' THEN
    RAISE EXCEPTION 'New Enrollment Attempts cannot start while composition is draining' USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'portal_enrollment_attempts' THEN
    IF TG_OP = 'UPDATE' AND OLD.state = 'FAILED' THEN
      RAISE EXCEPTION 'A failed Enrollment Attempt is immutable' USING ERRCODE = '55000';
    END IF;
    IF NEW.state = 'FAILED' AND NOT EXISTS (
      SELECT 1
      FROM commerce_customer_context.portal_enrollment_owner_operations AS operation
      WHERE operation.tenant_id = NEW.tenant_id
        AND operation.portal_enrollment_attempt_id = NEW.portal_enrollment_attempt_id
        AND operation.required AND operation.status = 'FAILED'
        AND operation.failure_code = 'owner_rejected' AND operation.completed_at IS NOT NULL
        AND operation.owner_invocation_id = NEW.last_owner_invocation_id
        AND coalesce(operation.outcome_code, operation.failure_code) = NEW.last_failure_code
        AND operation.failure_reason IS NOT DISTINCT FROM NEW.last_failure_reason
    ) THEN
      RAISE EXCEPTION 'Enrollment failure requires its original terminal owner rejection' USING ERRCODE = '55000';
    END IF;
    IF NEW.state IN ('COMPLETE', 'TERMINATED', 'FAILED') AND EXISTS (
      SELECT 1
      FROM commerce_customer_context.portal_enrollment_owner_operations AS operation
      WHERE operation.tenant_id = NEW.tenant_id
        AND operation.portal_enrollment_attempt_id = NEW.portal_enrollment_attempt_id
        AND (
          operation.status IN ('IN_PROGRESS', 'INDETERMINATE', 'RECONCILIATION_REQUIRED')
          OR (operation.status = 'FAILED' AND operation.failure_code = 'owner_reconciliation_required')
          OR coalesce(operation.lease_expires_at > clock_timestamp(), false)
        )
    ) THEN
      RAISE EXCEPTION 'Enrollment cannot finish while an owner operation needs reconciliation' USING ERRCODE = '55000';
    END IF;
    work_id := 'enrollment-attempt:' || NEW.tenant_id || ':' || NEW.portal_enrollment_attempt_id;
    pending := NEW.state NOT IN ('COMPLETE', 'TERMINATED', 'FAILED');
    -- The Attempt conservatively accounts for every child owner effect until the native
    -- terminal guard above proves that no unresolved operation or live claim remains.
    -- Closing new durable admission must still allow its existing owner transitions.
    PERFORM core.track_application_composition_durable_work(
      'commerce.customer-context', expected_revision, work_id, pending
    );
  ELSE
    pending := NEW.status IN ('IN_PROGRESS', 'INDETERMINATE', 'RECONCILIATION_REQUIRED')
      OR (NEW.status = 'FAILED' AND NEW.failure_code = 'owner_reconciliation_required')
      OR coalesce(NEW.lease_expires_at > clock_timestamp(), false);
    IF pending AND attempt_state IN ('COMPLETE', 'TERMINATED', 'FAILED') THEN
      RAISE EXCEPTION 'A terminal Enrollment Attempt cannot create unresolved owner work' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.fail_portal_enrollment(
  p_tenant_id uuid, p_attempt_id uuid, p_owner_module_key text, p_transition_key text
) RETURNS TABLE(failed boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
DECLARE
  current_attempt commerce_customer_context.portal_enrollment_attempts%ROWTYPE;
  rejected_operation commerce_customer_context.portal_enrollment_owner_operations%ROWTYPE;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified operation Tenant mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT attempt.* INTO current_attempt
    FROM commerce_customer_context.portal_enrollment_attempts attempt
    WHERE attempt.tenant_id = p_tenant_id AND attempt.portal_enrollment_attempt_id = p_attempt_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;
  IF current_attempt.state IN ('COMPLETE', 'TERMINATED', 'FAILED') THEN
    RETURN QUERY SELECT current_attempt.state = 'FAILED';
    RETURN;
  END IF;
  SELECT operation.* INTO rejected_operation
    FROM commerce_customer_context.portal_enrollment_owner_operations operation
    WHERE operation.tenant_id = p_tenant_id AND operation.portal_enrollment_attempt_id = p_attempt_id
      AND operation.owner_module_key = p_owner_module_key AND operation.transition_key = p_transition_key
      AND operation.required AND operation.status = 'FAILED' AND operation.failure_code = 'owner_rejected'
      AND operation.completed_at IS NOT NULL;
  IF NOT FOUND OR EXISTS (
    SELECT 1 FROM commerce_customer_context.portal_enrollment_owner_operations operation
    WHERE operation.tenant_id = p_tenant_id AND operation.portal_enrollment_attempt_id = p_attempt_id
      AND (operation.status IN ('IN_PROGRESS', 'INDETERMINATE', 'RECONCILIATION_REQUIRED')
        OR (operation.status = 'FAILED' AND operation.failure_code = 'owner_reconciliation_required')
        OR coalesce(operation.lease_expires_at > clock_timestamp(), false))
  ) THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;
  -- The composition fence rechecks every child and releases the original marker in this update.
  UPDATE commerce_customer_context.portal_enrollment_attempts attempt
    SET state = 'FAILED', revision = attempt.revision + 1,
      last_owner_invocation_id = rejected_operation.owner_invocation_id,
      last_failure_code = coalesce(rejected_operation.outcome_code, rejected_operation.failure_code),
      last_failure_reason = rejected_operation.failure_reason,
      lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
    WHERE attempt.tenant_id = p_tenant_id AND attempt.portal_enrollment_attempt_id = p_attempt_id;
  RETURN QUERY SELECT true;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.fail_portal_enrollment(uuid, uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.fail_portal_enrollment(uuid, uuid, text, text) TO ontos_runtime;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION "commerce_customer_context"."claim_portal_enrollment_transition"(
  p_tenant_id uuid,
  p_attempt_id uuid,
  p_expected_revision integer,
  p_worker_id text,
  p_owner_module_key text,
  p_transition_key text,
  p_owner_invocation_id uuid,
  p_request_digest text,
  p_actor_principal_id uuid,
  p_required boolean,
  p_lease_duration_ms integer,
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
  completed_at timestamptz,
  composition_revision text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
DECLARE
  current_attempt commerce_customer_context.portal_enrollment_attempts%ROWTYPE;
  current_operation commerce_customer_context.portal_enrollment_owner_operations%ROWTYPE;
  invocation_operation commerce_customer_context.portal_enrollment_owner_operations%ROWTYPE;
  expired_operation commerce_customer_context.portal_enrollment_owner_operations%ROWTYPE;
  now_at timestamptz := statement_timestamp();
  next_token uuid;
  outcome text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified operation Tenant mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_lease_duration_ms < 1000 OR p_lease_duration_ms > 900000 THEN
    RAISE EXCEPTION 'owner lease duration is outside the supported range' USING ERRCODE = '22023';
  END IF;
  IF p_authentication_namespace_id IS NOT NULL
     AND p_authentication_namespace_id <> 'ontos.commerce.portal.better-auth.v1' THEN
    RAISE EXCEPTION 'unsupported Commerce authentication namespace' USING ERRCODE = '22023';
  END IF;
  IF p_provider_subject_id IS NOT NULL
     AND length(p_provider_subject_id) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'provider subject is outside the supported range' USING ERRCODE = '22023';
  END IF;
  SELECT attempt.* INTO current_attempt
    FROM commerce_customer_context.portal_enrollment_attempts AS attempt
   WHERE attempt.tenant_id = p_tenant_id AND attempt.portal_enrollment_attempt_id = p_attempt_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF current_attempt.state IN ('COMPLETE', 'TERMINATED', 'FAILED') THEN
    RETURN QUERY SELECT * FROM commerce_customer_context.portal_enrollment_attempt_projection(
      p_tenant_id, p_attempt_id, 'TERMINAL', p_owner_module_key, p_transition_key
    );
    RETURN;
  END IF;
  -- The Attempt is the durable effect fence.  Before looking up the requested transition,
  -- detect every expired in-progress owner operation on this Attempt.  This prevents an
  -- unseen transition B from bypassing an expired transition A by creating a new effect.
  SELECT operation.* INTO expired_operation
    FROM commerce_customer_context.portal_enrollment_owner_operations AS operation
   WHERE operation.tenant_id = p_tenant_id
     AND operation.portal_enrollment_attempt_id = p_attempt_id
     AND operation.status = 'IN_PROGRESS'
     AND operation.lease_expires_at IS NOT NULL
     AND operation.lease_expires_at <= now_at
   ORDER BY operation.updated_at, operation.portal_enrollment_owner_operation_id
   LIMIT 1
   FOR UPDATE;
  IF FOUND THEN
    UPDATE commerce_customer_context.portal_enrollment_owner_operations AS operation
       SET revision = operation.revision + 1,
           status = 'INDETERMINATE',
           failure_code = 'attempt_lease_expired',
           failure_reason = 'An owner lease expired before a final outcome was recorded',
           lease_owner = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           completed_at = now_at,
           updated_at = now_at
     WHERE operation.tenant_id = p_tenant_id
       AND operation.portal_enrollment_owner_operation_id = expired_operation.portal_enrollment_owner_operation_id;
    UPDATE commerce_customer_context.portal_enrollment_attempts AS attempt
       SET state = 'RECONCILIATION_REQUIRED',
           revision = attempt.revision + 1,
           last_owner_invocation_id = expired_operation.owner_invocation_id,
           last_failure_code = 'attempt_lease_expired',
           last_failure_reason = 'An owner lease expired before a final outcome was recorded',
           lease_owner = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           updated_at = now_at
     WHERE attempt.tenant_id = p_tenant_id AND attempt.portal_enrollment_attempt_id = p_attempt_id;
    RETURN QUERY SELECT * FROM commerce_customer_context.portal_enrollment_attempt_projection(
      p_tenant_id, p_attempt_id, 'INDETERMINATE', p_owner_module_key, p_transition_key
    );
    RETURN;
  END IF;
  SELECT operation.* INTO invocation_operation
    FROM commerce_customer_context.portal_enrollment_owner_operations AS operation
   WHERE operation.tenant_id = p_tenant_id
     AND operation.portal_enrollment_attempt_id = p_attempt_id
     AND operation.owner_invocation_id = p_owner_invocation_id
   FOR UPDATE;
  IF FOUND AND (
       invocation_operation.owner_module_key IS DISTINCT FROM p_owner_module_key
       OR invocation_operation.transition_key IS DISTINCT FROM p_transition_key
     ) THEN
    RETURN QUERY SELECT * FROM commerce_customer_context.portal_enrollment_attempt_projection(
      p_tenant_id,
      p_attempt_id,
      'CONFLICT',
      invocation_operation.owner_module_key,
      invocation_operation.transition_key
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
  SELECT operation.* INTO current_operation
    FROM commerce_customer_context.portal_enrollment_owner_operations AS operation
   WHERE operation.tenant_id = p_tenant_id
     AND operation.portal_enrollment_attempt_id = p_attempt_id
     AND operation.owner_module_key = p_owner_module_key
     AND operation.transition_key = p_transition_key
   FOR UPDATE;
  IF FOUND THEN
    IF current_operation.owner_invocation_id IS DISTINCT FROM p_owner_invocation_id
       OR current_operation.request_digest IS DISTINCT FROM p_request_digest
       OR current_operation.required IS DISTINCT FROM p_required THEN
      outcome := 'CONFLICT';
    ELSIF current_operation.status IN ('INDETERMINATE', 'RECONCILIATION_REQUIRED') THEN
      outcome := 'INDETERMINATE';
    ELSIF current_operation.status = 'SUCCEEDED' THEN
      outcome := 'REPLAYED';
    ELSIF current_operation.status = 'FAILED' THEN
      -- A definitive owner failure may be retried under the same immutable transition and
      -- invocation identity.  The operation update below reopens its lease atomically.
      NULL;
    ELSIF current_operation.lease_expires_at IS NOT NULL AND current_operation.lease_expires_at > now_at THEN
      outcome := 'ALREADY_CLAIMED';
    ELSE
      -- An expired owner lease is an unknown provider outcome.  Fence it into durable
      -- reconciliation before returning; never hand the same transition back to a new effect.
      UPDATE commerce_customer_context.portal_enrollment_owner_operations AS operation
         SET revision = operation.revision + 1,
             status = 'INDETERMINATE',
             failure_code = 'attempt_lease_expired',
             failure_reason = 'The owner lease expired before a final outcome was recorded',
             lease_owner = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             completed_at = now_at,
             updated_at = now_at
       WHERE operation.tenant_id = p_tenant_id
         AND operation.portal_enrollment_owner_operation_id = current_operation.portal_enrollment_owner_operation_id;
      UPDATE commerce_customer_context.portal_enrollment_attempts AS attempt
         SET state = 'RECONCILIATION_REQUIRED',
             revision = attempt.revision + 1,
             last_owner_invocation_id = current_operation.owner_invocation_id,
             last_failure_code = 'attempt_lease_expired',
             last_failure_reason = 'The owner lease expired before a final outcome was recorded',
             lease_owner = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             updated_at = now_at
       WHERE attempt.tenant_id = p_tenant_id AND attempt.portal_enrollment_attempt_id = p_attempt_id;
      outcome := 'INDETERMINATE';
    END IF;
    IF outcome IS NOT NULL THEN
      RETURN QUERY SELECT * FROM commerce_customer_context.portal_enrollment_attempt_projection(
        p_tenant_id, p_attempt_id, outcome, p_owner_module_key, p_transition_key
      );
      RETURN;
    END IF;
  END IF;
  IF current_attempt.state = 'RECONCILIATION_REQUIRED' THEN
    RETURN QUERY SELECT * FROM commerce_customer_context.portal_enrollment_attempt_projection(
      p_tenant_id, p_attempt_id, 'INDETERMINATE', p_owner_module_key, p_transition_key
    );
    RETURN;
  END IF;
  IF current_attempt.revision <> p_expected_revision THEN
    RETURN QUERY SELECT * FROM commerce_customer_context.portal_enrollment_attempt_projection(
      p_tenant_id, p_attempt_id, 'REVISION_CONFLICT', p_owner_module_key, p_transition_key
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
  IF current_attempt.lease_expires_at IS NOT NULL AND current_attempt.lease_expires_at > now_at THEN
    RETURN QUERY SELECT * FROM commerce_customer_context.portal_enrollment_attempt_projection(
      p_tenant_id, p_attempt_id, 'ALREADY_CLAIMED', p_owner_module_key, p_transition_key
    );
    RETURN;
  END IF;
  next_token := gen_random_uuid();
  UPDATE commerce_customer_context.portal_enrollment_attempts AS attempt
     SET authentication_namespace_id = CASE WHEN p_authentication_namespace_id IS NULL THEN attempt.authentication_namespace_id ELSE p_authentication_namespace_id END,
         subject_type = CASE WHEN p_authentication_namespace_id IS NULL THEN attempt.subject_type ELSE 'user' END,
         provider_subject_id = CASE WHEN p_provider_subject_id IS NULL THEN attempt.provider_subject_id ELSE p_provider_subject_id END,
         revision = attempt.revision + 1,
         last_owner_invocation_id = p_owner_invocation_id,
         last_failure_code = NULL,
         last_failure_reason = NULL,
         lease_owner = p_worker_id,
         lease_token = next_token,
         lease_expires_at = now_at + (p_lease_duration_ms * interval '1 millisecond'),
         updated_at = now_at
   WHERE attempt.tenant_id = p_tenant_id AND attempt.portal_enrollment_attempt_id = p_attempt_id;
  IF current_operation.portal_enrollment_owner_operation_id IS NULL THEN
    INSERT INTO commerce_customer_context.portal_enrollment_owner_operations (
      tenant_id, portal_enrollment_attempt_id, owner_module_key, transition_key,
      owner_invocation_id, request_digest, required, status, actor_principal_id,
      lease_owner, lease_token, lease_expires_at
    ) VALUES (
      p_tenant_id, p_attempt_id, p_owner_module_key, p_transition_key,
      p_owner_invocation_id, p_request_digest, p_required, 'IN_PROGRESS', p_actor_principal_id,
      p_worker_id, next_token, now_at + (p_lease_duration_ms * interval '1 millisecond')
    );
  ELSE
    UPDATE commerce_customer_context.portal_enrollment_owner_operations AS operation
       SET revision = operation.revision + 1,
           actor_principal_id = p_actor_principal_id,
           status = 'IN_PROGRESS',
           result_reference = NULL,
           reconciliation_ref = NULL,
           result_digest = NULL,
           outcome_code = NULL,
           failure_code = NULL,
           failure_reason = NULL,
           lease_owner = p_worker_id,
           lease_token = next_token,
           lease_expires_at = now_at + (p_lease_duration_ms * interval '1 millisecond'),
           completed_at = NULL,
           updated_at = now_at
     WHERE operation.tenant_id = p_tenant_id
       AND operation.portal_enrollment_owner_operation_id = current_operation.portal_enrollment_owner_operation_id;
  END IF;
  RETURN QUERY SELECT * FROM commerce_customer_context.portal_enrollment_attempt_projection(
    p_tenant_id, p_attempt_id, 'CLAIMED', p_owner_module_key, p_transition_key
  );
END;
$function$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION "commerce_customer_context"."record_portal_enrollment_outcome"(
  p_tenant_id uuid,
  p_attempt_id uuid,
  p_expected_revision integer,
  p_worker_id text,
  p_lease_token uuid,
  p_owner_module_key text,
  p_transition_key text,
  p_owner_invocation_id uuid,
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
  completed_at timestamptz,
  composition_revision text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
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
  IF p_authentication_namespace_id IS NOT NULL
     AND p_authentication_namespace_id <> 'ontos.commerce.portal.better-auth.v1' THEN
    RAISE EXCEPTION 'unsupported Commerce authentication namespace' USING ERRCODE = '22023';
  END IF;
  IF p_provider_subject_id IS NOT NULL
     AND length(p_provider_subject_id) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'provider subject is outside the supported range' USING ERRCODE = '22023';
  END IF;
  SELECT attempt.* INTO current_attempt
    FROM commerce_customer_context.portal_enrollment_attempts AS attempt
   WHERE attempt.tenant_id = p_tenant_id AND attempt.portal_enrollment_attempt_id = p_attempt_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF current_attempt.state IN ('COMPLETE', 'TERMINATED', 'FAILED') THEN
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
  IF current_operation.owner_invocation_id IS DISTINCT FROM p_owner_invocation_id THEN
    RETURN QUERY SELECT * FROM commerce_customer_context.portal_enrollment_attempt_projection(
      p_tenant_id, p_attempt_id, 'CONFLICT', p_owner_module_key, p_transition_key
    );
    RETURN;
  END IF;
  IF p_status NOT IN ('SUCCEEDED', 'FAILED') THEN
    RAISE EXCEPTION 'ordinary owner outcome must be final' USING ERRCODE = '22023';
  END IF;
  IF p_next_state IS NOT NULL
     AND p_next_state NOT IN ('IN_PROGRESS', 'VERIFICATION_REQUIRED', 'COMPLETE', 'RECONCILIATION_REQUIRED') THEN
    RAISE EXCEPTION 'invalid owner outcome next state' USING ERRCODE = '22023';
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
  IF current_operation.status IN ('SUCCEEDED', 'FAILED', 'INDETERMINATE', 'RECONCILIATION_REQUIRED') THEN
    IF current_operation.status IN ('INDETERMINATE', 'RECONCILIATION_REQUIRED') THEN
      RETURN QUERY SELECT * FROM commerce_customer_context.portal_enrollment_attempt_projection(
        p_tenant_id, p_attempt_id, 'INDETERMINATE', p_owner_module_key, p_transition_key
      );
      RETURN;
    ELSIF current_operation.status IS DISTINCT FROM p_status
       OR current_operation.result_reference IS DISTINCT FROM p_result_reference
       OR current_operation.result_digest IS DISTINCT FROM p_result_digest
       OR current_operation.outcome_code IS DISTINCT FROM p_outcome_code
       OR current_operation.failure_code IS DISTINCT FROM p_failure_code
       OR current_operation.failure_reason IS DISTINCT FROM p_failure_reason THEN
      RETURN QUERY SELECT * FROM commerce_customer_context.portal_enrollment_attempt_projection(
        p_tenant_id, p_attempt_id, 'CONFLICT', p_owner_module_key, p_transition_key
      );
      RETURN;
    ELSE
      RETURN QUERY SELECT * FROM commerce_customer_context.portal_enrollment_attempt_projection(
        p_tenant_id, p_attempt_id, 'RECORDED', p_owner_module_key, p_transition_key
      );
      RETURN;
    END IF;
  END IF;
  IF current_attempt.revision <> p_expected_revision
     OR current_attempt.lease_owner IS DISTINCT FROM p_worker_id
     OR current_attempt.lease_token IS DISTINCT FROM p_lease_token
     OR current_attempt.lease_expires_at IS NULL
     OR current_attempt.lease_expires_at <= now_at
     OR current_operation.lease_owner IS DISTINCT FROM p_worker_id
     OR current_operation.lease_token IS DISTINCT FROM p_lease_token
     OR current_operation.lease_expires_at IS NULL
     OR current_operation.lease_expires_at <= now_at THEN
    RETURN QUERY SELECT * FROM commerce_customer_context.portal_enrollment_attempt_projection(
      p_tenant_id, p_attempt_id, CASE WHEN current_attempt.revision <> p_expected_revision THEN 'REVISION_CONFLICT' ELSE 'LEASE_CONFLICT' END, p_owner_module_key, p_transition_key
    );
    RETURN;
  END IF;
  UPDATE commerce_customer_context.portal_enrollment_owner_operations AS operation
     SET revision = operation.revision + 1,
         status = p_status,
         result_reference = p_result_reference,
         reconciliation_ref = NULL,
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
  IF p_status IN ('INDETERMINATE', 'RECONCILIATION_REQUIRED') OR p_next_state = 'RECONCILIATION_REQUIRED'
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
         last_owner_invocation_id = p_owner_invocation_id,
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

--> statement-breakpoint
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
  completed_at timestamptz,
  composition_revision text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
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
  IF current_attempt.state IN ('COMPLETE', 'TERMINATED', 'FAILED') THEN
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

--> statement-breakpoint
CREATE OR REPLACE FUNCTION "commerce_customer_context"."terminate_portal_enrollment"(
  p_tenant_id uuid,
  p_attempt_id uuid,
  p_expected_revision integer,
  p_action_invocation_id uuid,
  p_actor_principal_id uuid,
  p_reason text
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
  current_attempt commerce_customer_context.portal_enrollment_attempts%ROWTYPE;
  now_at timestamptz := statement_timestamp();
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified operation Tenant mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT attempt.* INTO current_attempt
    FROM commerce_customer_context.portal_enrollment_attempts AS attempt
   WHERE attempt.tenant_id = p_tenant_id AND attempt.portal_enrollment_attempt_id = p_attempt_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF current_attempt.state IN ('COMPLETE', 'TERMINATED', 'FAILED') THEN
    RETURN QUERY SELECT * FROM commerce_customer_context.portal_enrollment_attempt_projection(
      p_tenant_id, p_attempt_id, 'ALREADY_TERMINAL', NULL, NULL
    );
    RETURN;
  END IF;
  IF current_attempt.revision <> p_expected_revision THEN
    RETURN QUERY SELECT * FROM commerce_customer_context.portal_enrollment_attempt_projection(
      p_tenant_id, p_attempt_id, 'REVISION_CONFLICT', NULL, NULL
    );
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM commerce_customer_context.portal_enrollment_owner_operations AS operation
    WHERE operation.tenant_id = p_tenant_id
      AND operation.portal_enrollment_attempt_id = p_attempt_id
      AND (
        operation.status IN ('IN_PROGRESS', 'INDETERMINATE', 'RECONCILIATION_REQUIRED')
        OR (operation.status = 'FAILED' AND operation.failure_code = 'owner_reconciliation_required')
        OR operation.lease_expires_at > now_at
      )
  ) THEN
    RETURN QUERY SELECT * FROM commerce_customer_context.portal_enrollment_attempt_projection(
      p_tenant_id, p_attempt_id, 'INDETERMINATE', NULL, NULL
    );
    RETURN;
  END IF;
  UPDATE commerce_customer_context.portal_enrollment_owner_operations AS operation
     SET lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = now_at
   WHERE operation.tenant_id = p_tenant_id AND operation.portal_enrollment_attempt_id = p_attempt_id;
  UPDATE commerce_customer_context.portal_enrollment_attempts AS attempt
     SET state = 'TERMINATED',
         revision = attempt.revision + 1,
         last_owner_invocation_id = p_action_invocation_id,
         last_failure_code = 'attempt_terminated',
         last_failure_reason = p_reason,
         lease_owner = NULL,
         lease_token = NULL,
         lease_expires_at = NULL,
         terminated_at = now_at,
         updated_at = now_at
   WHERE attempt.tenant_id = p_tenant_id AND attempt.portal_enrollment_attempt_id = p_attempt_id;
  RETURN QUERY SELECT * FROM commerce_customer_context.portal_enrollment_attempt_projection(
    p_tenant_id, p_attempt_id, 'TERMINATED', NULL, NULL
  );
END;
$function$;
