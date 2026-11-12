ALTER TABLE commerce_customer_context.customer_group_membership_snapshot_proofs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE commerce_customer_context.customer_group_membership_snapshot_proofs FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.customer_group_membership_snapshot_digest(p_payload jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT encode(sha256(convert_to(
    (p_payload || jsonb_build_object('groupRefs', COALESCE(
      (SELECT jsonb_agg(group_ref ORDER BY group_ref->>'resourceId')
       FROM jsonb_array_elements(p_payload->'groupRefs') AS entry(group_ref)),
      '[]'::jsonb
    )))::text,
    'UTF8'
  )), 'hex');
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.customer_group_membership_snapshot_digest(jsonb) FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
ALTER FUNCTION commerce_customer_context.apply_customer_group_membership_source(uuid, uuid, uuid, uuid, timestamptz, jsonb)
  RENAME TO apply_membership_source_locked;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.apply_membership_source_locked(uuid, uuid, uuid, uuid, timestamptz, jsonb)
  FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
-- An additive page has one upstream order and one durable effect. Existing pair assignment
-- enforces temporal overlap, lifecycle, attribution and setting revision for each new row.
CREATE FUNCTION commerce_customer_context.apply_partial_membership_set_locked(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_actor_principal_id uuid,
  p_invocation_id uuid,
  p_recorded_at timestamptz,
  p_payload jsonb
)
RETURNS TABLE (outcome text, result jsonb)
LANGUAGE plpgsql
SET search_path = pg_catalog, commerce_customer_context, pg_temp
SET row_security = on
AS $$
DECLARE
  v_manager jsonb := p_payload->'manager';
  v_source jsonb := p_payload->'source';
  v_profile_id uuid := (p_payload #>> '{profile,profileRef,resourceId}')::uuid;
  v_profile_kind text := p_payload #>> '{profile,profileKind}';
  v_effective_at timestamptz := (p_payload->>'effectiveAt')::timestamptz;
  v_order integer := (v_source->>'order')::integer;
  v_group_ids uuid[];
  v_group_id uuid;
  v_member commerce_customer_context.customer_group_memberships%ROWTYPE;
  v_receipt commerce_customer_context.customer_group_membership_source_receipts%ROWTYPE;
  v_fingerprint text;
  v_result jsonb;
  v_items jsonb := '[]'::jsonb;
  v_assignment record;
  v_membership_id uuid;
BEGIN
  IF jsonb_typeof(p_payload->'groupRefs') IS DISTINCT FROM 'array' OR v_order IS NULL OR v_order < 1
    OR v_effective_at IS NULL OR NULLIF(btrim(v_source->>'assertionId'), '') IS NULL
    OR NULLIF(btrim(v_source->>'effectId'), '') IS NULL OR NULLIF(btrim(v_source->>'sourceRecordId'), '') IS NULL
  THEN
    RETURN QUERY SELECT 'SOURCE_CONFLICT'::text, NULL::jsonb;
    RETURN;
  END IF;
  IF jsonb_array_length(p_payload->'groupRefs') NOT BETWEEN 1 AND 100 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_payload->'groupRefs') AS target(ref)
    WHERE ref->>'tenantId' IS DISTINCT FROM p_tenant_id::text OR ref->>'resourceId' IS NULL
  ) THEN
    RETURN QUERY SELECT 'SOURCE_CONFLICT'::text, NULL::jsonb;
    RETURN;
  END IF;
  SELECT array_agg(DISTINCT (ref->>'resourceId')::uuid ORDER BY (ref->>'resourceId')::uuid)
  INTO v_group_ids FROM jsonb_array_elements(p_payload->'groupRefs') AS target(ref);
  IF cardinality(v_group_ids) <> jsonb_array_length(p_payload->'groupRefs') THEN
    RETURN QUERY SELECT 'SOURCE_CONFLICT'::text, NULL::jsonb;
    RETURN;
  END IF;
  v_fingerprint := encode(sha256(convert_to(
    ((p_payload - 'route' - 'groupRefs') || jsonb_build_object('groupIds', v_group_ids))::text, 'UTF8'
  )), 'hex');
  SELECT receipt.* INTO v_receipt
  FROM commerce_customer_context.customer_group_membership_source_receipts AS receipt
  WHERE receipt.tenant_id = p_tenant_id AND receipt.legal_entity_id = p_legal_entity_id
    AND receipt.customer_profile_id = v_profile_id AND receipt.issuer = v_manager->>'issuer'
    AND receipt.source_namespace = v_manager->>'sourceNamespace'
    AND (receipt.source_order = v_order OR receipt.effect_id = v_source->>'effectId'
      OR receipt.assertion_id = v_source->>'assertionId')
  ORDER BY receipt.source_order DESC LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT
      CASE WHEN v_receipt.fingerprint = v_fingerprint THEN 'REPLAY' ELSE 'SOURCE_CONFLICT' END,
      CASE WHEN v_receipt.fingerprint = v_fingerprint THEN v_receipt.result ELSE NULL END;
    RETURN;
  END IF;
  SELECT receipt.* INTO v_receipt
  FROM commerce_customer_context.customer_group_membership_source_receipts AS receipt
  WHERE receipt.tenant_id = p_tenant_id AND receipt.legal_entity_id = p_legal_entity_id
    AND receipt.customer_profile_id = v_profile_id AND receipt.issuer = v_manager->>'issuer'
    AND receipt.source_namespace = v_manager->>'sourceNamespace'
  ORDER BY receipt.source_order DESC LIMIT 1;
  IF FOUND AND (v_order < v_receipt.source_order OR v_effective_at < v_receipt.effective_at) THEN
    RETURN QUERY SELECT 'SOURCE_STALE'::text, NULL::jsonb;
    RETURN;
  END IF;

  FOREACH v_group_id IN ARRAY v_group_ids LOOP
    IF NOT EXISTS (
      SELECT 1 FROM commerce_customer_context.customer_groups AS customer_group
      WHERE customer_group.tenant_id = p_tenant_id AND customer_group.legal_entity_id = p_legal_entity_id
        AND customer_group.customer_group_id = v_group_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P1127', MESSAGE = 'TARGET_NOT_FOUND';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM commerce_customer_context.customer_groups AS customer_group
      JOIN commerce_customer_context.customer_group_lifecycle_periods AS period
        USING (tenant_id, legal_entity_id, customer_group_id)
      WHERE customer_group.tenant_id = p_tenant_id AND customer_group.legal_entity_id = p_legal_entity_id
        AND customer_group.customer_group_id = v_group_id AND customer_group.lifecycle = 'ACTIVE'
        AND period.active_from <= v_effective_at
        AND (period.archived_at IS NULL OR v_effective_at < period.archived_at)
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P1127', MESSAGE = 'TARGET_INELIGIBLE';
    END IF;

    SELECT membership.* INTO v_member
    FROM commerce_customer_context.customer_group_memberships AS membership
    WHERE membership.tenant_id = p_tenant_id AND membership.legal_entity_id = p_legal_entity_id
      AND membership.customer_profile_id = v_profile_id AND membership.customer_group_id = v_group_id
      AND membership.lifecycle <> 'CANCELLED' AND membership.effective_from <= v_effective_at
      AND (membership.effective_to IS NULL OR membership.effective_to > v_effective_at);
    IF FOUND THEN
      v_items := v_items || jsonb_build_array(
        CASE WHEN v_member.management->'manager' = v_manager THEN jsonb_build_object(
          'membership', commerce_customer_context.customer_group_membership_document(
            p_tenant_id, p_legal_entity_id, v_member.customer_group_membership_id
          ),
          'outcome', 'ALREADY_MANAGED'
        ) ELSE jsonb_build_object(
          'groupRef', jsonb_build_object(
            'tenantId', p_tenant_id::text,
            'moduleId', 'commerce.customer-context',
            'resourceType', 'commerce.customer-context.customer-group',
            'resourceId', v_group_id::text
          ),
          'outcome', 'SATISFIED_BY_OTHER_MANAGER'
        ) END
      );
      CONTINUE;
    END IF;
    SELECT * INTO STRICT v_assignment FROM commerce_customer_context.assign_membership_locked(
      p_tenant_id, p_legal_entity_id, v_group_id, v_profile_id, v_profile_kind, v_effective_at,
      NULL, p_payload->>'reason', p_recorded_at, p_actor_principal_id, p_invocation_id
    );
    IF v_assignment.outcome <> 'ASSIGNED' THEN
      RAISE EXCEPTION USING ERRCODE = 'P1127', MESSAGE = 'SOURCE_CONFLICT';
    END IF;
    v_membership_id := (v_assignment.membership_json #>> '{membershipRef,resourceId}')::uuid;
    UPDATE commerce_customer_context.customer_group_memberships AS membership
    SET management = jsonb_build_object('kind', 'EXTERNAL_SOURCE', 'manager', v_manager, 'source', v_source)
    WHERE membership.tenant_id = p_tenant_id AND membership.legal_entity_id = p_legal_entity_id
      AND membership.customer_group_membership_id = v_membership_id;
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'membership', commerce_customer_context.customer_group_membership_document(
        p_tenant_id, p_legal_entity_id, v_membership_id
      ),
      'outcome', 'ASSIGNED'
    ));
  END LOOP;

  v_result := jsonb_build_object('items', v_items, 'source', v_source);
  INSERT INTO commerce_customer_context.customer_group_membership_source_receipts (
    tenant_id, legal_entity_id, customer_profile_id, issuer, source_namespace, source_order, assertion_id, effect_id,
    effective_at, fingerprint, result, action_invocation_id, actor_principal_id, recorded_at
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_profile_id, v_manager->>'issuer', v_manager->>'sourceNamespace', v_order,
    v_source->>'assertionId', v_source->>'effectId', v_effective_at, v_fingerprint, v_result,
    p_invocation_id, p_actor_principal_id, p_recorded_at
  );
  RETURN QUERY SELECT 'APPLIED'::text, v_result;
EXCEPTION WHEN SQLSTATE 'P1127' THEN
  -- A later rejected target rolls back the whole page, including any preceding assignments.
  RETURN QUERY SELECT SQLERRM, NULL::jsonb;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.apply_partial_membership_set_locked(uuid, uuid, uuid, uuid, timestamptz, jsonb)
  FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.apply_customer_group_membership_source(
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
  v_operation text := p_payload->>'operation';
  v_manager jsonb := p_payload->'manager';
  v_profile_id uuid := (p_payload #>> '{profile,profileRef,resourceId}')::uuid;
  v_profile_kind text := p_payload #>> '{profile,profileKind}';
  v_profile record;
  v_route record;
BEGIN
  PERFORM commerce_customer_context.lock_customer_group_membership_scope(p_tenant_id, p_legal_entity_id);
  SELECT route.allow_complete INTO v_route
  FROM commerce_customer_context.customer_group_membership_source_routes AS route
  WHERE route.tenant_id = p_tenant_id AND route.legal_entity_id = p_legal_entity_id
    AND route.route_id = p_payload #>> '{route,id}'
    AND route.route_revision = p_payload #>> '{route,revision}'
    AND route.issuer = v_manager->>'issuer' AND route.source_namespace = v_manager->>'sourceNamespace'
    AND route.principal_id = p_actor_principal_id AND route.active
    AND v_manager->>'tenantId' = p_tenant_id::text
    AND v_manager->>'factFamily' = 'CUSTOMER_GROUP_MEMBERSHIP'
    AND p_payload #>> '{profile,profileRef,tenantId}' = p_tenant_id::text
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'SOURCE_AUTHORITY_DENIED'::text, NULL::jsonb;
    RETURN;
  END IF;

  IF v_operation = 'COMPLETE' THEN
    IF NOT v_route.allow_complete OR jsonb_typeof(p_payload->'groupRefs') IS DISTINCT FROM 'array'
      OR jsonb_array_length(p_payload->'groupRefs') > 100
    THEN
      RETURN QUERY SELECT 'SOURCE_AUTHORITY_DENIED'::text, NULL::jsonb;
      RETURN;
    END IF;
    -- Only separately admitted owner evidence can authorize this exact destructive input. The
    -- caller can name the evidence, but cannot grant itself completeness or store a proof.
    PERFORM 1
    FROM commerce_customer_context.customer_group_membership_snapshot_proofs AS proof
    WHERE proof.tenant_id = p_tenant_id AND proof.legal_entity_id = p_legal_entity_id
      AND proof.proof_ref = p_payload->>'completenessProofRef' AND proof.expires_at > p_recorded_at
      AND proof.proof_digest = commerce_customer_context.customer_group_membership_snapshot_digest(p_payload)
    FOR SHARE;
    IF NOT FOUND THEN
      RETURN QUERY SELECT 'SOURCE_AUTHORITY_DENIED'::text, NULL::jsonb;
      RETURN;
    END IF;
  END IF;

  -- Hold the same Profile row that owner lifecycle/reconciliation writes acquire, then consult
  -- the canonical Profile read for unresolved identity cases and exact scope/subtype evidence.
  PERFORM 1
  FROM commerce_customer_context.customer_profiles AS profile
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
  IF v_operation = 'PARTIAL' THEN
    RETURN QUERY SELECT * FROM commerce_customer_context.apply_partial_membership_set_locked(
      p_tenant_id, p_legal_entity_id, p_actor_principal_id, p_invocation_id, p_recorded_at, p_payload
    );
    RETURN;
  END IF;
  RETURN QUERY SELECT * FROM commerce_customer_context.apply_membership_source_locked(
    p_tenant_id, p_legal_entity_id, p_actor_principal_id, p_invocation_id, p_recorded_at, p_payload
  );
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.apply_customer_group_membership_source(uuid, uuid, uuid, uuid, timestamptz, jsonb)
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.apply_customer_group_membership_source(uuid, uuid, uuid, uuid, timestamptz, jsonb)
  TO ontos_runtime;
--> statement-breakpoint
-- Privacy recovery is not exposed before a current exact-scope decision can be verified.
REVOKE ALL ON FUNCTION commerce_customer_context.read_customer_group_membership_source_receipt(uuid, uuid, uuid, jsonb)
  FROM PUBLIC, ontos_runtime;
