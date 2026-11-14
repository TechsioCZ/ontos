-- A sweep budget spent under one release says nothing about the next: when the recovery worker could
-- not read the provider schema, every verified Attempt it swept spent its whole budget on that one
-- fault and stayed IN_PROGRESS for good, although the release that fixed the fault could finish it.
-- The budget is therefore kept per approved composition as well as per revision.
ALTER TABLE "commerce_customer_context"."portal_enrollment_attempts" ADD COLUMN "sweep_composition_revision" text;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "commerce_customer_context"."list_due_portal_enrollment_attempts"(
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
  active_revision text;
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
  SELECT authority.revision INTO active_revision
  FROM core.application_composition_authority AS authority
  WHERE authority.authority_key = 'active';
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
    -- Attempt back while it still stands at the revision that count was spent against, under the
    -- composition it was spent in: anything that moves the Attempt — a read that resumed it, an owner
    -- outcome — makes it due again, and so does a new release, which can fix what the sweeps kept
    -- halting on.
    -- An owner still deciding on `owner_reconciliation_required` is exempt from the hard cut-off; it backs off instead.
    AND (
      NOT (
        attempt.sweep_revision = attempt.revision
        AND attempt.sweep_composition_revision IS NOT DISTINCT FROM active_revision
        AND attempt.sweep_count >= p_max_sweeps
      )
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
  -- A revision or composition the count was not spent against starts the budget over, which is how
  -- any state or revision change, or a new release, releases an Attempt the budget held — not a rule
  -- that has to predict one. Owner-pending attempts get a growing claim instead of a cut-off, capped
  -- at 64x.
  UPDATE commerce_customer_context.portal_enrollment_attempts AS attempt
  SET
    continuation_composition_revision = p_composition_revision,
    sweep_composition_revision = p_composition_revision,
    sweep_count = CASE WHEN (attempt.sweep_revision IS DISTINCT FROM p_revision OR attempt.sweep_composition_revision IS DISTINCT FROM p_composition_revision) THEN 1 ELSE attempt.sweep_count + 1 END,
    sweep_revision = p_revision,
    sweep_claimed_until = now_at + make_interval(secs =>
      (greatest(p_claim_ttl_millis, 0)::double precision / 1000)
      * CASE
          WHEN owner_pending THEN least(
            power(2, greatest(
              (CASE WHEN (attempt.sweep_revision IS DISTINCT FROM p_revision OR attempt.sweep_composition_revision IS DISTINCT FROM p_composition_revision) THEN 1 ELSE attempt.sweep_count + 1 END) - 1,
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
    AND (
      owner_pending
      OR attempt.sweep_revision IS DISTINCT FROM p_revision
      OR attempt.sweep_composition_revision IS DISTINCT FROM p_composition_revision
      OR attempt.sweep_count < p_max_sweeps
    )
  RETURNING attempt.sweep_count INTO claimed;
  IF claimed IS NULL THEN
    -- The claim failed, which is an answer rather than a fault: another replica holds this pass, or
    -- the budget at this revision and composition is spent. An Attempt that is not there at all is neither.
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
