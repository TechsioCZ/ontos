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
SET search_path = pg_catalog, commerce_customer_context, pg_temp
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
      AND assignment.lifecycle IN ('ACTIVE', 'ENDED')
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
    AND assignment.lifecycle IN ('ACTIVE', 'ENDED')
    AND assignment.effective_from <= p_effective_at
    AND (assignment.effective_to IS NULL OR p_effective_at < assignment.effective_to)
  ORDER BY assignment.effective_from DESC, assignment.customer_price_group_assignment_id DESC
  LIMIT 2;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.resolve_price_group_assignments(uuid, uuid, text, text, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.resolve_price_group_assignments(uuid, uuid, text, text, timestamptz) TO "ontos_runtime";
