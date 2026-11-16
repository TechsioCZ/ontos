ALTER TABLE commerce_customer_context.customer_group_membership_source_routes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE commerce_customer_context.customer_group_membership_source_receipts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE commerce_customer_context.customer_group_membership_source_routes,
  commerce_customer_context.customer_group_membership_source_receipts FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "commerce_customer_context"."customer_group_membership_document"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_customer_group_membership_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $$
  SELECT jsonb_build_object(
    'assignedAt', metadata.value->>'assignedAt',
    'assignmentReason', metadata.value->>'assignmentReason',
    'effectiveFrom', to_char(membership.effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'effectiveTo', CASE WHEN membership.effective_to IS NULL THEN NULL ELSE to_char(membership.effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'groupRef', jsonb_build_object(
      'moduleId', 'commerce.customer-context',
      'resourceId', membership.customer_group_id::text,
      'resourceType', 'commerce.customer-context.customer-group',
      'tenantId', membership.tenant_id::text
    ),
    'management', membership.management,
    'membershipRef', jsonb_build_object(
      'moduleId', 'commerce.customer-context',
      'resourceId', membership.customer_group_membership_id::text,
      'resourceType', 'commerce.customer-context.customer-group-membership',
      'tenantId', membership.tenant_id::text
    ),
    'profile', jsonb_build_object(
      'profileKind', profile.profile_kind,
      'profileRef', jsonb_build_object(
        'moduleId', 'commerce.customer-context',
        'resourceId', profile.customer_profile_id::text,
        'resourceType', CASE profile.profile_kind
          WHEN 'RETAIL' THEN 'commerce.customer-context.retail-customer-profile'
          ELSE 'commerce.customer-context.counterparty-purchasing-profile'
        END,
        'tenantId', profile.tenant_id::text
      )
    ),
    'removal', metadata.value->'removal',
    'revision', membership.revision,
    'state', CASE WHEN membership.lifecycle = 'CANCELLED' THEN 'CANCELLED' ELSE 'VALID' END
  )
  FROM commerce_customer_context.customer_group_memberships AS membership
  JOIN commerce_customer_context.customer_profiles AS profile
    ON profile.tenant_id = membership.tenant_id
   AND profile.legal_entity_id = membership.legal_entity_id
   AND profile.customer_profile_id = membership.customer_profile_id
  CROSS JOIN LATERAL (SELECT membership.reason::jsonb AS value) AS metadata
  WHERE membership.tenant_id = p_tenant_id
    AND membership.legal_entity_id = p_legal_entity_id
    AND membership.customer_group_membership_id = p_customer_group_membership_id;
$$;
--> statement-breakpoint
-- Serialize Membership and Group lifecycle writes for the same legal entity. Each existing routine
-- keeps its row locks and invariants. Source reconciliation takes the same lock before reading its diff.
CREATE FUNCTION commerce_customer_context.lock_customer_group_membership_scope(p_tenant_id uuid, p_legal_entity_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_tenant_id IS NULL OR p_legal_entity_id IS NULL
    OR p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Commerce Customer Context routine scope mismatch' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ccc.customer-group-membership:' || p_tenant_id::text || ':' || p_legal_entity_id::text, 0)
  );
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.lock_customer_group_membership_scope(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
ALTER FUNCTION commerce_customer_context.assign_customer_group_membership(uuid, uuid, uuid, uuid, text, timestamptz, timestamptz, text, timestamptz, uuid, uuid) RENAME TO assign_membership_locked;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.assign_membership_locked(uuid, uuid, uuid, uuid, text, timestamptz, timestamptz, text, timestamptz, uuid, uuid) FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."assign_customer_group_membership"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_customer_group_id uuid,
  p_customer_profile_id uuid,
  p_profile_kind text,
  p_effective_from timestamptz,
  p_effective_to timestamptz,
  p_reason text,
  p_recorded_at timestamptz,
  p_actor_principal_id uuid,
  p_action_invocation_id uuid
)
RETURNS TABLE (outcome text, changed boolean, membership_json jsonb, profile_state text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $$
DECLARE
  v_result record;
  v_id uuid;
BEGIN
  PERFORM commerce_customer_context.lock_customer_group_membership_scope(p_tenant_id, p_legal_entity_id);
  IF EXISTS (
    SELECT 1 FROM commerce_customer_context.customer_group_membership_source_routes AS route
    WHERE route.tenant_id = p_tenant_id AND route.legal_entity_id = p_legal_entity_id
      AND route.principal_id = p_actor_principal_id
  ) THEN
    RETURN QUERY SELECT 'SOURCE_AUTHORITY_DENIED'::text, false, NULL::jsonb, NULL::text;
    RETURN;
  END IF;
  SELECT * INTO STRICT v_result FROM commerce_customer_context.assign_membership_locked(p_tenant_id, p_legal_entity_id, p_customer_group_id, p_customer_profile_id, p_profile_kind, p_effective_from, p_effective_to, p_reason, p_recorded_at, p_actor_principal_id, p_action_invocation_id);
  IF v_result.outcome = 'ASSIGNED' THEN
    v_id := (v_result.membership_json #>> '{membershipRef,resourceId}')::uuid;
    UPDATE commerce_customer_context.customer_group_memberships AS membership
    SET management = '{"kind":"MANUAL"}'::jsonb
    WHERE membership.tenant_id = p_tenant_id AND membership.legal_entity_id = p_legal_entity_id
      AND membership.customer_group_membership_id = v_id;
    v_result.membership_json := commerce_customer_context.customer_group_membership_document(
      p_tenant_id, p_legal_entity_id, v_id
    );
  END IF;
  RETURN QUERY SELECT v_result.outcome, v_result.changed, v_result.membership_json, v_result.profile_state;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.assign_customer_group_membership(uuid, uuid, uuid, uuid, text, timestamptz, timestamptz, text, timestamptz, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.assign_customer_group_membership(uuid, uuid, uuid, uuid, text, timestamptz, timestamptz, text, timestamptz, uuid, uuid) TO ontos_runtime;
--> statement-breakpoint
ALTER FUNCTION commerce_customer_context.remove_customer_group_membership(uuid, uuid, uuid, uuid, uuid, text, timestamptz, text, timestamptz, uuid, uuid) RENAME TO remove_membership_locked;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.remove_membership_locked(uuid, uuid, uuid, uuid, uuid, text, timestamptz, text, timestamptz, uuid, uuid) FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."remove_customer_group_membership"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_customer_group_membership_id uuid,
  p_customer_group_id uuid,
  p_customer_profile_id uuid,
  p_profile_kind text,
  p_effective_at timestamptz,
  p_reason text,
  p_recorded_at timestamptz,
  p_actor_principal_id uuid,
  p_action_invocation_id uuid
)
RETURNS TABLE (outcome text, changed boolean, membership_json jsonb, profile_state text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $$
BEGIN
  PERFORM commerce_customer_context.lock_customer_group_membership_scope(p_tenant_id, p_legal_entity_id);
  IF EXISTS (
    SELECT 1 FROM commerce_customer_context.customer_group_membership_source_routes AS route
    WHERE route.tenant_id = p_tenant_id AND route.legal_entity_id = p_legal_entity_id
      AND route.principal_id = p_actor_principal_id
  ) THEN
    RETURN QUERY SELECT 'SOURCE_AUTHORITY_DENIED'::text, false, NULL::jsonb, NULL::text;
    RETURN;
  END IF;
  RETURN QUERY SELECT * FROM commerce_customer_context.remove_membership_locked(p_tenant_id, p_legal_entity_id, p_customer_group_membership_id, p_customer_group_id, p_customer_profile_id, p_profile_kind, p_effective_at, p_reason, p_recorded_at, p_actor_principal_id, p_action_invocation_id);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.remove_customer_group_membership(uuid, uuid, uuid, uuid, uuid, text, timestamptz, text, timestamptz, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.remove_customer_group_membership(uuid, uuid, uuid, uuid, uuid, text, timestamptz, text, timestamptz, uuid, uuid) TO ontos_runtime;
--> statement-breakpoint
ALTER FUNCTION commerce_customer_context.archive_customer_group(uuid, uuid, uuid, integer, timestamptz, text, timestamptz, uuid, uuid) RENAME TO archive_group_locked;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.archive_group_locked(uuid, uuid, uuid, integer, timestamptz, text, timestamptz, uuid, uuid) FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."archive_customer_group"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_customer_group_id uuid,
  p_expected_revision integer,
  p_effective_at timestamptz,
  p_reason text,
  p_recorded_at timestamptz,
  p_actor_principal_id uuid,
  p_action_invocation_id uuid
)
RETURNS TABLE (
  outcome text, actual_revision integer, changed boolean, group_json jsonb,
  ended_count integer, cancelled_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
SET row_security = on
AS $$
BEGIN
  PERFORM commerce_customer_context.lock_customer_group_membership_scope(p_tenant_id, p_legal_entity_id);
  RETURN QUERY SELECT * FROM commerce_customer_context.archive_group_locked(p_tenant_id, p_legal_entity_id, p_customer_group_id, p_expected_revision, p_effective_at, p_reason, p_recorded_at, p_actor_principal_id, p_action_invocation_id);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.archive_customer_group(uuid, uuid, uuid, integer, timestamptz, text, timestamptz, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.archive_customer_group(uuid, uuid, uuid, integer, timestamptz, text, timestamptz, uuid, uuid) TO ontos_runtime;
--> statement-breakpoint
ALTER FUNCTION commerce_customer_context.reactivate_customer_group(uuid, uuid, uuid, integer, timestamptz, text, timestamptz, uuid, uuid) RENAME TO reactivate_group_locked;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.reactivate_group_locked(uuid, uuid, uuid, integer, timestamptz, text, timestamptz, uuid, uuid) FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."reactivate_customer_group"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_customer_group_id uuid,
  p_expected_revision integer,
  p_effective_at timestamptz,
  p_reason text,
  p_recorded_at timestamptz,
  p_actor_principal_id uuid,
  p_action_invocation_id uuid
)
RETURNS TABLE (outcome text, actual_revision integer, changed boolean, group_json jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $$
BEGIN
  PERFORM commerce_customer_context.lock_customer_group_membership_scope(p_tenant_id, p_legal_entity_id);
  RETURN QUERY SELECT * FROM commerce_customer_context.reactivate_group_locked(p_tenant_id, p_legal_entity_id, p_customer_group_id, p_expected_revision, p_effective_at, p_reason, p_recorded_at, p_actor_principal_id, p_action_invocation_id);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.reactivate_customer_group(uuid, uuid, uuid, integer, timestamptz, text, timestamptz, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.reactivate_customer_group(uuid, uuid, uuid, integer, timestamptz, text, timestamptz, uuid, uuid) TO ontos_runtime;
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
AS $$
DECLARE
  v_route commerce_customer_context.customer_group_membership_source_routes%ROWTYPE;
  v_profile commerce_customer_context.customer_profiles%ROWTYPE;
  v_receipt commerce_customer_context.customer_group_membership_source_receipts%ROWTYPE;
  v_target commerce_customer_context.customer_group_memberships%ROWTYPE;
  v_manager jsonb := p_payload->'manager';
  v_source jsonb := p_payload->'source';
  v_profile_id uuid := (p_payload #>> '{profile,profileRef,resourceId}')::uuid;
  v_profile_kind text := p_payload #>> '{profile,profileKind}';
  v_operation text := p_payload->>'operation';
  v_effective_at timestamptz := (p_payload->>'effectiveAt')::timestamptz;
  v_order integer := (v_source->>'order')::integer;
  v_group_id uuid;
  v_membership_id uuid;
  v_desired_groups uuid[];
  v_fingerprint text;
  v_row record;
  v_items jsonb := '[]'::jsonb;
  v_result jsonb;
  v_end_count integer;
BEGIN
  PERFORM commerce_customer_context.lock_customer_group_membership_scope(p_tenant_id, p_legal_entity_id);
  IF v_operation IS NULL OR v_operation NOT IN ('ASSIGN', 'REMOVE', 'COMPLETE')
    OR p_actor_principal_id IS NULL OR p_invocation_id IS NULL OR p_recorded_at IS NULL
    OR v_effective_at IS NULL OR v_order IS NULL OR v_order < 1
    OR v_manager->>'factFamily' IS DISTINCT FROM 'CUSTOMER_GROUP_MEMBERSHIP'
    OR v_manager->>'tenantId' IS DISTINCT FROM p_tenant_id::text
    OR p_payload #>> '{profile,profileRef,tenantId}' IS DISTINCT FROM p_tenant_id::text
    OR v_profile_kind IS NULL OR v_profile_kind NOT IN ('RETAIL', 'COUNTERPARTY')
    OR NULLIF(btrim(v_source->>'effectId'), '') IS NULL
    OR NULLIF(btrim(v_source->>'assertionId'), '') IS NULL
    OR NULLIF(btrim(v_source->>'sourceRecordId'), '') IS NULL
    OR NULLIF(btrim(p_payload->>'reason'), '') IS NULL
  THEN
    RETURN QUERY SELECT 'SOURCE_CONFLICT'::text, NULL::jsonb;
    RETURN;
  END IF;
  SELECT route.* INTO v_route
  FROM commerce_customer_context.customer_group_membership_source_routes AS route
  WHERE route.tenant_id = p_tenant_id AND route.legal_entity_id = p_legal_entity_id
    AND route.route_id = p_payload #>> '{route,id}'
    AND route.route_revision = p_payload #>> '{route,revision}'
    AND route.issuer = v_manager->>'issuer' AND route.source_namespace = v_manager->>'sourceNamespace'
    AND route.principal_id = p_actor_principal_id AND route.active
  FOR SHARE;
  IF NOT FOUND OR (v_operation = 'COMPLETE' AND NOT v_route.allow_complete) THEN
    RETURN QUERY SELECT 'SOURCE_AUTHORITY_DENIED'::text, NULL::jsonb;
    RETURN;
  END IF;

  SELECT profile.* INTO v_profile
  FROM commerce_customer_context.customer_profiles AS profile
  WHERE profile.tenant_id = p_tenant_id AND profile.legal_entity_id = p_legal_entity_id
    AND profile.customer_profile_id = v_profile_id AND profile.profile_kind = v_profile_kind
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'TARGET_NOT_FOUND'::text, NULL::jsonb;
    RETURN;
  END IF;
  IF v_profile.lifecycle <> 'ACTIVE' THEN
    RETURN QUERY SELECT 'TARGET_INELIGIBLE'::text, NULL::jsonb;
    RETURN;
  END IF;

  IF v_operation = 'COMPLETE' THEN
    IF jsonb_typeof(p_payload->'groupRefs') IS DISTINCT FROM 'array'
      OR NULLIF(btrim(p_payload->>'completenessProofRef'), '') IS NULL
    THEN
      RETURN QUERY SELECT 'SOURCE_CONFLICT'::text, NULL::jsonb;
      RETURN;
    END IF;
    IF jsonb_array_length(p_payload->'groupRefs') > 100 OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_payload->'groupRefs') AS target(ref)
      WHERE ref->>'tenantId' IS DISTINCT FROM p_tenant_id::text OR ref->>'resourceId' IS NULL
    ) THEN
      RETURN QUERY SELECT 'SOURCE_CONFLICT'::text, NULL::jsonb;
      RETURN;
    END IF;
    SELECT COALESCE(array_agg(DISTINCT (ref->>'resourceId')::uuid ORDER BY (ref->>'resourceId')::uuid), ARRAY[]::uuid[])
    INTO v_desired_groups FROM jsonb_array_elements(p_payload->'groupRefs') AS target(ref);
    IF cardinality(v_desired_groups) <> jsonb_array_length(p_payload->'groupRefs') THEN
      RETURN QUERY SELECT 'SOURCE_CONFLICT'::text, NULL::jsonb;
      RETURN;
    END IF;
  ELSE
    IF p_payload #>> '{groupRef,tenantId}' IS DISTINCT FROM p_tenant_id::text
      OR (v_operation = 'REMOVE' AND p_payload #>> '{membershipRef,tenantId}' IS DISTINCT FROM p_tenant_id::text)
    THEN
      RETURN QUERY SELECT 'SOURCE_CONFLICT'::text, NULL::jsonb;
      RETURN;
    END IF;
    v_group_id := (p_payload #>> '{groupRef,resourceId}')::uuid;
    v_desired_groups := ARRAY[v_group_id];
  END IF;

  -- Route transport identity and raw actor identity are checked separately. Credential/route
  -- revision rotation can recover the exact original receipt through a currently authorized route.
  v_fingerprint := encode(sha256(convert_to(
    ((p_payload - 'route' - 'groupRefs') || jsonb_build_object('groupIds', v_desired_groups))::text, 'UTF8'
  )), 'hex');
  SELECT receipt.* INTO v_receipt
  FROM commerce_customer_context.customer_group_membership_source_receipts AS receipt
  WHERE receipt.tenant_id = p_tenant_id AND receipt.legal_entity_id = p_legal_entity_id
    AND receipt.customer_profile_id = v_profile_id AND receipt.issuer = v_route.issuer
    AND receipt.source_namespace = v_route.source_namespace
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
    AND receipt.customer_profile_id = v_profile_id AND receipt.issuer = v_route.issuer
    AND receipt.source_namespace = v_route.source_namespace
  ORDER BY receipt.source_order DESC LIMIT 1;
  IF FOUND AND (v_order < v_receipt.source_order OR v_effective_at < v_receipt.effective_at) THEN
    RETURN QUERY SELECT 'SOURCE_STALE'::text, NULL::jsonb;
    RETURN;
  END IF;

  IF v_operation = 'REMOVE' THEN
    v_membership_id := (p_payload #>> '{membershipRef,resourceId}')::uuid;
    SELECT membership.* INTO v_target
    FROM commerce_customer_context.customer_group_memberships AS membership
    WHERE membership.tenant_id = p_tenant_id AND membership.legal_entity_id = p_legal_entity_id
      AND membership.customer_profile_id = v_profile_id AND membership.customer_group_id = v_group_id
      AND membership.customer_group_membership_id = v_membership_id
      AND membership.management->'manager' = v_manager;
    IF NOT FOUND THEN
      RETURN QUERY SELECT 'TARGET_NOT_FOUND'::text, NULL::jsonb;
      RETURN;
    END IF;
    IF v_target.revision IS DISTINCT FROM (p_payload->>'expectedRevision')::integer
      OR v_target.lifecycle <> 'ACTIVE'
      OR (v_target.effective_to IS NOT NULL AND v_target.effective_to <= v_effective_at)
    THEN
      RETURN QUERY SELECT 'SOURCE_CONFLICT'::text, NULL::jsonb;
      RETURN;
    END IF;
  ELSE
    -- Resolve every desired Group and every overlap before applying any part of the command.
    IF EXISTS (
      SELECT 1
      FROM unnest(v_desired_groups) AS target(group_id)
      LEFT JOIN commerce_customer_context.customer_groups AS customer_group
        ON customer_group.tenant_id = p_tenant_id AND customer_group.legal_entity_id = p_legal_entity_id
        AND customer_group.customer_group_id = target.group_id
      WHERE customer_group.customer_group_id IS NULL
    ) THEN
      RETURN QUERY SELECT 'TARGET_NOT_FOUND'::text, NULL::jsonb;
      RETURN;
    END IF;
    IF EXISTS (
      SELECT 1
      FROM commerce_customer_context.customer_groups AS customer_group
      WHERE customer_group.tenant_id = p_tenant_id AND customer_group.legal_entity_id = p_legal_entity_id
        AND customer_group.customer_group_id = ANY(v_desired_groups)
        AND (customer_group.lifecycle <> 'ACTIVE' OR NOT EXISTS (
          SELECT 1 FROM commerce_customer_context.customer_group_lifecycle_periods AS period
          WHERE period.tenant_id = p_tenant_id AND period.legal_entity_id = p_legal_entity_id
            AND period.customer_group_id = customer_group.customer_group_id AND period.active_from <= v_effective_at
            AND (period.archived_at IS NULL OR v_effective_at < period.archived_at)
        ))
    ) THEN
      RETURN QUERY SELECT 'TARGET_INELIGIBLE'::text, NULL::jsonb;
      RETURN;
    END IF;
    IF EXISTS (
      SELECT 1 FROM commerce_customer_context.customer_group_memberships AS membership
      WHERE membership.tenant_id = p_tenant_id AND membership.legal_entity_id = p_legal_entity_id
        AND membership.customer_profile_id = v_profile_id AND membership.customer_group_id = ANY(v_desired_groups)
        AND membership.lifecycle <> 'CANCELLED' AND membership.effective_from > v_effective_at
    ) THEN
      RETURN QUERY SELECT 'SOURCE_CONFLICT'::text, NULL::jsonb;
      RETURN;
    END IF;
  END IF;

  -- The source command and resulting receipt are bounded even if a Profile has other managers.
  IF v_operation = 'COMPLETE' THEN
    SELECT count(*) INTO v_end_count
    FROM commerce_customer_context.customer_group_memberships AS membership
    WHERE membership.tenant_id = p_tenant_id AND membership.legal_entity_id = p_legal_entity_id
      AND membership.customer_profile_id = v_profile_id AND membership.lifecycle <> 'CANCELLED'
      AND (membership.effective_to IS NULL OR membership.effective_to > v_effective_at)
      AND membership.management->'manager' = v_manager
      AND NOT (membership.customer_group_id = ANY(v_desired_groups));
    IF v_end_count > 100 THEN
      RETURN QUERY SELECT 'SOURCE_CONFLICT'::text, NULL::jsonb;
      RETURN;
    END IF;
  END IF;

  IF v_operation <> 'REMOVE' THEN
    FOREACH v_group_id IN ARRAY v_desired_groups LOOP
      SELECT membership.* INTO v_target
      FROM commerce_customer_context.customer_group_memberships AS membership
      WHERE membership.tenant_id = p_tenant_id AND membership.legal_entity_id = p_legal_entity_id
        AND membership.customer_profile_id = v_profile_id AND membership.customer_group_id = v_group_id
        AND membership.lifecycle <> 'CANCELLED' AND membership.effective_from <= v_effective_at
        AND (membership.effective_to IS NULL OR membership.effective_to > v_effective_at);
      IF FOUND THEN
        IF v_target.management->'manager' = v_manager THEN
          v_items := v_items || jsonb_build_array(jsonb_build_object(
            'membership', commerce_customer_context.customer_group_membership_document(
              p_tenant_id, p_legal_entity_id, v_target.customer_group_membership_id
            ),
            'outcome', 'ALREADY_MANAGED'
          ));
        ELSE
          v_items := v_items || jsonb_build_array(jsonb_build_object(
            'groupRef', jsonb_build_object(
              'tenantId', p_tenant_id::text,
              'moduleId', 'commerce.customer-context',
              'resourceType', 'commerce.customer-context.customer-group',
              'resourceId', v_group_id::text
            ),
            'outcome', 'SATISFIED_BY_OTHER_MANAGER'
          ));
        END IF;
        CONTINUE;
      END IF;
      SELECT * INTO STRICT v_row FROM commerce_customer_context.assign_membership_locked(
        p_tenant_id, p_legal_entity_id, v_group_id, v_profile_id, v_profile_kind, v_effective_at,
        NULL, p_payload->>'reason', p_recorded_at, p_actor_principal_id, p_invocation_id
      );
      v_membership_id := (v_row.membership_json #>> '{membershipRef,resourceId}')::uuid;
      IF v_row.outcome = 'ALREADY_ASSIGNED' AND v_row.membership_json->>'state' = 'CANCELLED' THEN
        v_membership_id := gen_random_uuid();
        INSERT INTO commerce_customer_context.customer_group_memberships (
          customer_group_membership_id, tenant_id, legal_entity_id, customer_profile_id,
          customer_group_id, effective_from, action_invocation_id, actor_principal_id, reason, recorded_at
        ) VALUES (
          v_membership_id, p_tenant_id, p_legal_entity_id, v_profile_id, v_group_id, v_effective_at,
          p_invocation_id, p_actor_principal_id, jsonb_build_object(
            'assignedAt', to_char(p_recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'assignmentReason', p_payload->>'reason',
            'removal', NULL
          )::text, p_recorded_at
        );
        INSERT INTO commerce_customer_context.customer_setting_revisions (
          tenant_id, legal_entity_id, customer_profile_id, setting_kind, current_revision,
          last_action_invocation_id, updated_at
        ) VALUES (
          p_tenant_id, p_legal_entity_id, v_profile_id, 'GROUP_MEMBERSHIP', 1, p_invocation_id, p_recorded_at
        )
        ON CONFLICT (tenant_id, legal_entity_id, customer_profile_id, setting_kind) DO UPDATE
        SET current_revision = commerce_customer_context.customer_setting_revisions.current_revision + 1,
          last_action_invocation_id = excluded.last_action_invocation_id, updated_at = excluded.updated_at;
      ELSIF v_row.outcome <> 'ASSIGNED' THEN
        RAISE EXCEPTION 'Membership source assignment did not preserve its validated invariant';
      END IF;
      UPDATE commerce_customer_context.customer_group_memberships AS membership
      SET management = jsonb_build_object('kind', 'EXTERNAL_SOURCE', 'manager', v_manager, 'source', v_source)
      WHERE membership.tenant_id = p_tenant_id AND membership.legal_entity_id = p_legal_entity_id
        AND membership.customer_group_membership_id = v_membership_id;
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'membership', commerce_customer_context.customer_group_membership_document(p_tenant_id, p_legal_entity_id, v_membership_id),
        'outcome', 'ASSIGNED'
      ));
    END LOOP;
  END IF;

  IF v_operation <> 'ASSIGN' THEN
    FOR v_target IN
      SELECT membership.* FROM commerce_customer_context.customer_group_memberships AS membership
      WHERE membership.tenant_id = p_tenant_id AND membership.legal_entity_id = p_legal_entity_id
        AND membership.customer_profile_id = v_profile_id AND membership.management->'manager' = v_manager
        AND membership.lifecycle <> 'CANCELLED'
        AND (membership.effective_to IS NULL OR membership.effective_to > v_effective_at)
        AND (CASE WHEN v_operation = 'REMOVE' THEN membership.customer_group_membership_id = v_membership_id
          ELSE NOT (membership.customer_group_id = ANY(v_desired_groups)) END)
      ORDER BY membership.customer_group_membership_id
    LOOP
      SELECT * INTO STRICT v_row FROM commerce_customer_context.remove_membership_locked(
        p_tenant_id, p_legal_entity_id, v_target.customer_group_membership_id, v_target.customer_group_id,
        v_profile_id, v_profile_kind, v_effective_at, p_payload->>'reason', p_recorded_at,
        p_actor_principal_id, p_invocation_id
      );
      IF v_row.outcome = 'REMOVAL_CONFLICT' THEN
        RAISE EXCEPTION USING ERRCODE = 'P1127', MESSAGE = 'SOURCE_CONFLICT';
      END IF;
      IF v_row.outcome <> 'REMOVED' OR NOT v_row.changed THEN
        RAISE EXCEPTION 'Membership source removal did not preserve its validated invariant';
      END IF;
      UPDATE commerce_customer_context.customer_group_memberships AS membership
      SET reason = jsonb_set(membership.reason::jsonb, '{removal,source}', v_source)::text
      WHERE membership.tenant_id = p_tenant_id AND membership.legal_entity_id = p_legal_entity_id
        AND membership.customer_group_membership_id = v_target.customer_group_membership_id;
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'membership', commerce_customer_context.customer_group_membership_document(
          p_tenant_id, p_legal_entity_id, v_target.customer_group_membership_id
        ),
        'outcome', 'ENDED'
      ));
    END LOOP;
  END IF;

  v_result := jsonb_build_object('items', v_items, 'source', v_source);
  INSERT INTO commerce_customer_context.customer_group_membership_source_receipts (
    tenant_id, legal_entity_id, customer_profile_id, issuer, source_namespace, source_order, assertion_id, effect_id,
    effective_at, fingerprint, result, action_invocation_id, actor_principal_id, recorded_at
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_profile_id, v_route.issuer, v_route.source_namespace, v_order,
    v_source->>'assertionId', v_source->>'effectId', v_effective_at, v_fingerprint, v_result,
    p_invocation_id, p_actor_principal_id, p_recorded_at
  );
  RETURN QUERY SELECT 'APPLIED'::text, v_result;
EXCEPTION WHEN SQLSTATE 'P1127' THEN
  -- Preserve the scheduled removal and roll back any earlier changes in the snapshot.
  RETURN QUERY SELECT 'SOURCE_CONFLICT'::text, NULL::jsonb;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.apply_customer_group_membership_source(uuid, uuid, uuid, uuid, timestamptz, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.apply_customer_group_membership_source(uuid, uuid, uuid, uuid, timestamptz, jsonb) TO ontos_runtime;
--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.read_customer_group_membership_source_receipt(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_actor_principal_id uuid,
  p_query jsonb
)
RETURNS TABLE (outcome text, result jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF p_tenant_id IS NULL OR p_legal_entity_id IS NULL
    OR p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Commerce Customer Context routine scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_query #>> '{manager,tenantId}' IS DISTINCT FROM p_tenant_id::text
    OR p_query #>> '{manager,factFamily}' IS DISTINCT FROM 'CUSTOMER_GROUP_MEMBERSHIP'
    OR p_query #>> '{profile,profileRef,tenantId}' IS DISTINCT FROM p_tenant_id::text
    OR NOT EXISTS (
      SELECT 1 FROM commerce_customer_context.customer_group_membership_source_routes AS route
      WHERE route.tenant_id = p_tenant_id AND route.legal_entity_id = p_legal_entity_id
        AND route.route_id = p_query #>> '{route,id}' AND route.route_revision = p_query #>> '{route,revision}'
        AND route.issuer = p_query #>> '{manager,issuer}'
        AND route.source_namespace = p_query #>> '{manager,sourceNamespace}'
        AND route.principal_id = p_actor_principal_id AND route.active
    )
  THEN
    RETURN QUERY SELECT 'SOURCE_AUTHORITY_DENIED'::text, NULL::jsonb;
    RETURN;
  END IF;
  SELECT receipt.result INTO v_result
  FROM commerce_customer_context.customer_group_membership_source_receipts AS receipt
  JOIN commerce_customer_context.customer_profiles AS profile
    ON profile.tenant_id = receipt.tenant_id AND profile.legal_entity_id = receipt.legal_entity_id
    AND profile.customer_profile_id = receipt.customer_profile_id
  WHERE receipt.tenant_id = p_tenant_id AND receipt.legal_entity_id = p_legal_entity_id
    AND receipt.customer_profile_id = (p_query #>> '{profile,profileRef,resourceId}')::uuid
    AND profile.profile_kind = p_query #>> '{profile,profileKind}' AND profile.lifecycle = 'ACTIVE'
    AND receipt.issuer = p_query #>> '{manager,issuer}'
    AND receipt.source_namespace = p_query #>> '{manager,sourceNamespace}'
    AND receipt.effect_id = p_query->>'effectId';
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'TARGET_NOT_FOUND'::text, NULL::jsonb;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'FOUND'::text, v_result;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.read_customer_group_membership_source_receipt(uuid, uuid, uuid, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.read_customer_group_membership_source_receipt(uuid, uuid, uuid, jsonb) TO ontos_runtime;
