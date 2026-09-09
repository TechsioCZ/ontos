CREATE FUNCTION "commerce_customer_context"."customer_group_document"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_customer_group_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $$
DECLARE
  v_document jsonb;
BEGIN
  SELECT jsonb_build_object(
    'businessCode', customer_group.stable_code,
    'currentDefinition', (
      SELECT jsonb_build_object(
        'changeKind', revision.change_kind,
        'description', revision.description,
        'membershipCriteria', revision.membership_criteria,
        'name', revision.display_name,
        'purpose', revision.purpose,
        'reason', revision.reason,
        'recordedAt', to_char(revision.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'revision', revision.revision
      )
      FROM commerce_customer_context.customer_group_revisions AS revision
      WHERE revision.tenant_id = p_tenant_id
        AND revision.legal_entity_id = p_legal_entity_id
        AND revision.customer_group_id = p_customer_group_id
      ORDER BY revision.revision DESC
      LIMIT 1
    ),
    'currentState', customer_group.lifecycle,
    'definitionHistory', coalesce((
      SELECT jsonb_agg(
        jsonb_build_object(
          'changeKind', revision.change_kind,
          'description', revision.description,
          'membershipCriteria', revision.membership_criteria,
          'name', revision.display_name,
          'purpose', revision.purpose,
          'reason', revision.reason,
          'recordedAt', to_char(revision.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'revision', revision.revision
        ) ORDER BY revision.revision
      )
      FROM commerce_customer_context.customer_group_revisions AS revision
      WHERE revision.tenant_id = p_tenant_id
        AND revision.legal_entity_id = p_legal_entity_id
        AND revision.customer_group_id = p_customer_group_id
    ), '[]'::jsonb),
    'groupRef', jsonb_build_object(
      'moduleId', 'commerce.customer-context',
      'resourceId', customer_group.customer_group_id::text,
      'resourceType', 'commerce.customer-context.customer-group',
      'tenantId', customer_group.tenant_id::text
    ),
    'lifecycleHistory', coalesce((
      SELECT jsonb_agg(
        jsonb_build_object(
          'activeFrom', to_char(period.active_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'archivedAt', CASE WHEN period.archived_at IS NULL THEN NULL ELSE to_char(period.archived_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
          'reason', period.reason,
          'recordedAt', to_char(period.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ) ORDER BY period.active_from, period.revision
      )
      FROM commerce_customer_context.customer_group_lifecycle_periods AS period
      WHERE period.tenant_id = p_tenant_id
        AND period.legal_entity_id = p_legal_entity_id
        AND period.customer_group_id = p_customer_group_id
    ), '[]'::jsonb),
    'meaningKey', customer_group.meaning_key,
    'revision', customer_group.current_revision
  ) INTO v_document
  FROM commerce_customer_context.customer_groups AS customer_group
  WHERE customer_group.tenant_id = p_tenant_id
    AND customer_group.legal_entity_id = p_legal_entity_id
    AND customer_group.customer_group_id = p_customer_group_id;
  RETURN v_document;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."customer_group_membership_document"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_customer_group_membership_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
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
CREATE FUNCTION "commerce_customer_context"."read_customer_group"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_customer_group_id uuid
)
RETURNS TABLE (outcome text, actual_revision integer, changed boolean, group_json jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $$
DECLARE
  v_revision integer;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Commerce Customer Context routine scope mismatch' USING ERRCODE = '42501';
  END IF;

  SELECT customer_group.current_revision
  INTO v_revision
  FROM commerce_customer_context.customer_groups AS customer_group
  WHERE customer_group.tenant_id = p_tenant_id
    AND customer_group.legal_entity_id = p_legal_entity_id
    AND customer_group.customer_group_id = p_customer_group_id;

  IF v_revision IS NULL THEN
    RETURN QUERY SELECT 'NOT_FOUND'::text, 0, false, NULL::jsonb;
  ELSE
    RETURN QUERY SELECT 'PRESENT'::text, v_revision, false,
      commerce_customer_context.customer_group_document(p_tenant_id, p_legal_entity_id, p_customer_group_id);
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."create_customer_group"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_business_code text,
  p_meaning_key text,
  p_description text,
  p_membership_criteria text,
  p_display_name text,
  p_purpose text,
  p_reason text,
  p_recorded_at timestamptz,
  p_actor_principal_id uuid,
  p_action_invocation_id uuid
)
RETURNS TABLE (outcome text, actual_revision integer, changed boolean, group_json jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $$
DECLARE
  v_customer_group_id uuid;
  v_existing record;
  v_fingerprint text;
  v_semantic_input text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Commerce Customer Context routine scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_recorded_at IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'Invalid Customer Group creation command' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || p_legal_entity_id::text, 0));
  v_semantic_input := jsonb_build_array(
    lower(regexp_replace(btrim(p_purpose), '\s+', ' ', 'g')),
    lower(regexp_replace(btrim(p_membership_criteria), '\s+', ' ', 'g'))
  )::text;
  v_fingerprint := encode(sha256(convert_to(v_semantic_input, 'UTF8')), 'hex');

  SELECT customer_group.customer_group_id, customer_group.stable_code, customer_group.meaning_key,
         revision.semantic_fingerprint, revision.action_invocation_id
  INTO v_existing
  FROM commerce_customer_context.customer_groups AS customer_group
  JOIN commerce_customer_context.customer_group_revisions AS revision
    ON revision.tenant_id = customer_group.tenant_id
   AND revision.legal_entity_id = customer_group.legal_entity_id
   AND revision.customer_group_id = customer_group.customer_group_id
   AND revision.revision = 1
  WHERE customer_group.tenant_id = p_tenant_id
    AND customer_group.legal_entity_id = p_legal_entity_id
    AND (customer_group.stable_code = p_business_code
      OR customer_group.meaning_key = p_meaning_key
      OR revision.semantic_fingerprint = v_fingerprint)
  ORDER BY CASE WHEN revision.action_invocation_id = p_action_invocation_id THEN 0
                WHEN customer_group.stable_code = p_business_code THEN 1 ELSE 2 END
  LIMIT 1;

  IF v_existing.customer_group_id IS NOT NULL THEN
    IF v_existing.action_invocation_id = p_action_invocation_id
      OR (v_existing.stable_code = p_business_code
        AND v_existing.meaning_key = p_meaning_key
        AND v_existing.semantic_fingerprint = v_fingerprint)
    THEN
      RETURN QUERY SELECT 'REUSED'::text, 1, false,
        commerce_customer_context.customer_group_document(p_tenant_id, p_legal_entity_id, v_existing.customer_group_id);
    ELSIF v_existing.stable_code = p_business_code THEN
      RETURN QUERY SELECT 'BUSINESS_CODE_CONFLICT'::text, 0, false, NULL::jsonb;
    ELSE
      RETURN QUERY SELECT 'SEMANTIC_DUPLICATE'::text, 0, false, NULL::jsonb;
    END IF;
    RETURN;
  END IF;

  v_customer_group_id := gen_random_uuid();
  INSERT INTO commerce_customer_context.customer_groups (
    customer_group_id, tenant_id, legal_entity_id, stable_code, meaning_key,
    lifecycle, current_revision, created_at, updated_at
  ) VALUES (
    v_customer_group_id, p_tenant_id, p_legal_entity_id, p_business_code, p_meaning_key,
    'ACTIVE', 1, p_recorded_at, p_recorded_at
  );
  INSERT INTO commerce_customer_context.customer_group_revisions (
    tenant_id, legal_entity_id, customer_group_id, revision, display_name, description,
    purpose, membership_criteria, change_kind, semantic_fingerprint, action_invocation_id,
    actor_principal_id, reason, recorded_at
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_customer_group_id, 1, p_display_name, p_description,
    p_purpose, p_membership_criteria, 'CREATED', v_fingerprint, p_action_invocation_id,
    p_actor_principal_id, p_reason, p_recorded_at
  );
  INSERT INTO commerce_customer_context.customer_group_lifecycle_periods (
    tenant_id, legal_entity_id, customer_group_id, active_from, revision,
    action_invocation_id, actor_principal_id, reason, recorded_at
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_customer_group_id, p_recorded_at, 1,
    p_action_invocation_id, p_actor_principal_id, p_reason, p_recorded_at
  );

  RETURN QUERY SELECT 'CREATED'::text, 1, true,
    commerce_customer_context.customer_group_document(p_tenant_id, p_legal_entity_id, v_customer_group_id);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."update_customer_group"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_customer_group_id uuid,
  p_expected_revision integer,
  p_description text,
  p_membership_criteria text,
  p_display_name text,
  p_purpose text,
  p_reason text,
  p_recorded_at timestamptz,
  p_actor_principal_id uuid,
  p_action_invocation_id uuid
)
RETURNS TABLE (outcome text, actual_revision integer, changed boolean, group_json jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $$
DECLARE
  v_group commerce_customer_context.customer_groups%ROWTYPE;
  v_current_definition commerce_customer_context.customer_group_revisions%ROWTYPE;
  v_change_kind text;
  v_definition_revision integer;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Commerce Customer Context routine scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_expected_revision < 1 OR p_recorded_at IS NULL OR btrim(p_reason) = ''
  THEN
    RAISE EXCEPTION 'Invalid Customer Group update command' USING ERRCODE = '22023';
  END IF;

  SELECT customer_group.* INTO v_group
  FROM commerce_customer_context.customer_groups AS customer_group
  WHERE customer_group.tenant_id = p_tenant_id
    AND customer_group.legal_entity_id = p_legal_entity_id
    AND customer_group.customer_group_id = p_customer_group_id
  FOR UPDATE;
  IF v_group.customer_group_id IS NULL THEN
    RETURN QUERY SELECT 'NOT_FOUND'::text, 0, false, NULL::jsonb;
    RETURN;
  END IF;

  SELECT revision.* INTO v_current_definition
  FROM commerce_customer_context.customer_group_revisions AS revision
  WHERE revision.tenant_id = p_tenant_id
    AND revision.legal_entity_id = p_legal_entity_id
    AND revision.customer_group_id = p_customer_group_id
  ORDER BY revision.revision DESC
  LIMIT 1;

  IF EXISTS (
    SELECT 1 FROM commerce_customer_context.customer_group_revisions AS revision
    WHERE revision.tenant_id = p_tenant_id
      AND revision.legal_entity_id = p_legal_entity_id
      AND revision.customer_group_id = p_customer_group_id
      AND revision.action_invocation_id = p_action_invocation_id
  ) THEN
    RETURN QUERY SELECT 'UPDATED'::text, v_group.current_revision, false,
      commerce_customer_context.customer_group_document(p_tenant_id, p_legal_entity_id, p_customer_group_id);
    RETURN;
  END IF;
  IF v_group.current_revision <> p_expected_revision THEN
    RETURN QUERY SELECT 'REVISION_CONFLICT'::text, v_group.current_revision, false, NULL::jsonb;
    RETURN;
  END IF;
  IF p_membership_criteria IS DISTINCT FROM v_current_definition.membership_criteria
    OR p_purpose IS DISTINCT FROM v_current_definition.purpose
  THEN
    RETURN QUERY SELECT 'NEW_GROUP_REQUIRED'::text, v_group.current_revision, false, NULL::jsonb;
    RETURN;
  END IF;
  IF v_group.lifecycle = 'ARCHIVED'
    AND (p_display_name IS DISTINCT FROM v_current_definition.display_name
      OR p_description IS DISTINCT FROM v_current_definition.description)
  THEN
    RETURN QUERY SELECT 'ARCHIVED_CORRECTION_FORBIDDEN'::text, v_group.current_revision, false, NULL::jsonb;
    RETURN;
  END IF;
  IF p_display_name = v_current_definition.display_name
    AND p_description = v_current_definition.description
  THEN
    RETURN QUERY SELECT 'UPDATED'::text, v_group.current_revision, false,
      commerce_customer_context.customer_group_document(p_tenant_id, p_legal_entity_id, p_customer_group_id);
    RETURN;
  END IF;

  v_change_kind := CASE
    WHEN p_description IS DISTINCT FROM v_current_definition.description
      THEN 'DESCRIPTION_CLARIFICATION'
    ELSE 'COSMETIC_RENAME'
  END;
  v_definition_revision := v_current_definition.revision + 1;
  INSERT INTO commerce_customer_context.customer_group_revisions (
    tenant_id, legal_entity_id, customer_group_id, revision, display_name, description,
    purpose, membership_criteria, change_kind, semantic_fingerprint, action_invocation_id,
    actor_principal_id, reason, recorded_at
  ) VALUES (
    p_tenant_id, p_legal_entity_id, p_customer_group_id, v_definition_revision,
    p_display_name, p_description, p_purpose, p_membership_criteria, v_change_kind,
    v_current_definition.semantic_fingerprint, p_action_invocation_id,
    p_actor_principal_id, p_reason, p_recorded_at
  );
  UPDATE commerce_customer_context.customer_groups
  SET current_revision = current_revision + 1, updated_at = p_recorded_at
  WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
    AND customer_group_id = p_customer_group_id;

  RETURN QUERY SELECT 'UPDATED'::text, v_group.current_revision + 1, true,
    commerce_customer_context.customer_group_document(p_tenant_id, p_legal_entity_id, p_customer_group_id);
END;
$$;
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
SET search_path = pg_catalog, commerce_customer_context
AS $$
DECLARE
  v_group commerce_customer_context.customer_groups%ROWTYPE;
  v_open_period commerce_customer_context.customer_group_lifecycle_periods%ROWTYPE;
  v_ended_count integer := 0;
  v_cancelled_count integer := 0;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Commerce Customer Context routine scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_expected_revision < 1 OR p_effective_at IS NULL OR p_recorded_at IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'Invalid Customer Group archive command' USING ERRCODE = '22023';
  END IF;

  SELECT customer_group.* INTO v_group
  FROM commerce_customer_context.customer_groups AS customer_group
  WHERE customer_group.tenant_id = p_tenant_id
    AND customer_group.legal_entity_id = p_legal_entity_id
    AND customer_group.customer_group_id = p_customer_group_id
  FOR UPDATE;
  IF v_group.customer_group_id IS NULL THEN
    RETURN QUERY SELECT 'NOT_FOUND'::text, 0, false, NULL::jsonb, 0, 0;
    RETURN;
  END IF;
  IF v_group.lifecycle = 'ARCHIVED' AND v_group.archived_at = p_effective_at THEN
    RETURN QUERY SELECT 'ARCHIVED'::text, v_group.current_revision, false,
      commerce_customer_context.customer_group_document(p_tenant_id, p_legal_entity_id, p_customer_group_id), 0, 0;
    RETURN;
  END IF;
  IF v_group.current_revision <> p_expected_revision THEN
    RETURN QUERY SELECT 'REVISION_CONFLICT'::text, v_group.current_revision, false, NULL::jsonb, 0, 0;
    RETURN;
  END IF;

  SELECT period.* INTO v_open_period
  FROM commerce_customer_context.customer_group_lifecycle_periods AS period
  WHERE period.tenant_id = p_tenant_id
    AND period.legal_entity_id = p_legal_entity_id
    AND period.customer_group_id = p_customer_group_id
    AND period.archived_at IS NULL
  FOR UPDATE;
  IF v_open_period.customer_group_lifecycle_period_id IS NULL
    OR p_effective_at <= v_open_period.active_from
    OR p_effective_at > p_recorded_at
  THEN
    RETURN QUERY SELECT 'LIFECYCLE_CONFLICT'::text, v_group.current_revision, false, NULL::jsonb, 0, 0;
    RETURN;
  END IF;

  UPDATE commerce_customer_context.customer_group_memberships AS membership
  SET effective_to = p_effective_at,
      lifecycle = 'ENDED',
      revision = membership.revision + 1,
      action_invocation_id = p_action_invocation_id,
      actor_principal_id = p_actor_principal_id,
      recorded_at = p_recorded_at,
      reason = jsonb_set(
        membership.reason::jsonb,
        '{removal}',
        jsonb_build_object(
          'effectiveAt', to_char(p_effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'kind', 'GROUP_ARCHIVED',
          'reason', p_reason,
          'recordedAt', to_char(p_recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        )
      )::text
  WHERE membership.tenant_id = p_tenant_id
    AND membership.legal_entity_id = p_legal_entity_id
    AND membership.customer_group_id = p_customer_group_id
    AND membership.lifecycle = 'ACTIVE'
    AND membership.effective_from < p_effective_at
    AND (membership.effective_to IS NULL OR membership.effective_to > p_effective_at);
  GET DIAGNOSTICS v_ended_count = ROW_COUNT;

  UPDATE commerce_customer_context.customer_group_memberships AS membership
  SET lifecycle = 'CANCELLED',
      revision = membership.revision + 1,
      action_invocation_id = p_action_invocation_id,
      actor_principal_id = p_actor_principal_id,
      recorded_at = p_recorded_at,
      reason = jsonb_set(
        membership.reason::jsonb,
        '{removal}',
        jsonb_build_object(
          'effectiveAt', to_char(p_effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'kind', 'GROUP_ARCHIVED',
          'reason', p_reason,
          'recordedAt', to_char(p_recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        )
      )::text
  WHERE membership.tenant_id = p_tenant_id
    AND membership.legal_entity_id = p_legal_entity_id
    AND membership.customer_group_id = p_customer_group_id
    AND membership.lifecycle = 'ACTIVE'
    AND membership.effective_from >= p_effective_at;
  GET DIAGNOSTICS v_cancelled_count = ROW_COUNT;

  INSERT INTO commerce_customer_context.customer_setting_revisions (
    tenant_id, legal_entity_id, customer_profile_id, setting_kind, current_revision,
    last_action_invocation_id, updated_at
  )
  SELECT p_tenant_id, p_legal_entity_id, affected.customer_profile_id, 'GROUP_MEMBERSHIP', 1,
         p_action_invocation_id, p_recorded_at
  FROM (
    SELECT DISTINCT membership.customer_profile_id
    FROM commerce_customer_context.customer_group_memberships AS membership
    WHERE membership.tenant_id = p_tenant_id
      AND membership.legal_entity_id = p_legal_entity_id
      AND membership.customer_group_id = p_customer_group_id
      AND membership.action_invocation_id = p_action_invocation_id
  ) AS affected
  ON CONFLICT (tenant_id, legal_entity_id, customer_profile_id, setting_kind)
  DO UPDATE SET current_revision = commerce_customer_context.customer_setting_revisions.current_revision + 1,
                last_action_invocation_id = excluded.last_action_invocation_id,
                updated_at = excluded.updated_at;

  UPDATE commerce_customer_context.customer_group_lifecycle_periods
  SET archived_at = p_effective_at, action_invocation_id = p_action_invocation_id,
      actor_principal_id = p_actor_principal_id, reason = p_reason, recorded_at = p_recorded_at
  WHERE customer_group_lifecycle_period_id = v_open_period.customer_group_lifecycle_period_id;
  UPDATE commerce_customer_context.customer_groups
  SET lifecycle = 'ARCHIVED', archived_at = p_effective_at,
      current_revision = current_revision + 1, updated_at = p_recorded_at
  WHERE customer_group_id = p_customer_group_id;

  RETURN QUERY SELECT 'ARCHIVED'::text, v_group.current_revision + 1, true,
    commerce_customer_context.customer_group_document(p_tenant_id, p_legal_entity_id, p_customer_group_id),
    v_ended_count, v_cancelled_count;
END;
$$;
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
SET search_path = pg_catalog, commerce_customer_context
AS $$
DECLARE
  v_group commerce_customer_context.customer_groups%ROWTYPE;
  v_last_period commerce_customer_context.customer_group_lifecycle_periods%ROWTYPE;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Commerce Customer Context routine scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_expected_revision < 1 OR p_effective_at IS NULL OR p_recorded_at IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'Invalid Customer Group reactivation command' USING ERRCODE = '22023';
  END IF;

  SELECT customer_group.* INTO v_group
  FROM commerce_customer_context.customer_groups AS customer_group
  WHERE customer_group.tenant_id = p_tenant_id
    AND customer_group.legal_entity_id = p_legal_entity_id
    AND customer_group.customer_group_id = p_customer_group_id
  FOR UPDATE;
  IF v_group.customer_group_id IS NULL THEN
    RETURN QUERY SELECT 'NOT_FOUND'::text, 0, false, NULL::jsonb;
    RETURN;
  END IF;
  SELECT period.* INTO v_last_period
  FROM commerce_customer_context.customer_group_lifecycle_periods AS period
  WHERE period.tenant_id = p_tenant_id
    AND period.legal_entity_id = p_legal_entity_id
    AND period.customer_group_id = p_customer_group_id
  ORDER BY period.active_from DESC, period.revision DESC
  LIMIT 1;

  IF v_group.lifecycle = 'ACTIVE' AND v_last_period.active_from = p_effective_at THEN
    RETURN QUERY SELECT 'REACTIVATED'::text, v_group.current_revision, false,
      commerce_customer_context.customer_group_document(p_tenant_id, p_legal_entity_id, p_customer_group_id);
    RETURN;
  END IF;
  IF v_group.current_revision <> p_expected_revision THEN
    RETURN QUERY SELECT 'REVISION_CONFLICT'::text, v_group.current_revision, false, NULL::jsonb;
    RETURN;
  END IF;
  IF v_group.lifecycle <> 'ARCHIVED' OR v_last_period.archived_at IS NULL
    OR p_effective_at <= v_last_period.archived_at OR p_effective_at > p_recorded_at
  THEN
    RETURN QUERY SELECT 'LIFECYCLE_CONFLICT'::text, v_group.current_revision, false, NULL::jsonb;
    RETURN;
  END IF;

  INSERT INTO commerce_customer_context.customer_group_lifecycle_periods (
    tenant_id, legal_entity_id, customer_group_id, active_from, revision,
    action_invocation_id, actor_principal_id, reason, recorded_at
  ) VALUES (
    p_tenant_id, p_legal_entity_id, p_customer_group_id, p_effective_at,
    v_group.current_revision + 1, p_action_invocation_id, p_actor_principal_id,
    p_reason, p_recorded_at
  );
  UPDATE commerce_customer_context.customer_groups
  SET lifecycle = 'ACTIVE', archived_at = NULL, current_revision = current_revision + 1,
      updated_at = p_recorded_at
  WHERE customer_group_id = p_customer_group_id;

  RETURN QUERY SELECT 'REACTIVATED'::text, v_group.current_revision + 1, true,
    commerce_customer_context.customer_group_document(p_tenant_id, p_legal_entity_id, p_customer_group_id);
END;
$$;
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
SET search_path = pg_catalog, commerce_customer_context
AS $$
DECLARE
  v_group commerce_customer_context.customer_groups%ROWTYPE;
  v_profile commerce_customer_context.customer_profiles%ROWTYPE;
  v_membership_id uuid;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Commerce Customer Context routine scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_profile_kind NOT IN ('RETAIL', 'COUNTERPARTY') OR p_effective_from IS NULL
    OR (p_effective_to IS NOT NULL AND p_effective_to <= p_effective_from)
    OR p_recorded_at IS NULL OR btrim(p_reason) = ''
  THEN
    RAISE EXCEPTION 'Invalid Customer Group assignment command' USING ERRCODE = '22023';
  END IF;

  SELECT customer_group.* INTO v_group
  FROM commerce_customer_context.customer_groups AS customer_group
  WHERE customer_group.tenant_id = p_tenant_id
    AND customer_group.legal_entity_id = p_legal_entity_id
    AND customer_group.customer_group_id = p_customer_group_id
  FOR UPDATE;
  IF v_group.customer_group_id IS NULL THEN
    RETURN QUERY SELECT 'NOT_FOUND'::text, false, NULL::jsonb, NULL::text;
    RETURN;
  END IF;
  SELECT profile.* INTO v_profile
  FROM commerce_customer_context.customer_profiles AS profile
  WHERE profile.tenant_id = p_tenant_id
    AND profile.legal_entity_id = p_legal_entity_id
    AND profile.customer_profile_id = p_customer_profile_id
    AND profile.profile_kind = p_profile_kind
  FOR UPDATE;
  IF v_profile.customer_profile_id IS NULL THEN
    RETURN QUERY SELECT 'PROFILE_NOT_FOUND'::text, false, NULL::jsonb, NULL::text;
    RETURN;
  END IF;

  SELECT membership.customer_group_membership_id INTO v_membership_id
  FROM commerce_customer_context.customer_group_memberships AS membership
  WHERE membership.tenant_id = p_tenant_id
    AND membership.legal_entity_id = p_legal_entity_id
    AND membership.customer_profile_id = p_customer_profile_id
    AND membership.customer_group_id = p_customer_group_id
    AND membership.effective_from = p_effective_from
    AND membership.effective_to IS NOT DISTINCT FROM p_effective_to
  ORDER BY membership.customer_group_membership_id
  LIMIT 1;
  IF v_membership_id IS NOT NULL THEN
    RETURN QUERY SELECT 'ALREADY_ASSIGNED'::text, false,
      commerce_customer_context.customer_group_membership_document(p_tenant_id, p_legal_entity_id, v_membership_id), NULL::text;
    RETURN;
  END IF;

  IF v_profile.lifecycle <> 'ACTIVE' THEN
    RETURN QUERY SELECT 'PROFILE_INELIGIBLE'::text, false, NULL::jsonb, v_profile.lifecycle;
    RETURN;
  END IF;
  IF v_group.lifecycle <> 'ACTIVE' OR NOT EXISTS (
    SELECT 1
    FROM commerce_customer_context.customer_group_lifecycle_periods AS period
    WHERE period.tenant_id = p_tenant_id
      AND period.legal_entity_id = p_legal_entity_id
      AND period.customer_group_id = p_customer_group_id
      AND period.active_from <= p_effective_from
      AND (period.archived_at IS NULL OR p_effective_from < period.archived_at)
  ) THEN
    RETURN QUERY SELECT 'GROUP_INACTIVE'::text, false, NULL::jsonb, NULL::text;
    RETURN;
  END IF;

  SELECT membership.customer_group_membership_id INTO v_membership_id
  FROM commerce_customer_context.customer_group_memberships AS membership
  WHERE membership.tenant_id = p_tenant_id
    AND membership.legal_entity_id = p_legal_entity_id
    AND membership.customer_profile_id = p_customer_profile_id
    AND membership.customer_group_id = p_customer_group_id
    AND membership.lifecycle <> 'CANCELLED'
    AND tstzrange(membership.effective_from, membership.effective_to, '[)')
      && tstzrange(p_effective_from, p_effective_to, '[)')
  ORDER BY membership.customer_group_membership_id
  LIMIT 1;
  IF v_membership_id IS NOT NULL THEN
    RETURN QUERY SELECT 'OVERLAP'::text, false,
      commerce_customer_context.customer_group_membership_document(p_tenant_id, p_legal_entity_id, v_membership_id), NULL::text;
    RETURN;
  END IF;

  v_membership_id := gen_random_uuid();
  INSERT INTO commerce_customer_context.customer_group_memberships (
    customer_group_membership_id, tenant_id, legal_entity_id, customer_profile_id,
    customer_group_id, effective_from, effective_to, lifecycle, revision,
    action_invocation_id, actor_principal_id, reason, recorded_at
  ) VALUES (
    v_membership_id, p_tenant_id, p_legal_entity_id, p_customer_profile_id,
    p_customer_group_id, p_effective_from, p_effective_to, 'ACTIVE', 1,
    p_action_invocation_id, p_actor_principal_id,
    jsonb_build_object(
      'assignedAt', to_char(p_recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'assignmentReason', p_reason,
      'removal', NULL
    )::text,
    p_recorded_at
  );
  INSERT INTO commerce_customer_context.customer_setting_revisions (
    tenant_id, legal_entity_id, customer_profile_id, setting_kind, current_revision,
    last_action_invocation_id, updated_at
  ) VALUES (
    p_tenant_id, p_legal_entity_id, p_customer_profile_id, 'GROUP_MEMBERSHIP', 1,
    p_action_invocation_id, p_recorded_at
  )
  ON CONFLICT (tenant_id, legal_entity_id, customer_profile_id, setting_kind)
  DO UPDATE SET current_revision = commerce_customer_context.customer_setting_revisions.current_revision + 1,
                last_action_invocation_id = excluded.last_action_invocation_id,
                updated_at = excluded.updated_at;

  RETURN QUERY SELECT 'ASSIGNED'::text, true,
    commerce_customer_context.customer_group_membership_document(p_tenant_id, p_legal_entity_id, v_membership_id), NULL::text;
END;
$$;
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
SET search_path = pg_catalog, commerce_customer_context
AS $$
DECLARE
  v_membership commerce_customer_context.customer_group_memberships%ROWTYPE;
  v_metadata jsonb;
  v_removal_effective_at timestamptz;
  v_cancel boolean;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Commerce Customer Context routine scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_profile_kind NOT IN ('RETAIL', 'COUNTERPARTY') OR p_effective_at IS NULL
    OR p_recorded_at IS NULL OR btrim(p_reason) = ''
  THEN
    RAISE EXCEPTION 'Invalid Customer Group removal command' USING ERRCODE = '22023';
  END IF;

  SELECT membership.* INTO v_membership
  FROM commerce_customer_context.customer_group_memberships AS membership
  JOIN commerce_customer_context.customer_profiles AS profile
    ON profile.tenant_id = membership.tenant_id
   AND profile.legal_entity_id = membership.legal_entity_id
   AND profile.customer_profile_id = membership.customer_profile_id
   AND profile.profile_kind = p_profile_kind
  WHERE membership.tenant_id = p_tenant_id
    AND membership.legal_entity_id = p_legal_entity_id
    AND membership.customer_group_membership_id = p_customer_group_membership_id
    AND membership.customer_group_id = p_customer_group_id
    AND membership.customer_profile_id = p_customer_profile_id
  FOR UPDATE OF membership;
  IF v_membership.customer_group_membership_id IS NULL THEN
    RETURN QUERY SELECT 'NOT_FOUND'::text, false, NULL::jsonb, NULL::text;
    RETURN;
  END IF;

  v_metadata := v_membership.reason::jsonb;
  IF v_metadata->'removal' IS NOT NULL AND jsonb_typeof(v_metadata->'removal') <> 'null' THEN
    v_removal_effective_at := (v_metadata->'removal'->>'effectiveAt')::timestamptz;
    RETURN QUERY SELECT
      CASE WHEN v_removal_effective_at = p_effective_at THEN 'REMOVED' ELSE 'REMOVAL_CONFLICT' END,
      false,
      commerce_customer_context.customer_group_membership_document(p_tenant_id, p_legal_entity_id, p_customer_group_membership_id),
      NULL::text;
    RETURN;
  END IF;
  IF v_membership.effective_to IS NOT NULL AND v_membership.effective_to <= p_effective_at THEN
    RETURN QUERY SELECT 'ALREADY_ENDED'::text, false,
      commerce_customer_context.customer_group_membership_document(p_tenant_id, p_legal_entity_id, p_customer_group_membership_id), NULL::text;
    RETURN;
  END IF;

  v_cancel := p_effective_at <= v_membership.effective_from;
  UPDATE commerce_customer_context.customer_group_memberships
  SET effective_to = CASE WHEN v_cancel THEN effective_to ELSE p_effective_at END,
      lifecycle = CASE WHEN v_cancel THEN 'CANCELLED' ELSE 'ENDED' END,
      revision = revision + 1,
      action_invocation_id = p_action_invocation_id,
      actor_principal_id = p_actor_principal_id,
      recorded_at = p_recorded_at,
      reason = jsonb_set(
        v_metadata,
        '{removal}',
        jsonb_build_object(
          'effectiveAt', to_char(p_effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'kind', CASE WHEN v_cancel THEN 'EXPLICIT_CANCEL' ELSE 'EXPLICIT_END' END,
          'reason', p_reason,
          'recordedAt', to_char(p_recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        )
      )::text
  WHERE customer_group_membership_id = p_customer_group_membership_id;
  INSERT INTO commerce_customer_context.customer_setting_revisions (
    tenant_id, legal_entity_id, customer_profile_id, setting_kind, current_revision,
    last_action_invocation_id, updated_at
  ) VALUES (
    p_tenant_id, p_legal_entity_id, p_customer_profile_id, 'GROUP_MEMBERSHIP', 1,
    p_action_invocation_id, p_recorded_at
  )
  ON CONFLICT (tenant_id, legal_entity_id, customer_profile_id, setting_kind)
  DO UPDATE SET current_revision = commerce_customer_context.customer_setting_revisions.current_revision + 1,
                last_action_invocation_id = excluded.last_action_invocation_id,
                updated_at = excluded.updated_at;

  RETURN QUERY SELECT 'REMOVED'::text, true,
    commerce_customer_context.customer_group_membership_document(p_tenant_id, p_legal_entity_id, p_customer_group_membership_id), NULL::text;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."read_customer_group_members"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_customer_group_id uuid,
  p_effective_at timestamptz,
  p_profile_kind text,
  p_cursor text,
  p_limit integer
)
RETURNS TABLE (outcome text, group_json jsonb, items_json jsonb, next_cursor text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Commerce Customer Context routine scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_effective_at IS NULL OR p_limit < 1 OR p_limit > 100
    OR (p_profile_kind IS NOT NULL AND p_profile_kind NOT IN ('RETAIL', 'COUNTERPARTY'))
  THEN
    RAISE EXCEPTION 'Invalid Customer Group member query' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM commerce_customer_context.customer_groups AS customer_group
    WHERE customer_group.tenant_id = p_tenant_id
      AND customer_group.legal_entity_id = p_legal_entity_id
      AND customer_group.customer_group_id = p_customer_group_id
  ) THEN
    RETURN QUERY SELECT 'NOT_FOUND'::text, NULL::jsonb, '[]'::jsonb, NULL::text;
    RETURN;
  END IF;

  RETURN QUERY
  WITH candidates AS MATERIALIZED (
    SELECT membership.customer_group_membership_id
    FROM commerce_customer_context.customer_group_memberships AS membership
    JOIN commerce_customer_context.customer_profiles AS profile
      ON profile.tenant_id = membership.tenant_id
     AND profile.legal_entity_id = membership.legal_entity_id
     AND profile.customer_profile_id = membership.customer_profile_id
    WHERE membership.tenant_id = p_tenant_id
      AND membership.legal_entity_id = p_legal_entity_id
      AND membership.customer_group_id = p_customer_group_id
      AND membership.lifecycle <> 'CANCELLED'
      AND membership.effective_from <= p_effective_at
      AND (membership.effective_to IS NULL OR p_effective_at < membership.effective_to)
      AND (
        SELECT history.to_lifecycle
        FROM commerce_customer_context.customer_profile_lifecycle_history AS history
        WHERE history.tenant_id = p_tenant_id
          AND history.legal_entity_id = p_legal_entity_id
          AND history.customer_profile_id = profile.customer_profile_id
          AND history.recorded_at <= p_effective_at
        ORDER BY history.recorded_at DESC, history.revision DESC
        LIMIT 1
      ) = 'ACTIVE'
      AND (p_profile_kind IS NULL OR profile.profile_kind = p_profile_kind)
      AND (p_cursor IS NULL OR membership.customer_group_membership_id::text > p_cursor)
      AND EXISTS (
        SELECT 1 FROM commerce_customer_context.customer_group_lifecycle_periods AS period
        WHERE period.tenant_id = p_tenant_id
          AND period.legal_entity_id = p_legal_entity_id
          AND period.customer_group_id = p_customer_group_id
          AND period.active_from <= p_effective_at
          AND (period.archived_at IS NULL OR p_effective_at < period.archived_at)
      )
    ORDER BY membership.customer_group_membership_id::text
    LIMIT p_limit + 1
  ), page AS (
    SELECT candidate.customer_group_membership_id
    FROM candidates AS candidate
    ORDER BY candidate.customer_group_membership_id::text
    LIMIT p_limit
  )
  SELECT 'PRESENT'::text,
    commerce_customer_context.customer_group_document(p_tenant_id, p_legal_entity_id, p_customer_group_id),
    coalesce((
      SELECT jsonb_agg(
        commerce_customer_context.customer_group_membership_document(
          p_tenant_id, p_legal_entity_id, page_row.customer_group_membership_id
        ) ORDER BY page_row.customer_group_membership_id::text
      ) FROM page AS page_row
    ), '[]'::jsonb),
    CASE WHEN (SELECT count(*) FROM candidates) > p_limit
      THEN (SELECT max(page_row.customer_group_membership_id::text) FROM page AS page_row)
      ELSE NULL::text END;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."read_customer_group_history"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_customer_group_id uuid,
  p_as_of timestamptz,
  p_cursor text,
  p_limit integer
)
RETURNS TABLE (outcome text, group_json jsonb, items_json jsonb, next_cursor text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Commerce Customer Context routine scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'Invalid Customer Group history query' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM commerce_customer_context.customer_groups AS customer_group
    WHERE customer_group.tenant_id = p_tenant_id
      AND customer_group.legal_entity_id = p_legal_entity_id
      AND customer_group.customer_group_id = p_customer_group_id
  ) THEN
    RETURN QUERY SELECT 'NOT_FOUND'::text, NULL::jsonb, '[]'::jsonb, NULL::text;
    RETURN;
  END IF;

  RETURN QUERY
  WITH candidates AS MATERIALIZED (
    SELECT membership.customer_group_membership_id
    FROM commerce_customer_context.customer_group_memberships AS membership
    WHERE membership.tenant_id = p_tenant_id
      AND membership.legal_entity_id = p_legal_entity_id
      AND membership.customer_group_id = p_customer_group_id
      AND (
        p_as_of IS NULL
        OR (
          membership.lifecycle <> 'CANCELLED'
          AND membership.effective_from <= p_as_of
          AND (membership.effective_to IS NULL OR p_as_of < membership.effective_to)
          AND EXISTS (
            SELECT 1
            FROM commerce_customer_context.customer_group_lifecycle_periods AS period
            WHERE period.tenant_id = p_tenant_id
              AND period.legal_entity_id = p_legal_entity_id
              AND period.customer_group_id = p_customer_group_id
              AND period.active_from <= p_as_of
              AND (period.archived_at IS NULL OR p_as_of < period.archived_at)
          )
          AND (
            SELECT history.to_lifecycle
            FROM commerce_customer_context.customer_profile_lifecycle_history AS history
            WHERE history.tenant_id = p_tenant_id
              AND history.legal_entity_id = p_legal_entity_id
              AND history.customer_profile_id = membership.customer_profile_id
              AND history.recorded_at <= p_as_of
            ORDER BY history.recorded_at DESC, history.revision DESC
            LIMIT 1
          ) = 'ACTIVE'
        )
      )
      AND (p_cursor IS NULL OR membership.customer_group_membership_id::text > p_cursor)
    ORDER BY membership.customer_group_membership_id::text
    LIMIT p_limit + 1
  ), page AS (
    SELECT candidate.customer_group_membership_id
    FROM candidates AS candidate
    ORDER BY candidate.customer_group_membership_id::text
    LIMIT p_limit
  )
  SELECT 'PRESENT'::text,
    commerce_customer_context.customer_group_document(p_tenant_id, p_legal_entity_id, p_customer_group_id),
    coalesce((
      SELECT jsonb_agg(
        commerce_customer_context.customer_group_membership_document(
          p_tenant_id, p_legal_entity_id, page_row.customer_group_membership_id
        ) ORDER BY page_row.customer_group_membership_id::text
      ) FROM page AS page_row
    ), '[]'::jsonb),
    CASE WHEN (SELECT count(*) FROM candidates) > p_limit
      THEN (SELECT max(page_row.customer_group_membership_id::text) FROM page AS page_row)
      ELSE NULL::text END;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."read_effective_customer_group_memberships"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_customer_profile_id uuid,
  p_profile_kind text,
  p_effective_at timestamptz
)
RETURNS TABLE (outcome text, group_json jsonb, items_json jsonb, next_cursor text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $$
DECLARE
  v_profile_exists boolean;
  v_profile_lifecycle text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Commerce Customer Context routine scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_profile_kind NOT IN ('RETAIL', 'COUNTERPARTY') OR p_effective_at IS NULL THEN
    RAISE EXCEPTION 'Invalid effective Customer Group Membership query' USING ERRCODE = '22023';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM commerce_customer_context.customer_profiles AS profile
    WHERE profile.tenant_id = p_tenant_id
      AND profile.legal_entity_id = p_legal_entity_id
      AND profile.customer_profile_id = p_customer_profile_id
      AND profile.profile_kind = p_profile_kind
  ) INTO v_profile_exists;
  IF NOT v_profile_exists THEN
    RETURN QUERY SELECT 'PROFILE_NOT_FOUND'::text, NULL::jsonb, '[]'::jsonb, NULL::text;
    RETURN;
  END IF;

  SELECT history.to_lifecycle INTO v_profile_lifecycle
  FROM commerce_customer_context.customer_profile_lifecycle_history AS history
  WHERE history.tenant_id = p_tenant_id
    AND history.legal_entity_id = p_legal_entity_id
    AND history.customer_profile_id = p_customer_profile_id
    AND history.recorded_at <= p_effective_at
  ORDER BY history.recorded_at DESC, history.revision DESC
  LIMIT 1;
  IF v_profile_lifecycle IS DISTINCT FROM 'ACTIVE' THEN
    RETURN QUERY SELECT 'PRESENT'::text, NULL::jsonb, '[]'::jsonb, NULL::text;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT 'PRESENT'::text, NULL::jsonb,
    coalesce(jsonb_agg(
      commerce_customer_context.customer_group_membership_document(
        p_tenant_id, p_legal_entity_id, membership.customer_group_membership_id
      ) ORDER BY membership.customer_group_membership_id::text
    ), '[]'::jsonb),
    NULL::text
  FROM commerce_customer_context.customer_group_memberships AS membership
  WHERE membership.tenant_id = p_tenant_id
    AND membership.legal_entity_id = p_legal_entity_id
    AND membership.customer_profile_id = p_customer_profile_id
    AND membership.lifecycle <> 'CANCELLED'
    AND membership.effective_from <= p_effective_at
    AND (membership.effective_to IS NULL OR p_effective_at < membership.effective_to)
    AND EXISTS (
      SELECT 1 FROM commerce_customer_context.customer_group_lifecycle_periods AS period
      WHERE period.tenant_id = p_tenant_id
        AND period.legal_entity_id = p_legal_entity_id
        AND period.customer_group_id = membership.customer_group_id
        AND period.active_from <= p_effective_at
        AND (period.archived_at IS NULL OR p_effective_at < period.archived_at)
    );
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."customer_group_document"(uuid, uuid, uuid) FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."customer_group_membership_document"(uuid, uuid, uuid) FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."read_customer_group"(uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."create_customer_group"(uuid, uuid, text, text, text, text, text, text, text, timestamptz, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."update_customer_group"(uuid, uuid, uuid, integer, text, text, text, text, text, timestamptz, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."archive_customer_group"(uuid, uuid, uuid, integer, timestamptz, text, timestamptz, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."reactivate_customer_group"(uuid, uuid, uuid, integer, timestamptz, text, timestamptz, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."assign_customer_group_membership"(uuid, uuid, uuid, uuid, text, timestamptz, timestamptz, text, timestamptz, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."remove_customer_group_membership"(uuid, uuid, uuid, uuid, uuid, text, timestamptz, text, timestamptz, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."read_customer_group_members"(uuid, uuid, uuid, timestamptz, text, text, integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."read_customer_group_history"(uuid, uuid, uuid, timestamptz, text, integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."read_effective_customer_group_memberships"(uuid, uuid, uuid, text, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_customer_group"(uuid, uuid, uuid) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."create_customer_group"(uuid, uuid, text, text, text, text, text, text, text, timestamptz, uuid, uuid) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."update_customer_group"(uuid, uuid, uuid, integer, text, text, text, text, text, timestamptz, uuid, uuid) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."archive_customer_group"(uuid, uuid, uuid, integer, timestamptz, text, timestamptz, uuid, uuid) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."reactivate_customer_group"(uuid, uuid, uuid, integer, timestamptz, text, timestamptz, uuid, uuid) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."assign_customer_group_membership"(uuid, uuid, uuid, uuid, text, timestamptz, timestamptz, text, timestamptz, uuid, uuid) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."remove_customer_group_membership"(uuid, uuid, uuid, uuid, uuid, text, timestamptz, text, timestamptz, uuid, uuid) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_customer_group_members"(uuid, uuid, uuid, timestamptz, text, text, integer) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_customer_group_history"(uuid, uuid, uuid, timestamptz, text, integer) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_effective_customer_group_memberships"(uuid, uuid, uuid, text, timestamptz) TO "ontos_runtime";
