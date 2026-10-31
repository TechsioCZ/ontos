-- A completed FAILED owner_reconciliation_required answer parks without holding publication.
-- Unknown effects remain fenced. Domain completion still requires the parked answer to reconcile.
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
              OR (operation.status = 'FAILED' AND operation.failure_code = 'owner_reconciliation_required'
                AND operation.completed_at IS NULL)
              OR operation.lease_owner IS NOT NULL OR operation.lease_token IS NOT NULL
              OR operation.lease_expires_at IS NOT NULL)
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
      OR (NEW.status = 'FAILED' AND NEW.failure_code = 'owner_reconciliation_required' AND NEW.completed_at IS NULL)
      OR NEW.lease_owner IS NOT NULL OR NEW.lease_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL;
    IF (pending OR (NEW.status = 'FAILED' AND NEW.failure_code = 'owner_reconciliation_required'))
      AND attempt_state IN ('COMPLETE', 'TERMINATED', 'FAILED') THEN
      RAISE EXCEPTION 'A terminal Enrollment Attempt cannot create unresolved owner work' USING ERRCODE = '55000';
    END IF;
    -- A completed owner answer awaiting governed review is parked, not in flight. The journal
    -- retains reconciliation authority across releases; unknown effects and every retained lease
    -- still pin their admitted release until native reconciliation proves their outcome.
    work_id := 'enrollment-operation:' || NEW.tenant_id || ':' || NEW.portal_enrollment_attempt_id || ':' || NEW.owner_invocation_id;
    PERFORM core.track_application_composition_durable_work(
      'commerce.customer-context', expected_revision, work_id, pending
    );
  END IF;
  RETURN NEW;
END;
$function$;
