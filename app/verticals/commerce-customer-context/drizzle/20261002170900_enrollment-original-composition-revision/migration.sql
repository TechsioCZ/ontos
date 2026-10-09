-- An old journal has no authentic admitted release identity. Stop the cutover rather than
-- assigning the current release to historical work, including apparently terminal Attempts.
-- Operators must resolve and retain that history outside this empty-journal cutover beforehand.
LOCK TABLE "commerce_customer_context"."portal_enrollment_attempts" IN ACCESS EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM commerce_customer_context.portal_enrollment_attempts) THEN
    RAISE EXCEPTION 'Enrollment journal has no original composition revision; reconcile it before cutover'
      USING ERRCODE = '23514';
  END IF;
END;
$migration$;
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."portal_enrollment_attempts"
  ADD COLUMN "composition_revision" text NOT NULL,
  ADD CONSTRAINT "ccc_portal_enrollment_attempts_composition_revision_ck"
    CHECK ("composition_revision" ~ '^[0-9a-f]{64}$');
--> statement-breakpoint

DROP FUNCTION "commerce_customer_context"."create_portal_enrollment_attempt"(uuid, uuid, uuid, text, text, text, uuid, uuid, text);
--> statement-breakpoint

DROP FUNCTION "commerce_customer_context"."claim_portal_enrollment_transition"(uuid, uuid, integer, text, text, text, uuid, text, uuid, boolean, integer, text, text);
--> statement-breakpoint

DROP FUNCTION "commerce_customer_context"."record_portal_enrollment_outcome"(uuid, uuid, integer, text, uuid, text, text, uuid, uuid, text, text, text, text, text, text, text, text, text);
--> statement-breakpoint

DROP FUNCTION "commerce_customer_context"."reconcile_portal_enrollment_outcome"(uuid, uuid, integer, text, text, uuid, uuid, uuid, text, text, text, text, text, text, text, text, text);
--> statement-breakpoint

DROP FUNCTION "commerce_customer_context"."terminate_portal_enrollment"(uuid, uuid, integer, uuid, uuid, text);
--> statement-breakpoint

DROP FUNCTION "commerce_customer_context"."read_portal_enrollment_attempt"(uuid, uuid);
--> statement-breakpoint

DROP FUNCTION "commerce_customer_context"."list_due_portal_enrollment_attempts"(integer, timestamptz, uuid, integer, integer);
--> statement-breakpoint

DROP FUNCTION "commerce_customer_context"."claim_portal_enrollment_sweep"(uuid, uuid, integer, integer, integer);
--> statement-breakpoint

DROP FUNCTION "commerce_customer_context"."portal_enrollment_attempt_projection"(uuid, uuid, text, text, text);
--> statement-breakpoint

CREATE FUNCTION "commerce_customer_context"."portal_enrollment_attempt_projection"(
  p_tenant_id uuid,
  p_attempt_id uuid,
  p_outcome text,
  p_owner_module_key text,
  p_transition_key text
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
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
  SELECT
    attempt.portal_enrollment_attempt_id,
    attempt.tenant_id,
    attempt.journey,
    attempt.intent_key,
    attempt.intent_digest,
    attempt.invitation_id,
    attempt.target_legal_entity_id,
    attempt.target_resource_id,
    attempt.authentication_namespace_id,
    attempt.subject_type,
    attempt.provider_subject_id,
    attempt.state,
    attempt.revision,
    attempt.created_by_principal_id,
    attempt.last_owner_invocation_id,
    attempt.last_failure_code,
    attempt.last_failure_reason,
    attempt.lease_owner,
    attempt.lease_token,
    attempt.lease_expires_at,
    attempt.terminated_at,
    attempt.created_at,
    attempt.updated_at,
    p_outcome,
    operation.portal_enrollment_owner_operation_id,
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
    attempt.composition_revision
  FROM commerce_customer_context.portal_enrollment_attempts AS attempt
  LEFT JOIN commerce_customer_context.portal_enrollment_owner_operations AS operation
    ON operation.tenant_id = attempt.tenant_id
   AND operation.portal_enrollment_attempt_id = attempt.portal_enrollment_attempt_id
   AND (p_owner_module_key IS NULL OR operation.owner_module_key = p_owner_module_key)
   AND (p_transition_key IS NULL OR operation.transition_key = p_transition_key)
  WHERE attempt.tenant_id = p_tenant_id
    AND attempt.portal_enrollment_attempt_id = p_attempt_id;
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION "commerce_customer_context"."portal_enrollment_attempt_projection"(uuid, uuid, text, text, text) FROM PUBLIC;

--> statement-breakpoint

CREATE FUNCTION "commerce_customer_context"."create_portal_enrollment_attempt"(
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
    target_resource_id, created_by_principal_id, last_owner_invocation_id, composition_revision
  ) VALUES (
    p_tenant_id, p_journey, p_intent_key, p_intent_digest, p_invitation_id, p_target_legal_entity_id,
    p_target_resource_id, p_actor_principal_id, p_action_invocation_id, p_composition_revision
  ) RETURNING portal_enrollment_attempts.* INTO existing_attempt;
  RETURN QUERY SELECT * FROM commerce_customer_context.portal_enrollment_attempt_projection(
    p_tenant_id, existing_attempt.portal_enrollment_attempt_id, 'CREATED', NULL, NULL
  );
END;
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION "commerce_customer_context"."create_portal_enrollment_attempt"(uuid, uuid, uuid, text, text, text, uuid, uuid, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "commerce_customer_context"."create_portal_enrollment_attempt"(uuid, uuid, uuid, text, text, text, uuid, uuid, text, text) TO "ontos_runtime";

--> statement-breakpoint

CREATE FUNCTION "commerce_customer_context"."claim_portal_enrollment_transition"(
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
  IF current_attempt.state IN ('COMPLETE', 'TERMINATED') THEN
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

REVOKE ALL ON FUNCTION "commerce_customer_context"."claim_portal_enrollment_transition"(uuid, uuid, integer, text, text, text, uuid, text, uuid, boolean, integer, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "commerce_customer_context"."claim_portal_enrollment_transition"(uuid, uuid, integer, text, text, text, uuid, text, uuid, boolean, integer, text, text) TO "ontos_runtime";

--> statement-breakpoint

CREATE FUNCTION "commerce_customer_context"."record_portal_enrollment_outcome"(
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

REVOKE ALL ON FUNCTION "commerce_customer_context"."record_portal_enrollment_outcome"(uuid, uuid, integer, text, uuid, text, text, uuid, uuid, text, text, text, text, text, text, text, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "commerce_customer_context"."record_portal_enrollment_outcome"(uuid, uuid, integer, text, uuid, text, text, uuid, uuid, text, text, text, text, text, text, text, text, text) TO "ontos_runtime";

--> statement-breakpoint

CREATE FUNCTION "commerce_customer_context"."reconcile_portal_enrollment_outcome"(
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
--> statement-breakpoint

REVOKE ALL ON FUNCTION "commerce_customer_context"."reconcile_portal_enrollment_outcome"(uuid, uuid, integer, text, text, uuid, uuid, uuid, text, text, text, text, text, text, text, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "commerce_customer_context"."reconcile_portal_enrollment_outcome"(uuid, uuid, integer, text, text, uuid, uuid, uuid, text, text, text, text, text, text, text, text, text) TO "ontos_runtime";

--> statement-breakpoint

CREATE FUNCTION "commerce_customer_context"."terminate_portal_enrollment"(
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
  IF current_attempt.state IN ('COMPLETE', 'TERMINATED') THEN
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
--> statement-breakpoint

REVOKE ALL ON FUNCTION "commerce_customer_context"."terminate_portal_enrollment"(uuid, uuid, integer, uuid, uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "commerce_customer_context"."terminate_portal_enrollment"(uuid, uuid, integer, uuid, uuid, text) TO "ontos_runtime";

--> statement-breakpoint

CREATE FUNCTION "commerce_customer_context"."read_portal_enrollment_attempt"(
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
  completed_at timestamptz,
  composition_revision text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
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

REVOKE ALL ON FUNCTION "commerce_customer_context"."read_portal_enrollment_attempt"(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_portal_enrollment_attempt"(uuid, uuid) TO "ontos_runtime";

--> statement-breakpoint

CREATE FUNCTION "commerce_customer_context"."list_due_portal_enrollment_attempts"(
  p_stale_after_millis integer,
  p_after_updated_at timestamptz,
  p_after_attempt_id uuid,
  p_limit integer,
  p_max_sweeps integer
)
RETURNS TABLE (
  tenant_id uuid,
  portal_enrollment_attempt_id uuid,
  state text,
  revision integer,
  updated_at timestamptz,
  composition_revision text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
DECLARE
  now_at timestamptz := statement_timestamp();
  stale_before timestamptz;
BEGIN
  IF nullif(current_setting('ontos.tenant_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'cross-Tenant Attempt due-work listing requires worker scope' USING ERRCODE = '42501';
  END IF;
  -- Half a keyset is not a position: comparing a row against a NULL half silently returns nothing,
  -- which would read as "no more due work" and end the tick with newer Attempts unvisited.
  IF (p_after_updated_at IS NULL) <> (p_after_attempt_id IS NULL) THEN
    RAISE EXCEPTION 'a due-work cursor needs both its activity timestamp and its Attempt' USING ERRCODE = '22023';
  END IF;
  stale_before := now_at - make_interval(secs => greatest(p_stale_after_millis, 0)::double precision / 1000);
  RETURN QUERY
  SELECT
    attempt.tenant_id,
    attempt.portal_enrollment_attempt_id,
    attempt.state,
    -- The revision is how a worker tells an Attempt that has not moved since its last fruitless
    -- pass from one that has, without reading the Attempt again.
    attempt.revision,
    attempt.updated_at,
    attempt.composition_revision
  FROM commerce_customer_context.portal_enrollment_attempts AS attempt
  WHERE
    -- COMPLETE and TERMINATED have nothing left to advance; VERIFICATION_REQUIRED waits on a
    -- caller rather than on a worker, so re-advancing it would halt on the very same answer.
    attempt.state IN ('IN_PROGRESS', 'RECONCILIATION_REQUIRED')
    AND attempt.updated_at <= stale_before
    -- A live claim still owns the transition, and the claim — not this listing — grants ownership.
    AND (attempt.lease_expires_at IS NULL OR attempt.lease_expires_at <= now_at)
    AND NOT EXISTS (
      SELECT 1
      FROM commerce_customer_context.portal_enrollment_owner_operations AS operation
      WHERE operation.tenant_id = attempt.tenant_id
        AND operation.portal_enrollment_attempt_id = attempt.portal_enrollment_attempt_id
        AND operation.status = 'IN_PROGRESS'
        AND operation.lease_expires_at > now_at
    )
    -- A fenced Attempt is due exactly once: while an owner transition the claim fenced still has no
    -- authoritative answer on record. `reconcile_portal_enrollment_outcome` demands that reference
    -- and writes it with a final status, so one continuation pass settles the operation and the row
    -- leaves this listing on its own rather than on a rule that has to predict the settlement.
    -- FAILED + owner_reconciliation_required is an owner still deciding, due on INDETERMINATE terms.
    AND (
      attempt.state = 'IN_PROGRESS'
      OR EXISTS (
        SELECT 1
        FROM commerce_customer_context.portal_enrollment_owner_operations AS operation
        WHERE operation.tenant_id = attempt.tenant_id
          AND operation.portal_enrollment_attempt_id = attempt.portal_enrollment_attempt_id
          AND (
            (operation.status = 'INDETERMINATE' AND operation.reconciliation_ref IS NULL)
            OR (operation.status = 'FAILED' AND operation.failure_code = 'owner_reconciliation_required')
          )
      )
    )
    -- The sweep budget, spent durably rather than in a worker's memory. A count only holds this
    -- Attempt back while it still stands at the revision that count was spent against: anything
    -- that moves the Attempt — a read that resumed it, an owner outcome — makes it due again.
    -- An owner still deciding on `owner_reconciliation_required` is exempt from the hard cut-off; it backs off instead.
    AND (
      NOT (attempt.sweep_revision = attempt.revision AND attempt.sweep_count >= p_max_sweeps)
      OR (
        EXISTS (
          SELECT 1
          FROM commerce_customer_context.portal_enrollment_owner_operations AS operation
          WHERE operation.tenant_id = attempt.tenant_id
            AND operation.portal_enrollment_attempt_id = attempt.portal_enrollment_attempt_id
            AND operation.status = 'FAILED'
            AND operation.failure_code = 'owner_reconciliation_required'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM commerce_customer_context.portal_enrollment_owner_operations AS operation
          WHERE operation.tenant_id = attempt.tenant_id
            AND operation.portal_enrollment_attempt_id = attempt.portal_enrollment_attempt_id
            AND operation.status = 'INDETERMINATE'
            AND operation.reconciliation_ref IS NULL
        )
      )
    )
    -- A live sweep claim is another replica's pass, already charged to the budget above. Offering
    -- the row again would hand every replica the same due work and let the losers spend the whole
    -- budget on a pass none of them performed.
    AND (attempt.sweep_claimed_until IS NULL OR attempt.sweep_claimed_until <= now_at)
    AND (
      p_after_updated_at IS NULL
      OR (attempt.updated_at, attempt.portal_enrollment_attempt_id) > (p_after_updated_at, p_after_attempt_id)
    )
  -- The Attempt id breaks ties, so the keyset is a total order and a page can never re-serve or
  -- skip a row whose activity timestamp another Attempt shares.
  ORDER BY attempt.updated_at, attempt.portal_enrollment_attempt_id
  LIMIT greatest(least(p_limit, 500), 0);
END;
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION "commerce_customer_context"."list_due_portal_enrollment_attempts"(integer, timestamptz, uuid, integer, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "commerce_customer_context"."list_due_portal_enrollment_attempts"(integer, timestamptz, uuid, integer, integer) TO "ontos_runtime";

--> statement-breakpoint

CREATE FUNCTION "commerce_customer_context"."claim_portal_enrollment_sweep"(
  p_tenant_id uuid,
  p_attempt_id uuid,
  p_revision integer,
  p_max_sweeps integer,
  p_claim_ttl_millis integer,
  p_composition_revision text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
DECLARE
  now_at timestamptz := statement_timestamp();
  claimed integer;
  -- Owner still deciding on `owner_reconciliation_required`, matching the listing's cut-off exemption.
  owner_pending boolean;
BEGIN
  IF nullif(current_setting('ontos.tenant_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'cross-Tenant Attempt sweep accounting requires worker scope' USING ERRCODE = '42501';
  END IF;
  SELECT
    EXISTS (
      SELECT 1
      FROM commerce_customer_context.portal_enrollment_owner_operations AS operation
      WHERE operation.tenant_id = p_tenant_id
        AND operation.portal_enrollment_attempt_id = p_attempt_id
        AND operation.status = 'FAILED'
        AND operation.failure_code = 'owner_reconciliation_required'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM commerce_customer_context.portal_enrollment_owner_operations AS operation
      WHERE operation.tenant_id = p_tenant_id
        AND operation.portal_enrollment_attempt_id = p_attempt_id
        AND operation.status = 'INDETERMINATE'
        AND operation.reconciliation_ref IS NULL
    )
  INTO owner_pending;
  -- A revision the count was not spent against starts the budget over, which is how any state or
  -- revision change — not a rule that has to predict one — releases an Attempt the budget held.
  -- Owner-pending attempts get a growing claim instead of a cut-off, capped at 64x.
  UPDATE commerce_customer_context.portal_enrollment_attempts AS attempt
  SET
    sweep_count = CASE WHEN attempt.sweep_revision IS DISTINCT FROM p_revision THEN 1 ELSE attempt.sweep_count + 1 END,
    sweep_revision = p_revision,
    sweep_claimed_until = now_at + make_interval(secs =>
      (greatest(p_claim_ttl_millis, 0)::double precision / 1000)
      * CASE
          WHEN owner_pending THEN least(
            power(2, greatest(
              (CASE WHEN attempt.sweep_revision IS DISTINCT FROM p_revision THEN 1 ELSE attempt.sweep_count + 1 END) - 1,
              0
            )),
            64
          )
          ELSE 1
        END)
  WHERE attempt.tenant_id = p_tenant_id
    AND attempt.portal_enrollment_attempt_id = p_attempt_id
    AND attempt.composition_revision = p_composition_revision
    AND attempt.revision = p_revision -- a listing snapshot the Attempt has outgrown claims nothing
    AND (attempt.sweep_claimed_until IS NULL OR attempt.sweep_claimed_until <= now_at)
    AND (owner_pending OR NOT (attempt.sweep_revision = p_revision AND attempt.sweep_count >= p_max_sweeps))
  RETURNING attempt.sweep_count INTO claimed;
  IF claimed IS NULL THEN
    -- The claim failed, which is an answer rather than a fault: another replica holds this pass, or
    -- the budget at this revision is spent. An Attempt that is not there at all is neither.
    IF NOT EXISTS (
      SELECT 1
      FROM commerce_customer_context.portal_enrollment_attempts AS attempt
      WHERE attempt.tenant_id = p_tenant_id
        AND attempt.portal_enrollment_attempt_id = p_attempt_id
    ) THEN
      RAISE EXCEPTION 'Enrollment Attempt not found for sweep accounting' USING ERRCODE = '02000';
    END IF;
    RETURN NULL;
  END IF;
  RETURN claimed;
END;
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION "commerce_customer_context"."claim_portal_enrollment_sweep"(uuid, uuid, integer, integer, integer, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "commerce_customer_context"."claim_portal_enrollment_sweep"(uuid, uuid, integer, integer, integer, text) TO "ontos_runtime";

--> statement-breakpoint

CREATE OR REPLACE FUNCTION "commerce_customer_context"."ccc_portal_enrollment_attempts_identity_guard"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
BEGIN
  IF NEW.composition_revision IS DISTINCT FROM OLD.composition_revision
     OR NEW.portal_enrollment_attempt_id IS DISTINCT FROM OLD.portal_enrollment_attempt_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.journey IS DISTINCT FROM OLD.journey
     OR NEW.intent_key IS DISTINCT FROM OLD.intent_key
     OR NEW.intent_digest IS DISTINCT FROM OLD.intent_digest
     OR NEW.invitation_id IS DISTINCT FROM OLD.invitation_id
     OR NEW.target_legal_entity_id IS DISTINCT FROM OLD.target_legal_entity_id
     OR NEW.target_resource_id IS DISTINCT FROM OLD.target_resource_id
     OR NEW.created_by_principal_id IS DISTINCT FROM OLD.created_by_principal_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Enrollment Attempt identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
