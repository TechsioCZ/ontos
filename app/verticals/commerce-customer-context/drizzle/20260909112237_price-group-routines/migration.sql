-- Price Group assignment persistence is exposed only through these audited owner routines. Core
-- injects the verified Tenant and Selling Legal Entity arguments, while FORCE RLS independently
-- checks the already-installed transaction-local scope.
-- A cancelled future assignment never has an effective business interval. Its effective_to value
-- therefore retains the exact requested cancellation instant for deterministic replay checks.
ALTER TABLE "commerce_customer_context"."customer_price_group_assignments"
  DROP CONSTRAINT "ccc_price_assignments_period_ck",
  ADD CONSTRAINT "ccc_price_assignments_period_ck" CHECK (
    "lifecycle" = 'CANCELLED' OR "effective_to" IS NULL OR "effective_to" > "effective_from"
  );
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "commerce_customer_context"."inspect_price_group_profile"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_profile_id text,
  p_profile_kind text,
  p_effective_at timestamptz,
  p_counterparty_resource_id text
)
RETURNS TABLE (
  outcome text,
  revision integer,
  profile_state text,
  counterparty_resource_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
SET row_security = on
AS $$
DECLARE
  v_profile commerce_customer_context.customer_profiles%ROWTYPE;
  v_counterparty_resource_id text;
  v_profile_state text;
  v_profile_revision integer;
BEGIN
  IF current_setting('ontos.tenant_id', true) IS DISTINCT FROM p_tenant_id::text
     OR current_setting('ontos.legal_entity_id', true) IS DISTINCT FROM p_legal_entity_id::text
     OR p_effective_at IS NULL
  THEN
    RETURN QUERY SELECT 'NOT_FOUND'::text, 0, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT profile.*
  INTO v_profile
  FROM commerce_customer_context.customer_profiles AS profile
  WHERE profile.tenant_id = p_tenant_id
    AND profile.legal_entity_id = p_legal_entity_id
    AND profile.customer_profile_id::text = p_profile_id
    AND profile.profile_kind = p_profile_kind;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NOT_FOUND'::text, 0, NULL::text, NULL::text;
    RETURN;
  END IF;

  IF p_profile_kind = 'RETAIL' THEN
    IF p_counterparty_resource_id IS NOT NULL OR NOT EXISTS (
      SELECT 1
      FROM commerce_customer_context.retail_customer_profiles AS retail
      WHERE retail.tenant_id = p_tenant_id
        AND retail.legal_entity_id = p_legal_entity_id
        AND retail.retail_customer_profile_id = v_profile.customer_profile_id
    ) THEN
      RETURN QUERY SELECT 'NOT_FOUND'::text, 0, NULL::text, NULL::text;
      RETURN;
    END IF;
  ELSIF p_profile_kind = 'COUNTERPARTY' THEN
    SELECT counterparty.counterparty_resource_id
    INTO v_counterparty_resource_id
    FROM commerce_customer_context.counterparty_purchasing_profiles AS counterparty
    WHERE counterparty.tenant_id = p_tenant_id
      AND counterparty.legal_entity_id = p_legal_entity_id
      AND counterparty.counterparty_purchasing_profile_id = v_profile.customer_profile_id
      AND (
        p_counterparty_resource_id IS NULL
        OR counterparty.counterparty_resource_id = p_counterparty_resource_id
      );
    IF NOT FOUND THEN
      RETURN QUERY SELECT 'NOT_FOUND'::text, 0, NULL::text, NULL::text;
      RETURN;
    END IF;
  ELSE
    RETURN QUERY SELECT 'NOT_FOUND'::text, 0, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT history.to_lifecycle, history.revision
  INTO v_profile_state, v_profile_revision
  FROM commerce_customer_context.customer_profile_lifecycle_history AS history
  WHERE history.tenant_id = p_tenant_id
    AND history.legal_entity_id = p_legal_entity_id
    AND history.customer_profile_id = v_profile.customer_profile_id
    AND history.recorded_at <= p_effective_at
  ORDER BY history.recorded_at DESC, history.revision DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NOT_FOUND'::text, 0, NULL::text, NULL::text;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    'CURRENT'::text,
    v_profile_revision,
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM commerce_customer_context.profile_reconciliation_cases AS reconciliation
        WHERE reconciliation.tenant_id = p_tenant_id
          AND reconciliation.legal_entity_id = p_legal_entity_id
          AND reconciliation.recorded_at <= p_effective_at
          AND (reconciliation.resolved_at IS NULL OR p_effective_at < reconciliation.resolved_at)
          AND (
            reconciliation.source_profile_id = v_profile.customer_profile_id
            OR reconciliation.colliding_profile_id = v_profile.customer_profile_id
            OR reconciliation.canonical_profile_id = v_profile.customer_profile_id
          )
      ) THEN 'RECONCILIATION_REQUIRED'
      ELSE v_profile_state
    END,
    v_counterparty_resource_id;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "commerce_customer_context"."read_price_group_assignments"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_profile_id text,
  p_profile_kind text
)
RETURNS TABLE (
  outcome text,
  assignment_id text,
  price_group_module_id text,
  price_group_resource_type text,
  price_group_resource_id text,
  catalog_revision integer,
  compatibility_contract_id text,
  compatibility_contract_revision integer,
  definition_revision integer,
  effective_from timestamptz,
  effective_to timestamptz,
  lifecycle text,
  revision integer,
  reason text,
  recorded_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
SET row_security = on
AS $$
BEGIN
  IF current_setting('ontos.tenant_id', true) IS DISTINCT FROM p_tenant_id::text
     OR current_setting('ontos.legal_entity_id', true) IS DISTINCT FROM p_legal_entity_id::text
     OR NOT EXISTS (
       SELECT 1
       FROM commerce_customer_context.customer_profiles AS profile
       WHERE profile.tenant_id = p_tenant_id
         AND profile.legal_entity_id = p_legal_entity_id
         AND profile.customer_profile_id::text = p_profile_id
         AND profile.profile_kind = p_profile_kind
         AND (
           (p_profile_kind = 'RETAIL' AND EXISTS (
             SELECT 1
             FROM commerce_customer_context.retail_customer_profiles AS retail
             WHERE retail.tenant_id = p_tenant_id
               AND retail.legal_entity_id = p_legal_entity_id
               AND retail.retail_customer_profile_id = profile.customer_profile_id
           ))
           OR
           (p_profile_kind = 'COUNTERPARTY' AND EXISTS (
             SELECT 1
             FROM commerce_customer_context.counterparty_purchasing_profiles AS counterparty
             WHERE counterparty.tenant_id = p_tenant_id
               AND counterparty.legal_entity_id = p_legal_entity_id
               AND counterparty.counterparty_purchasing_profile_id = profile.customer_profile_id
           ))
         )
     )
  THEN
    RETURN QUERY
    SELECT 'PROFILE_NOT_FOUND'::text, NULL::text, NULL::text, NULL::text, NULL::text,
      NULL::integer, NULL::text, NULL::integer, NULL::integer, NULL::timestamptz,
      NULL::timestamptz, NULL::text, NULL::integer, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM commerce_customer_context.customer_price_group_assignments AS assignment
    WHERE assignment.tenant_id = p_tenant_id
      AND assignment.legal_entity_id = p_legal_entity_id
      AND assignment.customer_profile_id::text = p_profile_id
  ) THEN
    RETURN QUERY
    SELECT 'FOUND'::text, NULL::text, NULL::text, NULL::text, NULL::text,
      NULL::integer, NULL::text, NULL::integer, NULL::integer, NULL::timestamptz,
      NULL::timestamptz, NULL::text, NULL::integer, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    'FOUND'::text,
    selected.customer_price_group_assignment_id::text,
    selected.price_group_module_id,
    selected.price_group_resource_type,
    selected.price_group_resource_id,
    selected.catalog_revision,
    selected.compatibility_contract_id,
    selected.compatibility_contract_revision,
    selected.definition_revision,
    selected.effective_from,
    selected.effective_to,
    selected.lifecycle,
    selected.revision,
    selected.reason,
    selected.recorded_at
  FROM (
    SELECT assignment.*
    FROM commerce_customer_context.customer_price_group_assignments AS assignment
    WHERE assignment.tenant_id = p_tenant_id
      AND assignment.legal_entity_id = p_legal_entity_id
      AND assignment.customer_profile_id::text = p_profile_id
    ORDER BY assignment.effective_from DESC, assignment.customer_price_group_assignment_id DESC
    LIMIT 200
  ) AS selected
  ORDER BY selected.effective_from, selected.customer_price_group_assignment_id;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "commerce_customer_context"."resolve_price_group_assignments"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_profile_id text,
  p_profile_kind text,
  p_effective_at timestamptz
)
RETURNS TABLE (
  outcome text,
  assignment_id text,
  price_group_module_id text,
  price_group_resource_type text,
  price_group_resource_id text,
  catalog_revision integer,
  compatibility_contract_id text,
  compatibility_contract_revision integer,
  definition_revision integer,
  effective_from timestamptz,
  effective_to timestamptz,
  lifecycle text,
  revision integer,
  reason text,
  recorded_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
SET row_security = on
AS $$
BEGIN
  IF current_setting('ontos.tenant_id', true) IS DISTINCT FROM p_tenant_id::text
     OR current_setting('ontos.legal_entity_id', true) IS DISTINCT FROM p_legal_entity_id::text
     OR p_effective_at IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM commerce_customer_context.customer_profiles AS profile
       WHERE profile.tenant_id = p_tenant_id
         AND profile.legal_entity_id = p_legal_entity_id
         AND profile.customer_profile_id::text = p_profile_id
         AND profile.profile_kind = p_profile_kind
         AND (
           (p_profile_kind = 'RETAIL' AND EXISTS (
             SELECT 1
             FROM commerce_customer_context.retail_customer_profiles AS retail
             WHERE retail.tenant_id = p_tenant_id
               AND retail.legal_entity_id = p_legal_entity_id
               AND retail.retail_customer_profile_id = profile.customer_profile_id
           ))
           OR
           (p_profile_kind = 'COUNTERPARTY' AND EXISTS (
             SELECT 1
             FROM commerce_customer_context.counterparty_purchasing_profiles AS counterparty
             WHERE counterparty.tenant_id = p_tenant_id
               AND counterparty.legal_entity_id = p_legal_entity_id
               AND counterparty.counterparty_purchasing_profile_id = profile.customer_profile_id
           ))
         )
     )
  THEN
    RETURN QUERY
    SELECT 'PROFILE_NOT_FOUND'::text, NULL::text, NULL::text, NULL::text, NULL::text,
      NULL::integer, NULL::text, NULL::integer, NULL::integer, NULL::timestamptz,
      NULL::timestamptz, NULL::text, NULL::integer, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM commerce_customer_context.customer_price_group_assignments AS assignment
    WHERE assignment.tenant_id = p_tenant_id
      AND assignment.legal_entity_id = p_legal_entity_id
      AND assignment.customer_profile_id::text = p_profile_id
      AND assignment.lifecycle = 'ACTIVE'
      AND assignment.effective_from <= p_effective_at
      AND (assignment.effective_to IS NULL OR p_effective_at < assignment.effective_to)
  ) THEN
    RETURN QUERY
    SELECT 'FOUND'::text, NULL::text, NULL::text, NULL::text, NULL::text,
      NULL::integer, NULL::text, NULL::integer, NULL::integer, NULL::timestamptz,
      NULL::timestamptz, NULL::text, NULL::integer, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  -- The exclusion constraint should make this cardinality one. Returning at most two lets the
  -- domain resolver fail closed as INCONSISTENT if legacy or corrupt state violates that invariant,
  -- while future schedules can never displace the assignment effective at the trusted instant.
  RETURN QUERY
  SELECT
    'FOUND'::text,
    assignment.customer_price_group_assignment_id::text,
    assignment.price_group_module_id,
    assignment.price_group_resource_type,
    assignment.price_group_resource_id,
    assignment.catalog_revision,
    assignment.compatibility_contract_id,
    assignment.compatibility_contract_revision,
    assignment.definition_revision,
    assignment.effective_from,
    assignment.effective_to,
    assignment.lifecycle,
    assignment.revision,
    assignment.reason,
    assignment.recorded_at
  FROM commerce_customer_context.customer_price_group_assignments AS assignment
  WHERE assignment.tenant_id = p_tenant_id
    AND assignment.legal_entity_id = p_legal_entity_id
    AND assignment.customer_profile_id::text = p_profile_id
    AND assignment.lifecycle = 'ACTIVE'
    AND assignment.effective_from <= p_effective_at
    AND (assignment.effective_to IS NULL OR p_effective_at < assignment.effective_to)
  ORDER BY assignment.effective_from DESC, assignment.customer_price_group_assignment_id DESC
  LIMIT 2;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "commerce_customer_context"."assign_price_group"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_profile_id text,
  p_profile_kind text,
  p_counterparty_resource_id text,
  p_price_group_module_id text,
  p_price_group_resource_type text,
  p_price_group_resource_id text,
  p_catalog_revision integer,
  p_compatibility_contract_id text,
  p_compatibility_contract_revision integer,
  p_definition_revision integer,
  p_effective_from timestamptz,
  p_effective_to timestamptz,
  p_expected_profile_revision integer,
  p_reason text,
  p_recorded_at timestamptz,
  p_actor_principal_id uuid,
  p_action_invocation_id uuid
)
RETURNS TABLE (
  outcome text,
  changed boolean,
  replaced_assignment_id text,
  profile_state text,
  assignment_id text,
  price_group_module_id text,
  price_group_resource_type text,
  price_group_resource_id text,
  catalog_revision integer,
  compatibility_contract_id text,
  compatibility_contract_revision integer,
  definition_revision integer,
  effective_from timestamptz,
  effective_to timestamptz,
  lifecycle text,
  revision integer,
  reason text,
  recorded_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
SET row_security = on
AS $$
DECLARE
  v_profile commerce_customer_context.customer_profiles%ROWTYPE;
  v_profile_state text;
  v_profile_revision integer;
  v_existing commerce_customer_context.customer_price_group_assignments%ROWTYPE;
  v_inserted commerce_customer_context.customer_price_group_assignments%ROWTYPE;
  v_replaced_assignment_id uuid;
BEGIN
  IF current_setting('ontos.tenant_id', true) IS DISTINCT FROM p_tenant_id::text
     OR current_setting('ontos.legal_entity_id', true) IS DISTINCT FROM p_legal_entity_id::text
  THEN
    RETURN QUERY SELECT 'SCOPE_MISMATCH'::text, false, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::integer, NULL::text,
      NULL::integer, NULL::integer, NULL::timestamptz, NULL::timestamptz, NULL::text,
      NULL::integer, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  IF p_effective_from < p_recorded_at THEN
    RETURN QUERY SELECT 'RETROACTIVE_SCHEDULE'::text, false, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::integer, NULL::text,
      NULL::integer, NULL::integer, NULL::timestamptz, NULL::timestamptz, NULL::text,
      NULL::integer, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT profile.*
  INTO v_profile
  FROM commerce_customer_context.customer_profiles AS profile
  WHERE profile.tenant_id = p_tenant_id
    AND profile.legal_entity_id = p_legal_entity_id
    AND profile.customer_profile_id::text = p_profile_id
    AND profile.profile_kind = p_profile_kind
  FOR UPDATE;

  IF NOT FOUND
     OR (p_profile_kind = 'RETAIL' AND (
       p_counterparty_resource_id IS NOT NULL OR NOT EXISTS (
         SELECT 1 FROM commerce_customer_context.retail_customer_profiles AS retail
         WHERE retail.tenant_id = p_tenant_id
           AND retail.legal_entity_id = p_legal_entity_id
           AND retail.retail_customer_profile_id = v_profile.customer_profile_id
       )
     ))
     OR (p_profile_kind = 'COUNTERPARTY' AND NOT EXISTS (
       SELECT 1 FROM commerce_customer_context.counterparty_purchasing_profiles AS counterparty
       WHERE counterparty.tenant_id = p_tenant_id
         AND counterparty.legal_entity_id = p_legal_entity_id
         AND counterparty.counterparty_purchasing_profile_id = v_profile.customer_profile_id
         AND p_counterparty_resource_id IS NOT NULL
         AND counterparty.counterparty_resource_id = p_counterparty_resource_id
     ))
     OR p_profile_kind NOT IN ('RETAIL', 'COUNTERPARTY')
  THEN
    RETURN QUERY SELECT 'PROFILE_NOT_FOUND'::text, false, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::integer, NULL::text,
      NULL::integer, NULL::integer, NULL::timestamptz, NULL::timestamptz, NULL::text,
      NULL::integer, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT history.to_lifecycle, history.revision
  INTO v_profile_state, v_profile_revision
  FROM commerce_customer_context.customer_profile_lifecycle_history AS history
  WHERE history.tenant_id = p_tenant_id
    AND history.legal_entity_id = p_legal_entity_id
    AND history.customer_profile_id = v_profile.customer_profile_id
    AND history.recorded_at <= p_effective_from
  ORDER BY history.recorded_at DESC, history.revision DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'PROFILE_NOT_FOUND'::text, false, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::integer, NULL::text,
      NULL::integer, NULL::integer, NULL::timestamptz, NULL::timestamptz, NULL::text,
      NULL::integer, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  IF v_profile_state <> 'ACTIVE' OR EXISTS (
    SELECT 1
    FROM commerce_customer_context.profile_reconciliation_cases AS reconciliation
    WHERE reconciliation.tenant_id = p_tenant_id
      AND reconciliation.legal_entity_id = p_legal_entity_id
      AND reconciliation.recorded_at <= p_effective_from
      AND (reconciliation.resolved_at IS NULL OR p_effective_from < reconciliation.resolved_at)
      AND (
        reconciliation.source_profile_id = v_profile.customer_profile_id
        OR reconciliation.colliding_profile_id = v_profile.customer_profile_id
        OR reconciliation.canonical_profile_id = v_profile.customer_profile_id
      )
  ) THEN
    RETURN QUERY SELECT 'PROFILE_INELIGIBLE'::text, false, NULL::text,
      CASE WHEN v_profile_state = 'ACTIVE' THEN 'RECONCILIATION_REQUIRED' ELSE v_profile_state END,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::integer, NULL::text,
      NULL::integer, NULL::integer, NULL::timestamptz, NULL::timestamptz, NULL::text,
      NULL::integer, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  -- Equivalent business state wins before CAS so independent retries remain idempotent.
  SELECT assignment.*
  INTO v_existing
  FROM commerce_customer_context.customer_price_group_assignments AS assignment
  WHERE assignment.tenant_id = p_tenant_id
    AND assignment.legal_entity_id = p_legal_entity_id
    AND assignment.customer_profile_id = v_profile.customer_profile_id
    AND assignment.lifecycle IN ('ACTIVE', 'ENDED')
    AND assignment.price_group_module_id = p_price_group_module_id
    AND assignment.price_group_resource_type = p_price_group_resource_type
    AND assignment.price_group_resource_id = p_price_group_resource_id
    AND assignment.catalog_revision = p_catalog_revision
    AND assignment.compatibility_contract_id = p_compatibility_contract_id
    AND assignment.compatibility_contract_revision = p_compatibility_contract_revision
    AND assignment.definition_revision = p_definition_revision
    AND assignment.effective_from = p_effective_from
    AND assignment.effective_to IS NOT DISTINCT FROM p_effective_to
  ORDER BY assignment.customer_price_group_assignment_id
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    RETURN QUERY SELECT 'UNCHANGED'::text, false, NULL::text, NULL::text,
      v_existing.customer_price_group_assignment_id::text, v_existing.price_group_module_id,
      v_existing.price_group_resource_type, v_existing.price_group_resource_id,
      v_existing.catalog_revision, v_existing.compatibility_contract_id,
      v_existing.compatibility_contract_revision, v_existing.definition_revision,
      v_existing.effective_from, v_existing.effective_to, v_existing.lifecycle,
      v_existing.revision, v_existing.reason, v_existing.recorded_at;
    RETURN;
  END IF;

  IF v_profile_revision <> p_expected_profile_revision THEN
    RETURN QUERY SELECT 'PROFILE_REVISION_CONFLICT'::text, false, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::integer, NULL::text,
      NULL::integer, NULL::integer, NULL::timestamptz, NULL::timestamptz, NULL::text,
      NULL::integer, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  -- The profile lock serializes all assignment writers. The single predecessor whose bounded or
  -- open period covers the replacement instant is truncated, or cancelled when both periods start
  -- together; every other overlap is an explicit conflict.
  SELECT assignment.customer_price_group_assignment_id
  INTO v_replaced_assignment_id
  FROM commerce_customer_context.customer_price_group_assignments AS assignment
  WHERE assignment.tenant_id = p_tenant_id
    AND assignment.legal_entity_id = p_legal_entity_id
    AND assignment.customer_profile_id = v_profile.customer_profile_id
    AND assignment.lifecycle IN ('ACTIVE', 'ENDED')
    AND assignment.effective_from <= p_effective_from
    AND (assignment.effective_to IS NULL OR p_effective_from < assignment.effective_to)
  ORDER BY assignment.effective_from DESC
  LIMIT 1
  FOR UPDATE;

  IF EXISTS (
    SELECT 1
    FROM commerce_customer_context.customer_price_group_assignments AS assignment
    WHERE assignment.tenant_id = p_tenant_id
      AND assignment.legal_entity_id = p_legal_entity_id
      AND assignment.customer_profile_id = v_profile.customer_profile_id
      AND assignment.lifecycle IN ('ACTIVE', 'ENDED')
      AND assignment.customer_price_group_assignment_id IS DISTINCT FROM v_replaced_assignment_id
      AND tstzrange(assignment.effective_from, coalesce(assignment.effective_to, 'infinity'::timestamptz), '[)')
          && tstzrange(p_effective_from, coalesce(p_effective_to, 'infinity'::timestamptz), '[)')
  ) THEN
    RETURN QUERY SELECT 'OVERLAP'::text, false, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::integer, NULL::text,
      NULL::integer, NULL::integer, NULL::timestamptz, NULL::timestamptz, NULL::text,
      NULL::integer, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  IF v_replaced_assignment_id IS NOT NULL THEN
    -- Preserve the predecessor's original attribution. The replacing Action's immutable audit and
    -- outbox evidence records this transition without rewriting the historical source fact.
    UPDATE commerce_customer_context.customer_price_group_assignments AS assignment
    SET effective_to = p_effective_from,
        lifecycle = CASE
          WHEN assignment.effective_from = p_effective_from THEN 'CANCELLED'
          ELSE 'ENDED'
        END,
        revision = assignment.revision + 1
    WHERE assignment.tenant_id = p_tenant_id
      AND assignment.legal_entity_id = p_legal_entity_id
      AND assignment.customer_price_group_assignment_id = v_replaced_assignment_id;
  END IF;

  INSERT INTO commerce_customer_context.customer_price_group_assignments (
    tenant_id, legal_entity_id, customer_profile_id, price_group_module_id,
    price_group_resource_type, price_group_resource_id, catalog_revision,
    compatibility_contract_id, compatibility_contract_revision, definition_revision,
    effective_from, effective_to, lifecycle, revision, action_invocation_id,
    actor_principal_id, reason, recorded_at
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_profile.customer_profile_id, p_price_group_module_id,
    p_price_group_resource_type, p_price_group_resource_id, p_catalog_revision,
    p_compatibility_contract_id, p_compatibility_contract_revision, p_definition_revision,
    p_effective_from, p_effective_to, 'ACTIVE', 1, p_action_invocation_id,
    p_actor_principal_id, p_reason, p_recorded_at
  )
  RETURNING * INTO v_inserted;

  RETURN QUERY SELECT 'ASSIGNED'::text, true, v_replaced_assignment_id::text, NULL::text,
    v_inserted.customer_price_group_assignment_id::text, v_inserted.price_group_module_id,
    v_inserted.price_group_resource_type, v_inserted.price_group_resource_id,
    v_inserted.catalog_revision, v_inserted.compatibility_contract_id,
    v_inserted.compatibility_contract_revision, v_inserted.definition_revision,
    v_inserted.effective_from, v_inserted.effective_to, v_inserted.lifecycle,
    v_inserted.revision, v_inserted.reason, v_inserted.recorded_at;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "commerce_customer_context"."remove_price_group_assignment"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_profile_id text,
  p_profile_kind text,
  p_counterparty_resource_id text,
  p_assignment_id text,
  p_effective_at timestamptz,
  p_expected_revision integer,
  p_reason text,
  p_recorded_at timestamptz,
  p_actor_principal_id uuid,
  p_action_invocation_id uuid
)
RETURNS TABLE (
  outcome text,
  changed boolean,
  current_revision integer,
  assignment_id text,
  price_group_module_id text,
  price_group_resource_type text,
  price_group_resource_id text,
  catalog_revision integer,
  compatibility_contract_id text,
  compatibility_contract_revision integer,
  definition_revision integer,
  effective_from timestamptz,
  effective_to timestamptz,
  lifecycle text,
  revision integer,
  reason text,
  recorded_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
SET row_security = on
AS $$
DECLARE
  v_profile commerce_customer_context.customer_profiles%ROWTYPE;
  v_assignment commerce_customer_context.customer_price_group_assignments%ROWTYPE;
BEGIN
  IF current_setting('ontos.tenant_id', true) IS DISTINCT FROM p_tenant_id::text
     OR current_setting('ontos.legal_entity_id', true) IS DISTINCT FROM p_legal_entity_id::text
  THEN
    RETURN QUERY SELECT 'SCOPE_MISMATCH'::text, false, 0, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::integer, NULL::text, NULL::integer, NULL::integer,
      NULL::timestamptz, NULL::timestamptz, NULL::text, NULL::integer, NULL::text,
      NULL::timestamptz;
    RETURN;
  END IF;

  IF p_effective_at < p_recorded_at THEN
    RETURN QUERY SELECT 'RETROACTIVE_SCHEDULE'::text, false, 0, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::integer, NULL::text, NULL::integer, NULL::integer,
      NULL::timestamptz, NULL::timestamptz, NULL::text, NULL::integer, NULL::text,
      NULL::timestamptz;
    RETURN;
  END IF;

  SELECT profile.*
  INTO v_profile
  FROM commerce_customer_context.customer_profiles AS profile
  WHERE profile.tenant_id = p_tenant_id
    AND profile.legal_entity_id = p_legal_entity_id
    AND profile.customer_profile_id::text = p_profile_id
    AND profile.profile_kind = p_profile_kind
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'PROFILE_NOT_FOUND'::text, false, 0, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::integer, NULL::text, NULL::integer, NULL::integer,
      NULL::timestamptz, NULL::timestamptz, NULL::text, NULL::integer, NULL::text,
      NULL::timestamptz;
    RETURN;
  END IF;

  IF (p_profile_kind = 'RETAIL' AND (
      p_counterparty_resource_id IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM commerce_customer_context.retail_customer_profiles AS retail
        WHERE retail.tenant_id = p_tenant_id
          AND retail.legal_entity_id = p_legal_entity_id
          AND retail.retail_customer_profile_id = v_profile.customer_profile_id
      )
    ))
    OR (p_profile_kind = 'COUNTERPARTY' AND NOT EXISTS (
      SELECT 1 FROM commerce_customer_context.counterparty_purchasing_profiles AS counterparty
      WHERE counterparty.tenant_id = p_tenant_id
        AND counterparty.legal_entity_id = p_legal_entity_id
        AND counterparty.counterparty_purchasing_profile_id = v_profile.customer_profile_id
        AND p_counterparty_resource_id IS NOT NULL
        AND counterparty.counterparty_resource_id = p_counterparty_resource_id
    ))
    OR p_profile_kind NOT IN ('RETAIL', 'COUNTERPARTY')
  THEN
    RETURN QUERY SELECT 'PROFILE_MISMATCH'::text, false, 0, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::integer, NULL::text, NULL::integer, NULL::integer,
      NULL::timestamptz, NULL::timestamptz, NULL::text, NULL::integer, NULL::text,
      NULL::timestamptz;
    RETURN;
  END IF;

  SELECT assignment.*
  INTO v_assignment
  FROM commerce_customer_context.customer_price_group_assignments AS assignment
  WHERE assignment.tenant_id = p_tenant_id
    AND assignment.legal_entity_id = p_legal_entity_id
    AND assignment.customer_price_group_assignment_id::text = p_assignment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'ASSIGNMENT_NOT_FOUND'::text, false, 0, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::integer, NULL::text, NULL::integer, NULL::integer,
      NULL::timestamptz, NULL::timestamptz, NULL::text, NULL::integer, NULL::text,
      NULL::timestamptz;
    RETURN;
  END IF;

  IF v_assignment.customer_profile_id <> v_profile.customer_profile_id THEN
    RETURN QUERY SELECT 'PROFILE_MISMATCH'::text, false, v_assignment.revision,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::integer, NULL::text,
      NULL::integer, NULL::integer, NULL::timestamptz, NULL::timestamptz, NULL::text,
      NULL::integer, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  -- A cancelled assignment retains the requested cancellation instant in effective_to. Only the
  -- exact same schedule is replay-equivalent; changing it is an explicit removal conflict.
  IF v_assignment.lifecycle = 'CANCELLED' THEN
    IF v_assignment.effective_to IS DISTINCT FROM p_effective_at THEN
      RETURN QUERY SELECT 'REMOVAL_CONFLICT'::text, false, v_assignment.revision,
        NULL::text, NULL::text, NULL::text, NULL::text, NULL::integer, NULL::text,
        NULL::integer, NULL::integer, NULL::timestamptz, NULL::timestamptz, NULL::text,
        NULL::integer, NULL::text, NULL::timestamptz;
    ELSE
      RETURN QUERY SELECT 'REMOVED'::text, false, v_assignment.revision,
        v_assignment.customer_price_group_assignment_id::text, v_assignment.price_group_module_id,
        v_assignment.price_group_resource_type, v_assignment.price_group_resource_id,
        v_assignment.catalog_revision, v_assignment.compatibility_contract_id,
        v_assignment.compatibility_contract_revision, v_assignment.definition_revision,
        v_assignment.effective_from, v_assignment.effective_to, v_assignment.lifecycle,
        v_assignment.revision, v_assignment.reason, v_assignment.recorded_at;
    END IF;
    RETURN;
  END IF;

  -- An ended assignment replays only at the already-retained boundary. An ACTIVE assignment that
  -- was created with this exact finite boundary is already absent from the requested instant, so
  -- removing it there is business-equivalent too and must not publish a changed-only removal fact.
  IF v_assignment.lifecycle IN ('ACTIVE', 'ENDED')
     AND v_assignment.effective_to = p_effective_at
  THEN
    RETURN QUERY SELECT 'REMOVED'::text, false, v_assignment.revision,
      v_assignment.customer_price_group_assignment_id::text, v_assignment.price_group_module_id,
      v_assignment.price_group_resource_type, v_assignment.price_group_resource_id,
      v_assignment.catalog_revision, v_assignment.compatibility_contract_id,
      v_assignment.compatibility_contract_revision, v_assignment.definition_revision,
      v_assignment.effective_from, v_assignment.effective_to, v_assignment.lifecycle,
      v_assignment.revision, v_assignment.reason, v_assignment.recorded_at;
    RETURN;
  END IF;

  IF v_assignment.revision <> p_expected_revision THEN
    RETURN QUERY SELECT 'REVISION_CONFLICT'::text, false, v_assignment.revision,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::integer, NULL::text,
      NULL::integer, NULL::integer, NULL::timestamptz, NULL::timestamptz, NULL::text,
      NULL::integer, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  IF v_assignment.lifecycle <> 'ACTIVE'
     OR (v_assignment.effective_to IS NOT NULL AND p_effective_at > v_assignment.effective_to)
  THEN
    RETURN QUERY SELECT 'REMOVAL_CONFLICT'::text, false, v_assignment.revision,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::integer, NULL::text,
      NULL::integer, NULL::integer, NULL::timestamptz, NULL::timestamptz, NULL::text,
      NULL::integer, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  -- Preserve assignment-creation attribution; the Remove Action owns immutable transition evidence.
  UPDATE commerce_customer_context.customer_price_group_assignments AS assignment
  SET effective_to = p_effective_at,
      lifecycle = CASE
        WHEN p_effective_at <= assignment.effective_from THEN 'CANCELLED'
        ELSE 'ENDED'
      END,
      revision = assignment.revision + 1
  WHERE assignment.tenant_id = p_tenant_id
    AND assignment.legal_entity_id = p_legal_entity_id
    AND assignment.customer_price_group_assignment_id = v_assignment.customer_price_group_assignment_id
  RETURNING * INTO v_assignment;

  RETURN QUERY SELECT 'REMOVED'::text, true, v_assignment.revision,
    v_assignment.customer_price_group_assignment_id::text, v_assignment.price_group_module_id,
    v_assignment.price_group_resource_type, v_assignment.price_group_resource_id,
    v_assignment.catalog_revision, v_assignment.compatibility_contract_id,
    v_assignment.compatibility_contract_revision, v_assignment.definition_revision,
    v_assignment.effective_from, v_assignment.effective_to, v_assignment.lifecycle,
    v_assignment.revision, v_assignment.reason, v_assignment.recorded_at;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "commerce_customer_context"."migrate_price_group_assignments"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_counterparty_resource_id text,
  p_source_module_id text,
  p_source_resource_type text,
  p_source_resource_id text,
  p_target_module_id text,
  p_target_resource_type text,
  p_target_resource_id text,
  p_catalog_revision integer,
  p_compatibility_contract_id text,
  p_compatibility_contract_revision integer,
  p_definition_revision integer,
  p_effective_from timestamptz,
  p_reason text,
  p_recorded_at timestamptz,
  p_actor_principal_id uuid,
  p_action_invocation_id uuid,
  p_targets jsonb
)
RETURNS TABLE (
  outcome text,
  changed boolean,
  conflict_assignment_id text,
  conflict_reason text,
  assignment_id text,
  profile_kind text,
  profile_id text,
  price_group_module_id text,
  price_group_resource_type text,
  price_group_resource_id text,
  catalog_revision integer,
  compatibility_contract_id text,
  compatibility_contract_revision integer,
  definition_revision integer,
  effective_from timestamptz,
  effective_to timestamptz,
  lifecycle text,
  revision integer,
  reason text,
  recorded_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
SET row_security = on
AS $$
DECLARE
  v_target jsonb;
  v_conflicts jsonb := '[]'::jsonb;
  v_profile commerce_customer_context.customer_profiles%ROWTYPE;
  v_profile_state text;
  v_profile_revision integer;
  v_source commerce_customer_context.customer_price_group_assignments%ROWTYPE;
  v_existing_target commerce_customer_context.customer_price_group_assignments%ROWTYPE;
  v_inserted commerce_customer_context.customer_price_group_assignments%ROWTYPE;
BEGIN
  IF current_setting('ontos.tenant_id', true) IS DISTINCT FROM p_tenant_id::text
     OR current_setting('ontos.legal_entity_id', true) IS DISTINCT FROM p_legal_entity_id::text
     OR jsonb_typeof(p_targets) <> 'array'
     OR jsonb_array_length(p_targets) NOT BETWEEN 1 AND 100
  THEN
    RETURN QUERY SELECT 'CONFLICTS'::text, false, NULL::text, 'ASSIGNMENT_CHANGED'::text,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
      NULL::integer, NULL::text, NULL::integer, NULL::integer, NULL::timestamptz,
      NULL::timestamptz, NULL::text, NULL::integer, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  IF p_effective_from < p_recorded_at THEN
    RETURN QUERY SELECT 'RETROACTIVE_SCHEDULE'::text, false, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
      NULL::integer, NULL::text, NULL::integer, NULL::integer, NULL::timestamptz,
      NULL::timestamptz, NULL::text, NULL::integer, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  -- Lock every profile in stable order before validating. This prevents deadlocks between
  -- overlapping bulk migrations and makes the conflict inventory one atomic snapshot.
  PERFORM profile.customer_profile_id
  FROM commerce_customer_context.customer_profiles AS profile
  JOIN (
    SELECT DISTINCT target ->> 'profile_id' AS profile_id
    FROM jsonb_array_elements(p_targets) AS target
  ) AS requested ON requested.profile_id = profile.customer_profile_id::text
  WHERE profile.tenant_id = p_tenant_id
    AND profile.legal_entity_id = p_legal_entity_id
  ORDER BY profile.customer_profile_id
  FOR UPDATE;

  FOR v_target IN SELECT value FROM jsonb_array_elements(p_targets)
  LOOP
    IF (
      SELECT count(*)
      FROM jsonb_array_elements(p_targets) AS duplicate
      WHERE duplicate ->> 'assignment_id' = v_target ->> 'assignment_id'
    ) > 1 THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
        'assignment_id', v_target ->> 'assignment_id',
        'reason', 'ASSIGNMENT_CHANGED'
      ));
      CONTINUE;
    END IF;

    SELECT profile.*
    INTO v_profile
    FROM commerce_customer_context.customer_profiles AS profile
    WHERE profile.tenant_id = p_tenant_id
      AND profile.legal_entity_id = p_legal_entity_id
      AND profile.customer_profile_id::text = v_target ->> 'profile_id'
      AND profile.profile_kind = v_target ->> 'profile_kind';

    IF NOT FOUND THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
        'assignment_id', v_target ->> 'assignment_id',
        'reason', 'PROFILE_INELIGIBLE'
      ));
      CONTINUE;
    END IF;

    SELECT lifecycle.to_lifecycle, lifecycle.revision
    INTO v_profile_state, v_profile_revision
    FROM commerce_customer_context.customer_profile_lifecycle_history AS lifecycle
    WHERE lifecycle.tenant_id = p_tenant_id
      AND lifecycle.legal_entity_id = p_legal_entity_id
      AND lifecycle.customer_profile_id = v_profile.customer_profile_id
      AND lifecycle.recorded_at <= p_effective_from
    ORDER BY lifecycle.recorded_at DESC, lifecycle.revision DESC
    LIMIT 1;

    IF NOT FOUND
       OR v_profile_state <> 'ACTIVE'
       OR v_profile_revision <> (v_target ->> 'expected_profile_revision')::integer
       OR EXISTS (
         SELECT 1
         FROM commerce_customer_context.profile_reconciliation_cases AS reconciliation
         WHERE reconciliation.tenant_id = p_tenant_id
           AND reconciliation.legal_entity_id = p_legal_entity_id
           AND reconciliation.recorded_at <= p_effective_from
           AND (reconciliation.resolved_at IS NULL OR p_effective_from < reconciliation.resolved_at)
           AND (
             reconciliation.source_profile_id = v_profile.customer_profile_id
             OR reconciliation.colliding_profile_id = v_profile.customer_profile_id
             OR reconciliation.canonical_profile_id = v_profile.customer_profile_id
           )
       )
       OR (v_profile.profile_kind = 'RETAIL' AND (
         p_counterparty_resource_id IS NOT NULL OR NOT EXISTS (
           SELECT 1 FROM commerce_customer_context.retail_customer_profiles AS retail
           WHERE retail.tenant_id = p_tenant_id
             AND retail.legal_entity_id = p_legal_entity_id
             AND retail.retail_customer_profile_id = v_profile.customer_profile_id
         )
       ))
       OR (v_profile.profile_kind = 'COUNTERPARTY' AND NOT EXISTS (
         SELECT 1 FROM commerce_customer_context.counterparty_purchasing_profiles AS counterparty
         WHERE counterparty.tenant_id = p_tenant_id
           AND counterparty.legal_entity_id = p_legal_entity_id
           AND counterparty.counterparty_purchasing_profile_id = v_profile.customer_profile_id
           AND p_counterparty_resource_id IS NOT NULL
           AND counterparty.counterparty_resource_id = p_counterparty_resource_id
       ))
    THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
        'assignment_id', v_target ->> 'assignment_id',
        'reason', 'PROFILE_INELIGIBLE'
      ));
      CONTINUE;
    END IF;

    SELECT assignment.*
    INTO v_source
    FROM commerce_customer_context.customer_price_group_assignments AS assignment
    WHERE assignment.tenant_id = p_tenant_id
      AND assignment.legal_entity_id = p_legal_entity_id
      AND assignment.customer_price_group_assignment_id::text = v_target ->> 'assignment_id'
      AND assignment.customer_profile_id = v_profile.customer_profile_id
      AND assignment.price_group_module_id = p_source_module_id
      AND assignment.price_group_resource_type = p_source_resource_type
      AND assignment.price_group_resource_id = p_source_resource_id
    FOR UPDATE;

    IF NOT FOUND THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
        'assignment_id', v_target ->> 'assignment_id',
        'reason', 'ASSIGNMENT_MISSING'
      ));
      CONTINUE;
    END IF;

    SELECT assignment.*
    INTO v_existing_target
    FROM commerce_customer_context.customer_price_group_assignments AS assignment
    WHERE assignment.tenant_id = p_tenant_id
      AND assignment.legal_entity_id = p_legal_entity_id
      AND assignment.customer_profile_id = v_profile.customer_profile_id
      AND assignment.lifecycle IN ('ACTIVE', 'ENDED')
      AND assignment.price_group_module_id = p_target_module_id
      AND assignment.price_group_resource_type = p_target_resource_type
      AND assignment.price_group_resource_id = p_target_resource_id
      AND assignment.catalog_revision = p_catalog_revision
      AND assignment.compatibility_contract_id = p_compatibility_contract_id
      AND assignment.compatibility_contract_revision = p_compatibility_contract_revision
      AND assignment.definition_revision = p_definition_revision
      AND assignment.effective_from = p_effective_from
    ORDER BY assignment.customer_price_group_assignment_id
    LIMIT 1
    FOR UPDATE;

    IF FOUND
       AND v_source.lifecycle IN ('ENDED', 'CANCELLED')
       AND v_source.effective_to = p_effective_from
    THEN
      CONTINUE;
    END IF;

    IF v_source.lifecycle <> 'ACTIVE'
       OR v_source.revision <> (v_target ->> 'expected_revision')::integer
       OR p_effective_from < v_source.effective_from
       OR (v_source.effective_to IS NOT NULL AND p_effective_from >= v_source.effective_to)
    THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
        'assignment_id', v_target ->> 'assignment_id',
        'reason', 'ASSIGNMENT_CHANGED'
      ));
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM commerce_customer_context.customer_price_group_assignments AS assignment
      WHERE assignment.tenant_id = p_tenant_id
        AND assignment.legal_entity_id = p_legal_entity_id
        AND assignment.customer_profile_id = v_profile.customer_profile_id
        AND assignment.lifecycle IN ('ACTIVE', 'ENDED')
        AND assignment.customer_price_group_assignment_id <> v_source.customer_price_group_assignment_id
        AND tstzrange(assignment.effective_from, coalesce(assignment.effective_to, 'infinity'::timestamptz), '[)')
            && tstzrange(p_effective_from, coalesce(v_source.effective_to, 'infinity'::timestamptz), '[)')
    ) THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
        'assignment_id', v_target ->> 'assignment_id',
        'reason', 'OVERLAP'
      ));
    END IF;
  END LOOP;

  IF jsonb_array_length(v_conflicts) > 0 THEN
    RETURN QUERY
    SELECT 'CONFLICTS'::text, false, conflict ->> 'assignment_id', conflict ->> 'reason',
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
      NULL::integer, NULL::text, NULL::integer, NULL::integer, NULL::timestamptz,
      NULL::timestamptz, NULL::text, NULL::integer, NULL::text, NULL::timestamptz
    FROM jsonb_array_elements(v_conflicts) AS conflict;
    RETURN;
  END IF;

  FOR v_target IN SELECT value FROM jsonb_array_elements(p_targets)
  LOOP
    SELECT profile.* INTO v_profile
    FROM commerce_customer_context.customer_profiles AS profile
    WHERE profile.tenant_id = p_tenant_id
      AND profile.legal_entity_id = p_legal_entity_id
      AND profile.customer_profile_id::text = v_target ->> 'profile_id';

    SELECT assignment.* INTO v_source
    FROM commerce_customer_context.customer_price_group_assignments AS assignment
    WHERE assignment.tenant_id = p_tenant_id
      AND assignment.legal_entity_id = p_legal_entity_id
      AND assignment.customer_price_group_assignment_id::text = v_target ->> 'assignment_id';

    SELECT assignment.* INTO v_existing_target
    FROM commerce_customer_context.customer_price_group_assignments AS assignment
    WHERE assignment.tenant_id = p_tenant_id
      AND assignment.legal_entity_id = p_legal_entity_id
      AND assignment.customer_profile_id = v_profile.customer_profile_id
      AND assignment.lifecycle IN ('ACTIVE', 'ENDED')
      AND assignment.price_group_module_id = p_target_module_id
      AND assignment.price_group_resource_type = p_target_resource_type
      AND assignment.price_group_resource_id = p_target_resource_id
      AND assignment.catalog_revision = p_catalog_revision
      AND assignment.compatibility_contract_id = p_compatibility_contract_id
      AND assignment.compatibility_contract_revision = p_compatibility_contract_revision
      AND assignment.definition_revision = p_definition_revision
      AND assignment.effective_from = p_effective_from
    ORDER BY assignment.customer_price_group_assignment_id
    LIMIT 1;

    IF FOUND
       AND v_source.lifecycle IN ('ENDED', 'CANCELLED')
       AND v_source.effective_to = p_effective_from
    THEN
      RETURN QUERY SELECT 'APPLIED'::text, false, NULL::text, NULL::text,
        v_existing_target.customer_price_group_assignment_id::text, v_profile.profile_kind,
        v_profile.customer_profile_id::text, v_existing_target.price_group_module_id,
        v_existing_target.price_group_resource_type, v_existing_target.price_group_resource_id,
        v_existing_target.catalog_revision, v_existing_target.compatibility_contract_id,
        v_existing_target.compatibility_contract_revision, v_existing_target.definition_revision,
        v_existing_target.effective_from, v_existing_target.effective_to,
        v_existing_target.lifecycle, v_existing_target.revision, v_existing_target.reason,
        v_existing_target.recorded_at;
      CONTINUE;
    END IF;

    -- Preserve source attribution; the Migration Action owns immutable transition evidence.
    UPDATE commerce_customer_context.customer_price_group_assignments AS assignment
    SET effective_to = p_effective_from,
        lifecycle = CASE
          WHEN p_effective_from = assignment.effective_from THEN 'CANCELLED'
          ELSE 'ENDED'
        END,
        revision = assignment.revision + 1
    WHERE assignment.tenant_id = p_tenant_id
      AND assignment.legal_entity_id = p_legal_entity_id
      AND assignment.customer_price_group_assignment_id = v_source.customer_price_group_assignment_id;

    INSERT INTO commerce_customer_context.customer_price_group_assignments (
      tenant_id, legal_entity_id, customer_profile_id, price_group_module_id,
      price_group_resource_type, price_group_resource_id, catalog_revision,
      compatibility_contract_id, compatibility_contract_revision, definition_revision,
      effective_from, effective_to, lifecycle, revision, action_invocation_id,
      actor_principal_id, reason, recorded_at
    ) VALUES (
      p_tenant_id, p_legal_entity_id, v_profile.customer_profile_id, p_target_module_id,
      p_target_resource_type, p_target_resource_id, p_catalog_revision,
      p_compatibility_contract_id, p_compatibility_contract_revision, p_definition_revision,
      p_effective_from, v_source.effective_to, 'ACTIVE', 1, p_action_invocation_id,
      p_actor_principal_id, p_reason, p_recorded_at
    ) RETURNING * INTO v_inserted;

    RETURN QUERY SELECT 'APPLIED'::text, true, NULL::text, NULL::text,
      v_inserted.customer_price_group_assignment_id::text, v_profile.profile_kind,
      v_profile.customer_profile_id::text, v_inserted.price_group_module_id,
      v_inserted.price_group_resource_type, v_inserted.price_group_resource_id,
      v_inserted.catalog_revision, v_inserted.compatibility_contract_id,
      v_inserted.compatibility_contract_revision, v_inserted.definition_revision,
      v_inserted.effective_from, v_inserted.effective_to, v_inserted.lifecycle,
      v_inserted.revision, v_inserted.reason, v_inserted.recorded_at;
  END LOOP;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."inspect_price_group_profile"(uuid, uuid, text, text, timestamptz, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."inspect_price_group_profile"(uuid, uuid, text, text, timestamptz, text) TO "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."read_price_group_assignments"(uuid, uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_price_group_assignments"(uuid, uuid, text, text) TO "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."resolve_price_group_assignments"(uuid, uuid, text, text, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."resolve_price_group_assignments"(uuid, uuid, text, text, timestamptz) TO "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."assign_price_group"(uuid, uuid, text, text, text, text, text, text, integer, text, integer, integer, timestamptz, timestamptz, integer, text, timestamptz, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."assign_price_group"(uuid, uuid, text, text, text, text, text, text, integer, text, integer, integer, timestamptz, timestamptz, integer, text, timestamptz, uuid, uuid) TO "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."remove_price_group_assignment"(uuid, uuid, text, text, text, text, timestamptz, integer, text, timestamptz, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."remove_price_group_assignment"(uuid, uuid, text, text, text, text, timestamptz, integer, text, timestamptz, uuid, uuid) TO "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."migrate_price_group_assignments"(uuid, uuid, text, text, text, text, text, text, text, integer, text, integer, integer, timestamptz, text, timestamptz, uuid, uuid, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."migrate_price_group_assignments"(uuid, uuid, text, text, text, text, text, text, text, integer, text, integer, integer, timestamptz, text, timestamptz, uuid, uuid, jsonb) TO "ontos_runtime";
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'commerce_customer_context'
      AND relation.relkind IN ('r', 'p')
      AND (
        has_table_privilege('ontos_runtime', relation.oid, 'SELECT')
        OR has_table_privilege('ontos_runtime', relation.oid, 'INSERT')
        OR has_table_privilege('ontos_runtime', relation.oid, 'UPDATE')
        OR has_table_privilege('ontos_runtime', relation.oid, 'DELETE')
      )
  ) THEN
    RAISE EXCEPTION 'ontos_runtime must not hold raw Commerce Customer Context table privileges';
  END IF;
END;
$$;
