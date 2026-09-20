-- The continuation sweeper's durable budget: how many fruitless sweeps an Attempt has had while
-- standing at `sweep_revision`. Keeping it on the row rather than in a worker's memory is what lets
-- the due-work listing exclude a spent Attempt in SQL, so an exhausted prefix can never fill a page
-- ahead of newer work, and what makes the count survive the process that spent it.
--
-- `sweep_claimed_until` records who is sweeping the Attempt right now. Every replica's listing
-- offers the same due row, so the budget above can only be spent once per pass if taking it is also
-- taking the row: a claim is what makes the two one act. It expires on its own because the replica
-- holding it may be the process that just died, and a claim nothing can release would withhold the
-- Attempt for good.
ALTER TABLE "commerce_customer_context"."portal_enrollment_attempts" ADD COLUMN "sweep_claimed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."portal_enrollment_attempts" ADD COLUMN "sweep_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."portal_enrollment_attempts" ADD COLUMN "sweep_revision" integer;--> statement-breakpoint

-- The durable due-work index for the continuation sweeper, and the one Attempt surface that answers
-- before any Tenant is known. An Attempt whose worker disappeared is discoverable only from the
-- journal itself, and the process that replaces that worker has never served the Attempt's Tenant,
-- so a per-Tenant listing can only ever find the Attempts this deployment did not lose.
--
-- Cross-Tenant work discovery is what the Core Outbox poller already does: it claims the next due
-- delivery of any Tenant on the runtime role, in a transaction with no operational scope installed,
-- and installs the Tenant afterwards to do the work. There is no worker setting and no worker role
-- in this system — running outside every Tenant scope is the worker scope. So this routine's guard
-- is the exact inverse of its siblings': a transaction that has installed a verified Tenant is a
-- request, and no request may read across the Tenant boundary.
--
-- It answers with addressing only — Tenant, Attempt, state, revision, activity — never Attempt
-- content; the caller re-enters each Attempt's own Tenant scope to read or advance it.
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
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
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
    attempt.updated_at
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
    AND NOT (attempt.sweep_revision = attempt.revision AND attempt.sweep_count >= p_max_sweeps)
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

-- The owning half of the due-work surface: one replica takes one Attempt for one sweep, and the
-- budget is charged in the same act. Taking the row and charging it cannot be two statements —
-- every replica's listing reports the same due Attempt, so an accounting that charged first would
-- let each loser of the transition claim spend a sweep it never performed, and a handful of
-- replicas would exhaust the budget of an Attempt that was swept exactly once.
--
-- The claim is therefore the whole routine: a single UPDATE that succeeds only while no live claim
-- stands and the budget at this revision is unspent, and answers NULL otherwise. Two concurrent
-- callers serialize on the row, and the loser re-checks the very predicate the winner just
-- falsified, so exactly one of them is charged.
--
-- It is the worker's own bookkeeping rather than a transition, so it moves neither `revision` nor
-- `updated_at` — an Attempt a sweep could not move must keep its place in the listing's activity
-- order, and a count that re-aged the row would hide it instead.
--
-- The guard is the listing's, for the same reason: this is a cross-Tenant worker surface, and a
-- transaction that installed a verified Tenant is a request. Running outside every Tenant scope is
-- the worker scope.
CREATE FUNCTION "commerce_customer_context"."claim_portal_enrollment_sweep"(
  p_tenant_id uuid,
  p_attempt_id uuid,
  p_revision integer,
  p_max_sweeps integer,
  p_claim_ttl_millis integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $function$
DECLARE
  now_at timestamptz := statement_timestamp();
  claimed integer;
BEGIN
  IF nullif(current_setting('ontos.tenant_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'cross-Tenant Attempt sweep accounting requires worker scope' USING ERRCODE = '42501';
  END IF;
  -- A revision the count was not spent against starts the budget over, which is how any state or
  -- revision change — not a rule that has to predict one — releases an Attempt the budget held.
  UPDATE commerce_customer_context.portal_enrollment_attempts AS attempt
  SET
    sweep_count = CASE WHEN attempt.sweep_revision IS DISTINCT FROM p_revision THEN 1 ELSE attempt.sweep_count + 1 END,
    sweep_revision = p_revision,
    sweep_claimed_until = now_at + make_interval(secs => greatest(p_claim_ttl_millis, 0)::double precision / 1000)
  WHERE attempt.tenant_id = p_tenant_id
    AND attempt.portal_enrollment_attempt_id = p_attempt_id
    AND attempt.revision = p_revision -- a listing snapshot the Attempt has outgrown claims nothing
    AND (attempt.sweep_claimed_until IS NULL OR attempt.sweep_claimed_until <= now_at)
    AND NOT (attempt.sweep_revision = p_revision AND attempt.sweep_count >= p_max_sweeps)
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

REVOKE ALL ON FUNCTION "commerce_customer_context"."list_due_portal_enrollment_attempts"(integer, timestamptz, uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION "commerce_customer_context"."claim_portal_enrollment_sweep"(uuid, uuid, integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."list_due_portal_enrollment_attempts"(integer, timestamptz, uuid, integer, integer) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."claim_portal_enrollment_sweep"(uuid, uuid, integer, integer, integer) TO "ontos_runtime";
