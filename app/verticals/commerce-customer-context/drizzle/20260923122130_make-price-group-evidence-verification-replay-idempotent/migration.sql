-- Verification time records when Pricing observed the evidence, not its business identity. An
-- equivalent retry may therefore carry a later observation while the immutable assignment keeps
-- and returns the first accepted evidence history.
CREATE OR REPLACE FUNCTION "commerce_customer_context"."bind_price_group_assignment_compatibility_evidence"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_assignment_id text,
  p_price_group_module_id text,
  p_price_group_resource_type text,
  p_price_group_resource_id text,
  p_catalog_revision integer,
  p_compatibility_contract_id text,
  p_compatibility_contract_revision integer,
  p_definition_revision integer,
  p_definition_revision_id uuid,
  p_meaning_fingerprint text,
  p_definition_effective_from timestamptz,
  p_definition_effective_to timestamptz,
  p_compatibility_trusted_at timestamptz,
  p_compatibility_verified_at timestamptz
)
RETURNS TABLE (
  outcome text,
  changed boolean,
  catalog_revision integer,
  compatibility_contract_id text,
  compatibility_contract_revision integer,
  definition_revision integer,
  definition_revision_id text,
  meaning_fingerprint text,
  definition_effective_from timestamptz,
  definition_effective_to timestamptz,
  compatibility_trusted_at timestamptz,
  compatibility_verified_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
SET row_security = on
AS $$
DECLARE
  v_assignment commerce_customer_context.customer_price_group_assignments%ROWTYPE;
  v_changed boolean := false;
BEGIN
  IF current_setting('ontos.tenant_id', true) IS DISTINCT FROM p_tenant_id::text
     OR current_setting('ontos.legal_entity_id', true) IS DISTINCT FROM p_legal_entity_id::text
  THEN
    RETURN QUERY SELECT 'NOT_FOUND'::text, false, NULL::integer, NULL::text, NULL::integer,
      NULL::integer, NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz,
      NULL::timestamptz, NULL::timestamptz;
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
    RETURN QUERY SELECT 'NOT_FOUND'::text, false, NULL::integer, NULL::text, NULL::integer,
      NULL::integer, NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz,
      NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  IF v_assignment.price_group_module_id IS DISTINCT FROM p_price_group_module_id
     OR v_assignment.price_group_resource_type IS DISTINCT FROM p_price_group_resource_type
     OR v_assignment.price_group_resource_id IS DISTINCT FROM p_price_group_resource_id
     OR v_assignment.catalog_revision IS DISTINCT FROM p_catalog_revision
     OR v_assignment.compatibility_contract_id IS DISTINCT FROM p_compatibility_contract_id
     OR v_assignment.compatibility_contract_revision IS DISTINCT FROM p_compatibility_contract_revision
     OR v_assignment.definition_revision IS DISTINCT FROM p_definition_revision
     OR p_definition_revision_id IS NULL
     OR p_meaning_fingerprint IS NULL
     OR p_definition_effective_from IS NULL
     OR p_compatibility_trusted_at IS NULL
     OR p_compatibility_verified_at IS NULL
     OR (p_definition_effective_to IS NOT NULL AND p_definition_effective_to <= p_definition_effective_from)
     OR p_compatibility_trusted_at < p_definition_effective_from
     OR (p_definition_effective_to IS NOT NULL AND p_compatibility_trusted_at >= p_definition_effective_to)
     OR p_compatibility_verified_at < p_compatibility_trusted_at
     OR p_meaning_fingerprint !~ '^[0-9a-f]{64}$'
  THEN
    RETURN QUERY SELECT 'CONFLICT'::text, false, NULL::integer, NULL::text, NULL::integer,
      NULL::integer, NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz,
      NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  IF v_assignment.definition_revision_id IS NULL
     AND v_assignment.meaning_fingerprint IS NULL
     AND v_assignment.definition_effective_from IS NULL
     AND v_assignment.definition_effective_to IS NULL
     AND v_assignment.compatibility_trusted_at IS NULL
     AND v_assignment.compatibility_verified_at IS NULL
  THEN
    UPDATE commerce_customer_context.customer_price_group_assignments AS assignment
    SET definition_revision_id = p_definition_revision_id,
        meaning_fingerprint = p_meaning_fingerprint,
        definition_effective_from = p_definition_effective_from,
        definition_effective_to = p_definition_effective_to,
        compatibility_trusted_at = p_compatibility_trusted_at,
        compatibility_verified_at = p_compatibility_verified_at
    WHERE assignment.tenant_id = p_tenant_id
      AND assignment.legal_entity_id = p_legal_entity_id
      AND assignment.customer_price_group_assignment_id = v_assignment.customer_price_group_assignment_id
    RETURNING * INTO v_assignment;
    v_changed := true;
  ELSIF v_assignment.definition_revision_id IS DISTINCT FROM p_definition_revision_id
     OR v_assignment.meaning_fingerprint IS DISTINCT FROM p_meaning_fingerprint
     OR v_assignment.definition_effective_from IS DISTINCT FROM p_definition_effective_from
     OR v_assignment.definition_effective_to IS DISTINCT FROM p_definition_effective_to
     OR v_assignment.compatibility_trusted_at IS DISTINCT FROM p_compatibility_trusted_at
  THEN
    RETURN QUERY SELECT 'CONFLICT'::text, false, NULL::integer, NULL::text, NULL::integer,
      NULL::integer, NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz,
      NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'BOUND'::text, v_changed, v_assignment.catalog_revision,
    v_assignment.compatibility_contract_id, v_assignment.compatibility_contract_revision,
    v_assignment.definition_revision, v_assignment.definition_revision_id::text,
    v_assignment.meaning_fingerprint, v_assignment.definition_effective_from,
    v_assignment.definition_effective_to, v_assignment.compatibility_trusted_at,
    v_assignment.compatibility_verified_at;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."bind_price_group_assignment_compatibility_evidence"(uuid, uuid, text, text, text, text, integer, text, integer, integer, uuid, text, timestamptz, timestamptz, timestamptz, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."bind_price_group_assignment_compatibility_evidence"(uuid, uuid, text, text, text, text, integer, text, integer, integer, uuid, text, timestamptz, timestamptz, timestamptz, timestamptz) TO "ontos_runtime";
