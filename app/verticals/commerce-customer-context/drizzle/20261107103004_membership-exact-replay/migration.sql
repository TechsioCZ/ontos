-- Exact historical receipt recovery performs no destructive completeness re-admission.
-- The protected owner service checks current Privacy before invoking this routine.
CREATE OR REPLACE FUNCTION commerce_customer_context.apply_customer_group_membership_source(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_actor_principal_id uuid,
  p_invocation_id uuid,
  p_recorded_at timestamptz,
  p_payload jsonb
)
RETURNS TABLE (outcome text, result jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
SET row_security = on
AS $$
DECLARE
  v_profile_id uuid := (p_payload #>> '{profile,profileRef,resourceId}')::uuid;
  v_profile_kind text := p_payload #>> '{profile,profileKind}';
  v_manager jsonb := p_payload->'manager';
  v_source jsonb := p_payload->'source';
  v_receipt commerce_customer_context.customer_group_membership_source_receipts%ROWTYPE;
  v_profile record;
  v_group_ids uuid[];
  v_fingerprint text;
BEGIN
  PERFORM commerce_customer_context.lock_customer_group_membership_scope(p_tenant_id, p_legal_entity_id);
  IF p_actor_principal_id IS NULL
    OR v_manager->>'tenantId' IS DISTINCT FROM p_tenant_id::text
    OR v_manager->>'factFamily' IS DISTINCT FROM 'CUSTOMER_GROUP_MEMBERSHIP'
    OR p_payload #>> '{profile,profileRef,tenantId}' IS DISTINCT FROM p_tenant_id::text
    OR v_profile_kind IS NULL OR v_profile_kind NOT IN ('RETAIL', 'COUNTERPARTY')
  THEN
    RETURN QUERY SELECT 'SOURCE_AUTHORITY_DENIED'::text, NULL::jsonb;
    RETURN;
  END IF;

  PERFORM 1 FROM commerce_customer_context.customer_group_membership_source_routes AS route
  WHERE route.tenant_id = p_tenant_id AND route.legal_entity_id = p_legal_entity_id
    AND route.route_id = p_payload #>> '{route,id}'
    AND route.route_revision = p_payload #>> '{route,revision}'
    AND route.issuer = v_manager->>'issuer'
    AND route.source_namespace = v_manager->>'sourceNamespace'
    AND route.principal_id = p_actor_principal_id AND route.active
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'SOURCE_AUTHORITY_DENIED'::text, NULL::jsonb;
    RETURN;
  END IF;

  -- Share the existing mutation lock and profile lock before observing source evidence.
  PERFORM 1 FROM commerce_customer_context.customer_profiles AS profile
  WHERE profile.tenant_id = p_tenant_id AND profile.legal_entity_id = p_legal_entity_id
    AND profile.customer_profile_id = v_profile_id AND profile.profile_kind = v_profile_kind
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'TARGET_NOT_FOUND'::text, NULL::jsonb;
    RETURN;
  END IF;
  SELECT * INTO v_profile FROM commerce_customer_context.read_customer_profile(
    p_tenant_id, p_legal_entity_id, v_profile_id, v_profile_kind
  );
  IF NOT FOUND OR v_profile.outcome IS DISTINCT FROM 'PROFILE_AVAILABLE'
    OR v_profile.payload->>'state' IS DISTINCT FROM 'ACTIVE'
  THEN
    RETURN QUERY SELECT 'TARGET_INELIGIBLE'::text, NULL::jsonb;
    RETURN;
  END IF;

  SELECT receipt.* INTO v_receipt
  FROM commerce_customer_context.customer_group_membership_source_receipts AS receipt
  WHERE receipt.tenant_id = p_tenant_id AND receipt.legal_entity_id = p_legal_entity_id
    AND receipt.customer_profile_id = v_profile_id
    AND receipt.issuer = v_manager->>'issuer'
    AND receipt.source_namespace = v_manager->>'sourceNamespace'
    AND (receipt.source_order = (v_source->>'order')::integer
      OR receipt.effect_id = v_source->>'effectId'
      OR receipt.assertion_id = v_source->>'assertionId')
  ORDER BY receipt.source_order DESC LIMIT 1;
  IF FOUND THEN
    IF p_payload->>'operation' IN ('COMPLETE', 'PARTIAL') THEN
      IF jsonb_typeof(p_payload->'groupRefs') IS DISTINCT FROM 'array'
        OR jsonb_array_length(p_payload->'groupRefs') > 100
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(p_payload->'groupRefs') AS entry(ref)
          WHERE ref->>'tenantId' IS DISTINCT FROM p_tenant_id::text OR ref->>'resourceId' IS NULL
        )
      THEN
        RETURN QUERY SELECT 'SOURCE_CONFLICT'::text, NULL::jsonb;
        RETURN;
      END IF;
      SELECT COALESCE(array_agg(DISTINCT (ref->>'resourceId')::uuid ORDER BY (ref->>'resourceId')::uuid), ARRAY[]::uuid[])
      INTO v_group_ids FROM jsonb_array_elements(p_payload->'groupRefs') AS entry(ref);
      IF cardinality(v_group_ids) <> jsonb_array_length(p_payload->'groupRefs') THEN
        RETURN QUERY SELECT 'SOURCE_CONFLICT'::text, NULL::jsonb;
        RETURN;
      END IF;
    ELSIF p_payload->>'operation' IN ('ASSIGN', 'REMOVE') THEN
      v_group_ids := ARRAY[(p_payload #>> '{groupRef,resourceId}')::uuid];
    ELSE
      RETURN QUERY SELECT 'SOURCE_CONFLICT'::text, NULL::jsonb;
      RETURN;
    END IF;
    -- This is the original canonical source intent fingerprint. Only route transport revision
    -- and array presentation order are excluded; reason, source identity, proof reference,
    -- business-effective time and exact target remain pinned to the original accepted effect.
    v_fingerprint := encode(sha256(convert_to(
      ((p_payload - 'route' - 'groupRefs') || jsonb_build_object('groupIds', v_group_ids))::text, 'UTF8'
    )), 'hex');
    RETURN QUERY SELECT
      CASE WHEN v_receipt.fingerprint = v_fingerprint THEN 'REPLAY' ELSE 'SOURCE_CONFLICT' END,
      CASE WHEN v_receipt.fingerprint = v_fingerprint
        THEN commerce_customer_context.project_membership_source_result(v_receipt.result) ELSE NULL END;
    RETURN;
  END IF;

  -- New effects retain the original route/completeness admission, bounded diff and watermark.
  RETURN QUERY SELECT admitted.outcome, commerce_customer_context.project_membership_source_result(admitted.result)
  FROM commerce_customer_context.apply_membership_source_admitted(
    p_tenant_id, p_legal_entity_id, p_actor_principal_id, p_invocation_id, p_recorded_at, p_payload
  ) AS admitted;
END;
$$;
