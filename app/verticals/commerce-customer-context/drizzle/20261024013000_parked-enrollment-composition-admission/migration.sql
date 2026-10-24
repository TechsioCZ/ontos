-- An Attempt can wait indefinitely on a person; publication only drains unresolved owner work.
-- NULL continuation composition means no re-admission has occurred; the immutable original
-- composition_revision remains the creation provenance throughout the journey.
ALTER TABLE commerce_customer_context.portal_enrollment_attempts
  ADD COLUMN continuation_composition_revision text,
  ADD CONSTRAINT ccc_enrollment_continuation_composition_ck
    CHECK (continuation_composition_revision IS NULL OR continuation_composition_revision ~ '^[0-9a-f]{64}$');
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
  durable_admission text;
  attempt_state text;
  work_id text;
  pending boolean;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Enrollment release admission requires READ COMMITTED' USING ERRCODE = '55000';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('ontos.application-composition-authority', 0));

  IF TG_TABLE_NAME = 'portal_enrollment_attempts' THEN
    expected_revision := coalesce(NEW.continuation_composition_revision, NEW.composition_revision);
    IF TG_OP = 'INSERT' AND NEW.continuation_composition_revision IS NOT NULL THEN
      RAISE EXCEPTION 'A new Enrollment Attempt has no continuation admission' USING ERRCODE = '22023';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.composition_revision IS DISTINCT FROM OLD.composition_revision THEN
      RAISE EXCEPTION 'An Enrollment Attempt cannot change its original composition revision' USING ERRCODE = '22023';
    END IF;
  ELSE
    SELECT coalesce(attempt.continuation_composition_revision, attempt.composition_revision), attempt.state INTO expected_revision, attempt_state
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

  SELECT authority.revision, authority.phase, authority.valid_until, authority.durable_work_admission
    INTO active_revision, active_phase, active_valid_until, durable_admission
  FROM core.application_composition_authority AS authority
  WHERE authority.authority_key = 'active';

  IF expected_revision IS NULL OR active_revision IS DISTINCT FROM expected_revision
    OR active_valid_until IS NULL OR active_valid_until <= clock_timestamp() THEN
    RAISE EXCEPTION 'The original Enrollment composition revision is no longer admitted' USING ERRCODE = '55000';
  END IF;
  IF active_phase NOT IN ('active', 'draining') THEN
    RAISE EXCEPTION 'Enrollment work cannot mutate a sealed or migrated composition' USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'portal_enrollment_attempts' AND TG_OP = 'INSERT'
    AND (active_phase <> 'active' OR durable_admission <> 'open') THEN
    RAISE EXCEPTION 'New Enrollment Attempts cannot start while composition is draining' USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'portal_enrollment_attempts' THEN
    IF TG_OP = 'UPDATE' AND OLD.state = 'FAILED' THEN
      RAISE EXCEPTION 'A failed Enrollment Attempt is immutable' USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'UPDATE' AND coalesce(NEW.continuation_composition_revision, NEW.composition_revision)
      IS DISTINCT FROM coalesce(OLD.continuation_composition_revision, OLD.composition_revision) THEN
      IF OLD.state IN ('COMPLETE', 'TERMINATED', 'FAILED')
        OR active_phase <> 'active' OR durable_admission <> 'open'
        OR EXISTS (
          SELECT 1 FROM commerce_customer_context.portal_enrollment_owner_operations operation
          WHERE operation.tenant_id = NEW.tenant_id
            AND operation.portal_enrollment_attempt_id = NEW.portal_enrollment_attempt_id
            AND (operation.status IN ('IN_PROGRESS', 'INDETERMINATE', 'RECONCILIATION_REQUIRED')
              OR (operation.status = 'FAILED' AND operation.failure_code = 'owner_reconciliation_required')
              OR coalesce(operation.lease_expires_at > clock_timestamp(), false))
        ) THEN
        RAISE EXCEPTION 'Only parked Enrollment work may re-admit under an open active composition' USING ERRCODE = '55000';
      END IF;
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
  ELSE
    pending := NEW.status IN ('IN_PROGRESS', 'INDETERMINATE', 'RECONCILIATION_REQUIRED')
      OR (NEW.status = 'FAILED' AND NEW.failure_code = 'owner_reconciliation_required')
      OR coalesce(NEW.lease_expires_at > clock_timestamp(), false);
    IF pending AND attempt_state IN ('COMPLETE', 'TERMINATED', 'FAILED') THEN
      RAISE EXCEPTION 'A terminal Enrollment Attempt cannot create unresolved owner work' USING ERRCODE = '55000';
    END IF;
    -- A parked journey is not in-flight owner work. Only an unresolved operation pins its release;
    -- expired leases remain pinned until native reconciliation proves the owner's outcome.
    work_id := 'enrollment-operation:' || NEW.tenant_id || ':' || NEW.portal_enrollment_attempt_id || ':' || NEW.owner_invocation_id;
    PERFORM core.track_application_composition_durable_work(
      'commerce.customer-context', expected_revision, work_id, pending
    );
  END IF;
  RETURN NEW;
END;
$function$;


--> statement-breakpoint
CREATE OR REPLACE FUNCTION "commerce_customer_context"."portal_enrollment_attempt_projection"(
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
    coalesce(attempt.continuation_composition_revision, attempt.composition_revision)
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
CREATE FUNCTION commerce_customer_context.admit_portal_enrollment_attempt(
  p_tenant_id uuid, p_attempt_id uuid, p_composition_revision text
) RETURNS TABLE(admitted boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
DECLARE
  attempt commerce_customer_context.portal_enrollment_attempts%ROWTYPE;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified operation Tenant mismatch' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('ontos.application-composition-authority', 0));
  IF NOT EXISTS (
    SELECT 1 FROM core.application_composition_authority authority
    WHERE authority.authority_key = 'active' AND authority.revision = p_composition_revision
      AND authority.phase = 'active' AND authority.valid_until > clock_timestamp()
      AND authority.durable_work_admission = 'open'
  ) THEN
    RAISE EXCEPTION 'Enrollment continuation requires the current open active composition' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO attempt FROM commerce_customer_context.portal_enrollment_attempts journal
    WHERE journal.tenant_id = p_tenant_id AND journal.portal_enrollment_attempt_id = p_attempt_id
    FOR UPDATE;
  IF NOT FOUND OR attempt.state IN ('COMPLETE', 'TERMINATED', 'FAILED') THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;
  IF nullif(current_setting('ontos.legal_entity_id', true), '') IS NOT NULL
    AND attempt.target_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified operation Legal Entity mismatch' USING ERRCODE = '42501';
  END IF;
  -- The trigger serializes this admission against every owner operation. It never rewrites
  -- the original release, owner identities, Attempt revision, leases or sweep budget.
  UPDATE commerce_customer_context.portal_enrollment_attempts journal
    SET continuation_composition_revision = p_composition_revision
    WHERE journal.tenant_id = p_tenant_id AND journal.portal_enrollment_attempt_id = p_attempt_id;
  RETURN QUERY SELECT true;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.admit_portal_enrollment_attempt(uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.admit_portal_enrollment_attempt(uuid, uuid, text) TO ontos_runtime;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "commerce_customer_context"."claim_portal_enrollment_sweep"(
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
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('ontos.application-composition-authority', 0));
  IF NOT EXISTS (
    SELECT 1 FROM core.application_composition_authority authority
    WHERE authority.authority_key = 'active' AND authority.revision = p_composition_revision
      AND authority.phase IN ('active', 'draining') AND authority.valid_until > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'Enrollment sweep requires its captured active composition' USING ERRCODE = '55000';
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
    continuation_composition_revision = p_composition_revision,
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
    AND attempt.state NOT IN ('COMPLETE', 'TERMINATED', 'FAILED')
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
-- Reconcile only this owner's old accounting identities from the native journal. No Attempt,
-- owner outcome, lease, revision or budget changes during schema migration.
INSERT INTO core.application_composition_durable_work(owner_module_key, original_revision, work_id)
SELECT 'commerce.customer-context', coalesce(attempt.continuation_composition_revision, attempt.composition_revision),
  'enrollment-operation:' || operation.tenant_id || ':' || operation.portal_enrollment_attempt_id || ':' || operation.owner_invocation_id
FROM commerce_customer_context.portal_enrollment_owner_operations operation
JOIN commerce_customer_context.portal_enrollment_attempts attempt
  ON attempt.tenant_id = operation.tenant_id AND attempt.portal_enrollment_attempt_id = operation.portal_enrollment_attempt_id
WHERE operation.status IN ('IN_PROGRESS', 'INDETERMINATE', 'RECONCILIATION_REQUIRED')
  OR (operation.status = 'FAILED' AND operation.failure_code = 'owner_reconciliation_required')
  OR coalesce(operation.lease_expires_at > clock_timestamp(), false)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DELETE FROM core.application_composition_durable_work work
USING commerce_customer_context.portal_enrollment_attempts attempt
WHERE work.owner_module_key = 'commerce.customer-context'
  AND work.original_revision = attempt.composition_revision
  AND work.work_id = 'enrollment-attempt:' || attempt.tenant_id || ':' || attempt.portal_enrollment_attempt_id;
