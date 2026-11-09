CREATE OR REPLACE FUNCTION commerce_customer_context.admit_customer_group_membership_snapshot(
  p_tenant_id uuid, p_legal_entity_id uuid, p_actor_principal_id uuid,
  p_invocation_id uuid, p_recorded_at timestamptz, p_payload jsonb
)
RETURNS TABLE (outcome text, result jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
SET row_security = on
AS $$
DECLARE
  v_snapshot jsonb := p_payload->'snapshot';
  v_contract jsonb := p_payload->'completenessContract';
  v_manager jsonb := v_snapshot->'manager';
  v_profile_id uuid := (v_snapshot #>> '{profile,profileRef,resourceId}')::uuid;
  v_profile_kind text := v_snapshot #>> '{profile,profileKind}';
  v_expires_at timestamptz := (p_payload->>'expiresAt')::timestamptz;
  v_digest text;
  v_profile record;
  v_existing commerce_customer_context.customer_group_membership_snapshot_proofs%ROWTYPE;
  v_group_ids uuid[];
BEGIN
  PERFORM commerce_customer_context.lock_customer_group_membership_scope(p_tenant_id, p_legal_entity_id);
  IF p_actor_principal_id IS NULL OR p_invocation_id IS NULL OR p_recorded_at IS NULL
    OR v_snapshot->>'operation' IS DISTINCT FROM 'COMPLETE'
    OR v_manager->>'tenantId' IS DISTINCT FROM p_tenant_id::text
    OR v_manager->>'factFamily' IS DISTINCT FROM 'CUSTOMER_GROUP_MEMBERSHIP'
    OR v_snapshot #>> '{profile,profileRef,tenantId}' IS DISTINCT FROM p_tenant_id::text
    OR v_profile_kind IS NULL OR v_profile_kind NOT IN ('RETAIL', 'COUNTERPARTY')
    OR v_contract->>'coverage' IS DISTINCT FROM 'ALL_GROUP_MEMBERSHIPS_FOR_EXACT_PROFILE'
  THEN
    RETURN QUERY SELECT 'SOURCE_AUTHORITY_DENIED'::text, NULL::jsonb;
    RETURN;
  END IF;
  -- Only an independently configured, genuine completeness contract permits this source to
  -- assert completeness. The request cannot set or replace its route's qualification.
  PERFORM 1 FROM commerce_customer_context.customer_group_membership_source_routes AS route
  WHERE route.tenant_id = p_tenant_id AND route.legal_entity_id = p_legal_entity_id
    AND route.route_id = v_snapshot #>> '{route,id}'
    AND route.route_revision = v_snapshot #>> '{route,revision}'
    AND route.issuer = v_manager->>'issuer'
    AND route.source_namespace = v_manager->>'sourceNamespace'
    AND route.principal_id = p_actor_principal_id AND route.active AND route.allow_complete
    AND route.completeness_contract_ref = v_contract->>'ref'
    AND route.completeness_contract_revision = v_contract->>'revision'
    AND route.completeness_contract_coverage = v_contract->>'coverage'
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'SOURCE_AUTHORITY_DENIED'::text, NULL::jsonb;
    RETURN;
  END IF;
  IF NULLIF(btrim(v_snapshot->>'completenessProofRef'), '') IS NULL
    OR jsonb_typeof(v_snapshot->'groupRefs') IS DISTINCT FROM 'array'
    OR jsonb_array_length(v_snapshot->'groupRefs') > 100
    OR (v_snapshot #>> '{source,order}')::integer < 1
    OR NULLIF(btrim(v_snapshot #>> '{source,effectId}'), '') IS NULL
    OR NULLIF(btrim(v_snapshot #>> '{source,assertionId}'), '') IS NULL
    OR NULLIF(btrim(v_snapshot #>> '{source,sourceRecordId}'), '') IS NULL
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_snapshot->'groupRefs') AS entry(ref)
      WHERE ref->>'tenantId' IS DISTINCT FROM p_tenant_id::text OR ref->>'resourceId' IS NULL
    )
  THEN
    RETURN QUERY SELECT 'SOURCE_CONFLICT'::text, NULL::jsonb;
    RETURN;
  END IF;
  SELECT COALESCE(array_agg(DISTINCT (ref->>'resourceId')::uuid), ARRAY[]::uuid[])
  INTO v_group_ids FROM jsonb_array_elements(v_snapshot->'groupRefs') AS entry(ref);
  IF cardinality(v_group_ids) <> jsonb_array_length(v_snapshot->'groupRefs') THEN
    RETURN QUERY SELECT 'SOURCE_CONFLICT'::text, NULL::jsonb;
    RETURN;
  END IF;
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
  v_digest := commerce_customer_context.customer_group_membership_snapshot_digest(v_snapshot);
  SELECT proof.* INTO v_existing
  FROM commerce_customer_context.customer_group_membership_snapshot_proofs AS proof
  WHERE proof.tenant_id = p_tenant_id AND proof.legal_entity_id = p_legal_entity_id
    AND proof.proof_ref = v_snapshot->>'completenessProofRef'
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.proof_digest IS DISTINCT FROM v_digest OR v_existing.expires_at IS DISTINCT FROM v_expires_at
      OR v_existing.completeness_contract_ref IS DISTINCT FROM v_contract->>'ref'
      OR v_existing.completeness_contract_revision IS DISTINCT FROM v_contract->>'revision'
      OR v_existing.completeness_contract_coverage IS DISTINCT FROM v_contract->>'coverage'
      OR v_existing.qualified_by_action_invocation_id IS NULL
      OR v_existing.qualified_by_principal_id IS NULL OR v_existing.qualified_at IS NULL
    THEN
      RETURN QUERY SELECT 'SOURCE_CONFLICT'::text, NULL::jsonb;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'REPLAY'::text, jsonb_build_object(
      'digest', v_existing.proof_digest, 'proofRef', v_existing.proof_ref,
      'expiresAt', to_char(v_existing.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
    RETURN;
  END IF;
  IF v_expires_at IS NULL OR v_expires_at <= p_recorded_at THEN
    RETURN QUERY SELECT 'SOURCE_CONFLICT'::text, NULL::jsonb;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(v_group_ids) AS target(group_id)
    LEFT JOIN commerce_customer_context.customer_groups AS customer_group
      ON customer_group.tenant_id = p_tenant_id AND customer_group.legal_entity_id = p_legal_entity_id
      AND customer_group.customer_group_id = target.group_id
    WHERE customer_group.customer_group_id IS NULL
  ) THEN
    RETURN QUERY SELECT 'TARGET_NOT_FOUND'::text, NULL::jsonb;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM commerce_customer_context.customer_groups AS customer_group
    WHERE customer_group.tenant_id = p_tenant_id AND customer_group.legal_entity_id = p_legal_entity_id
      AND customer_group.customer_group_id = ANY(v_group_ids)
      AND (customer_group.lifecycle <> 'ACTIVE' OR NOT EXISTS (
        SELECT 1 FROM commerce_customer_context.customer_group_lifecycle_periods AS period
        WHERE period.tenant_id = p_tenant_id AND period.legal_entity_id = p_legal_entity_id
          AND period.customer_group_id = customer_group.customer_group_id
          AND period.active_from <= (v_snapshot->>'effectiveAt')::timestamptz
          AND (period.archived_at IS NULL OR (v_snapshot->>'effectiveAt')::timestamptz < period.archived_at)
      ))
  ) THEN
    RETURN QUERY SELECT 'TARGET_INELIGIBLE'::text, NULL::jsonb;
    RETURN;
  END IF;
  INSERT INTO commerce_customer_context.customer_group_membership_snapshot_proofs (
    tenant_id, legal_entity_id, proof_ref, proof_digest, expires_at,
    completeness_contract_ref, completeness_contract_revision, completeness_contract_coverage,
    qualified_by_action_invocation_id, qualified_by_principal_id, qualified_at
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_snapshot->>'completenessProofRef', v_digest, v_expires_at,
    v_contract->>'ref', v_contract->>'revision', v_contract->>'coverage',
    p_invocation_id, p_actor_principal_id, p_recorded_at
  );
  RETURN QUERY SELECT 'APPLIED'::text, jsonb_build_object(
    'digest', v_digest, 'proofRef', v_snapshot->>'completenessProofRef',
    'expiresAt', to_char(v_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END;
$$;
