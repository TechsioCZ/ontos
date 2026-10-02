-- Durable enrollment is work produced by the release that created its Attempt. The native
-- journal mutation itself holds the publication fence, including scheduled continuations and
-- SECURITY DEFINER routines that run after the original Action transaction has committed.
CREATE FUNCTION "commerce_customer_context"."guard_enrollment_composition_revision"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
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
    IF NEW.state IN ('COMPLETE', 'TERMINATED') AND EXISTS (
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
    pending := NEW.state NOT IN ('COMPLETE', 'TERMINATED');
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
    IF pending AND attempt_state IN ('COMPLETE', 'TERMINATED') THEN
      RAISE EXCEPTION 'A terminal Enrollment Attempt cannot create unresolved owner work' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."guard_enrollment_composition_revision"() FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE TRIGGER "ccc_portal_enrollment_attempts_composition_fence"
BEFORE INSERT OR UPDATE ON "commerce_customer_context"."portal_enrollment_attempts"
FOR EACH ROW EXECUTE FUNCTION "commerce_customer_context"."guard_enrollment_composition_revision"();
--> statement-breakpoint
CREATE TRIGGER "ccc_portal_enrollment_owner_operations_composition_fence"
BEFORE INSERT OR UPDATE ON "commerce_customer_context"."portal_enrollment_owner_operations"
FOR EACH ROW EXECUTE FUNCTION "commerce_customer_context"."guard_enrollment_composition_revision"();
