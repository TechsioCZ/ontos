-- Archive closes every still-effective membership, including a previously scheduled end.
-- Keep original explicit-removal facts in the committed Action audit/event/Outbox history.
CREATE OR REPLACE FUNCTION "commerce_customer_context"."archive_customer_group"(
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
    AND membership.lifecycle IN ('ACTIVE', 'ENDED')
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
    AND membership.lifecycle IN ('ACTIVE', 'ENDED')
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
