-- Exact-period finite preference omission; retained rows and the final coverage invariant remain intact.
CREATE OR REPLACE FUNCTION "commerce_customer_context"."persist_customer_payment_terms"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_input jsonb
)
RETURNS TABLE(outcome text, current_revision integer, payload jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $$
DECLARE
  v_action_invocation_id uuid := (p_input->>'actionInvocationId')::uuid;
  v_changed boolean := (p_input->>'changed')::boolean;
  v_counterparty_resource_id text := p_input->>'counterpartyResourceId';
  v_current_revision integer;
  v_desired jsonb := p_input->'state';
  v_desired_revision integer := (p_input->'state'->>'revision')::integer;
  v_entitlement jsonb;
  v_existing commerce_customer_context.customer_payment_term_entitlements%ROWTYPE;
  v_exists boolean;
  v_known boolean;
  v_lifecycle text;
  v_original_end timestamptz;
  v_ended_at timestamptz;
  v_cancelled_at timestamptz;
  v_expected_revision integer := (p_input->>'expectedRevision')::integer;
  v_principal_id uuid := (p_input->>'principalId')::uuid;
  v_profile commerce_customer_context.customer_profiles%ROWTYPE;
  v_profile_id uuid := (p_input->>'profileResourceId')::uuid;
  v_profile_kind text := p_input->>'profileKind';
  v_reason text := p_input->>'reason';
  v_preference jsonb;
  v_setting commerce_customer_context.customer_setting_revisions%ROWTYPE;
BEGIN
  PERFORM commerce_customer_context.assert_customer_payment_terms_scope(
    p_tenant_id, p_legal_entity_id
  );
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object'
    OR v_action_invocation_id IS NULL
    OR v_changed IS NULL
    OR v_expected_revision IS NULL
    OR v_principal_id IS NULL
    OR v_profile_id IS NULL
    OR v_profile_kind IS NULL
    OR v_profile_kind NOT IN ('COUNTERPARTY', 'RETAIL')
    OR (v_profile_kind = 'COUNTERPARTY' AND (
      v_counterparty_resource_id IS NULL OR length(btrim(v_counterparty_resource_id)) = 0
    ))
    OR jsonb_typeof(v_desired) IS DISTINCT FROM 'object'
    OR jsonb_typeof(v_desired->'entitlements') IS DISTINCT FROM 'array'
    OR jsonb_typeof(v_desired->'preferences') IS DISTINCT FROM 'array'
    OR v_desired_revision IS NULL
  THEN
    RAISE EXCEPTION 'invalid customer payment terms persistence input' USING ERRCODE = '22023';
  END IF;
  SELECT profile.* INTO v_profile
  FROM commerce_customer_context.customer_profiles AS profile
  WHERE profile.tenant_id = p_tenant_id
    AND profile.legal_entity_id = p_legal_entity_id
    AND profile.customer_profile_id = v_profile_id
  FOR UPDATE;
  IF NOT FOUND OR v_profile.profile_kind <> v_profile_kind THEN
    RETURN QUERY SELECT 'PROFILE_NOT_FOUND'::text, NULL::integer, NULL::jsonb;
    RETURN;
  END IF;
  IF v_profile.lifecycle <> 'ACTIVE' THEN
    RETURN QUERY SELECT 'PROFILE_INELIGIBLE'::text, v_profile.revision, NULL::jsonb;
    RETURN;
  END IF;
  IF v_profile_kind = 'COUNTERPARTY' AND NOT EXISTS (
    SELECT 1
    FROM commerce_customer_context.counterparty_purchasing_profiles AS counterparty_profile
    WHERE counterparty_profile.tenant_id = p_tenant_id
      AND counterparty_profile.legal_entity_id = p_legal_entity_id
      AND counterparty_profile.counterparty_purchasing_profile_id = v_profile_id
      AND counterparty_profile.counterparty_resource_id = v_counterparty_resource_id
  ) THEN
    RETURN QUERY SELECT 'PROFILE_COUNTERPARTY_MISMATCH'::text, v_profile.revision, NULL::jsonb;
    RETURN;
  END IF;
  IF v_profile_kind = 'RETAIL' AND (
    v_counterparty_resource_id IS NOT NULL OR NOT EXISTS (
      SELECT 1
      FROM commerce_customer_context.retail_customer_profiles AS retail_profile
      WHERE retail_profile.tenant_id = p_tenant_id
        AND retail_profile.legal_entity_id = p_legal_entity_id
        AND retail_profile.retail_customer_profile_id = v_profile_id
    )
  ) THEN
    RETURN QUERY SELECT 'PROFILE_NOT_FOUND'::text, v_profile.revision, NULL::jsonb;
    RETURN;
  END IF;

  IF v_reason IS NULL OR length(btrim(v_reason)) = 0 OR length(v_reason) > 500
    OR v_desired->'profileRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
    OR v_desired->'profileRef'->>'resourceId' IS DISTINCT FROM v_profile_id::text
    OR v_desired->'profileRef'->>'moduleId' IS DISTINCT FROM 'commerce.customer-context'
    OR v_desired->'profileRef'->>'resourceType' IS DISTINCT FROM (CASE
      WHEN v_profile_kind = 'RETAIL' THEN 'commerce.customer-context.retail-customer-profile'
      ELSE 'commerce.customer-context.counterparty-purchasing-profile'
    END)
  THEN
    RAISE EXCEPTION 'invalid customer payment terms state' USING ERRCODE = '22023';
  END IF;

  INSERT INTO commerce_customer_context.customer_setting_revisions (
    tenant_id, legal_entity_id, customer_profile_id, setting_kind, current_revision
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_profile_id, 'PAYMENT_TERMS', 1
  ) ON CONFLICT (tenant_id, legal_entity_id, customer_profile_id, setting_kind) DO NOTHING;
  SELECT setting.* INTO v_setting
  FROM commerce_customer_context.customer_setting_revisions AS setting
  WHERE setting.tenant_id = p_tenant_id
    AND setting.legal_entity_id = p_legal_entity_id
    AND setting.customer_profile_id = v_profile_id
    AND setting.setting_kind = 'PAYMENT_TERMS'
  FOR UPDATE;
  v_current_revision := v_setting.current_revision;

  -- Core owns the durable request hash. This owner guard makes an immediate duplicate invocation
  -- return committed state before the caller's stale expected revision is considered.
  IF v_setting.last_action_invocation_id = v_action_invocation_id THEN
    RETURN QUERY SELECT
      'UNCHANGED'::text,
      v_current_revision,
      commerce_customer_context.customer_payment_terms_state_json(
        p_tenant_id, p_legal_entity_id, v_profile_id, v_profile_kind
      );
    RETURN;
  END IF;
  IF v_expected_revision <> v_current_revision THEN
    RETURN QUERY SELECT 'REVISION_CONFLICT'::text, v_current_revision, NULL::jsonb;
    RETURN;
  END IF;
  IF NOT v_changed THEN
    IF v_desired_revision <> v_current_revision THEN
      RAISE EXCEPTION 'unchanged payment terms revision mismatch' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY SELECT
      'UNCHANGED'::text,
      v_current_revision,
      commerce_customer_context.customer_payment_terms_state_json(
        p_tenant_id, p_legal_entity_id, v_profile_id, v_profile_kind
      );
    RETURN;
  END IF;
  IF v_desired_revision <> v_current_revision + 1 THEN
    RAISE EXCEPTION 'changed payment terms revision mismatch' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_desired->'entitlements') AS candidate
    WHERE jsonb_typeof(candidate) IS DISTINCT FROM 'object'
      OR candidate->'entitlementRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
      OR candidate->'entitlementRef'->>'moduleId' IS DISTINCT FROM 'commerce.customer-context'
      OR candidate->'entitlementRef'->>'resourceType' IS DISTINCT FROM 'commerce.customer-context.customer-payment-term-entitlement'
      OR candidate->'paymentTermRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
      OR candidate->'paymentTermRef'->>'moduleId' IS DISTINCT FROM 'payment.term-catalog'
      OR candidate->'paymentTermRef'->>'resourceType' IS DISTINCT FROM 'payment.term-catalog.payment-term'
      OR candidate->>'status' IS NULL
      OR candidate->>'status' NOT IN ('ACTIVE', 'CANCELLED')
      OR (candidate->>'status' = 'CANCELLED' AND candidate->>'cancelledAt' IS NULL)
      OR (candidate->>'status' = 'ACTIVE' AND candidate ? 'cancelledAt')
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_desired->'preferences') AS candidate
    WHERE jsonb_typeof(candidate) IS DISTINCT FROM 'object'
      OR candidate->'paymentTermRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
      OR candidate->'paymentTermRef'->>'moduleId' IS DISTINCT FROM 'payment.term-catalog'
      OR candidate->'paymentTermRef'->>'resourceType' IS DISTINCT FROM 'payment.term-catalog.payment-term'
  ) THEN
    RAISE EXCEPTION 'cross-scope customer payment terms reference' USING ERRCODE = '22023';
  END IF;

  -- New schedules are explicit. Unknown historical finite rows retain every fact unchanged.
  FOR v_entitlement IN SELECT value FROM jsonb_array_elements(v_desired->'entitlements') LOOP
    v_known := v_entitlement ? 'originalEffectiveTo';
    v_original_end := nullif(v_entitlement->>'originalEffectiveTo', '')::timestamptz;
    v_ended_at := nullif(v_entitlement->>'endedAt', '')::timestamptz;
    v_cancelled_at := nullif(v_entitlement->>'cancelledAt', '')::timestamptz;
    v_lifecycle := CASE WHEN v_entitlement->>'status' = 'CANCELLED' THEN 'CANCELLED'
      WHEN v_ended_at IS NOT NULL THEN 'ENDED' ELSE 'ACTIVE' END;

    IF (v_entitlement ? 'endedAt' AND (v_ended_at IS NULL OR v_entitlement->>'status' <> 'ACTIVE'))
      OR (v_entitlement ? 'cancelledAt' AND v_cancelled_at IS NULL)
      OR (v_known AND jsonb_typeof(v_entitlement->'originalEffectiveTo') NOT IN ('null', 'string'))
      OR (v_known AND jsonb_typeof(v_entitlement->'originalEffectiveTo') = 'string' AND v_original_end IS NULL) THEN
      RAISE EXCEPTION 'invalid explicit payment term removal provenance' USING ERRCODE = '22023';
    END IF;

    SELECT existing.* INTO v_existing
    FROM commerce_customer_context.customer_payment_term_entitlements AS existing
    WHERE existing.tenant_id = p_tenant_id AND existing.legal_entity_id = p_legal_entity_id
      AND existing.customer_profile_id = v_profile_id
      AND existing.customer_payment_term_entitlement_id = (v_entitlement->'entitlementRef'->>'resourceId')::uuid;
    v_exists := FOUND;

    IF NOT v_known THEN
      IF NOT v_exists OR v_existing.grant_schedule_known
        OR v_existing.effective_to IS DISTINCT FROM nullif(v_entitlement->>'effectiveTo', '')::timestamptz
        OR v_entitlement->>'status' IS DISTINCT FROM
          (CASE WHEN v_existing.lifecycle = 'CANCELLED' THEN 'CANCELLED' ELSE 'ACTIVE' END)
        OR v_ended_at IS NOT NULL
        OR (v_existing.lifecycle = 'CANCELLED' AND v_cancelled_at IS DISTINCT FROM v_existing.recorded_at)
        OR (v_existing.lifecycle <> 'CANCELLED' AND v_cancelled_at IS NOT NULL) THEN
        RAISE EXCEPTION 'unknown legacy payment term removal provenance cannot change' USING ERRCODE = '22023';
      END IF;
      v_lifecycle := v_existing.lifecycle;
      -- Legacy cancelledAt is decoded from recorded_at; do not backfill or relabel that row.
      v_cancelled_at := NULL;
    ELSIF v_exists THEN
      IF (v_existing.grant_schedule_known AND v_existing.original_effective_to IS DISTINCT FROM v_original_end)
        OR (NOT v_existing.grant_schedule_known AND NOT (
          v_existing.lifecycle = 'ACTIVE' AND v_existing.effective_to IS NULL AND v_original_end IS NULL
        )) THEN
        RAISE EXCEPTION 'immutable original payment term grant schedule changed' USING ERRCODE = '22023';
      END IF;
      IF v_existing.lifecycle IN ('ENDED', 'CANCELLED') AND (
        v_existing.lifecycle IS DISTINCT FROM v_lifecycle
        OR v_existing.effective_to IS DISTINCT FROM nullif(v_entitlement->>'effectiveTo', '')::timestamptz
        OR v_existing.ended_at IS DISTINCT FROM v_ended_at
        OR v_existing.cancelled_at IS DISTINCT FROM v_cancelled_at
      ) THEN
        RAISE EXCEPTION 'immutable explicit payment term removal changed' USING ERRCODE = '22023';
      END IF;
    END IF;

    IF v_exists AND (
      v_existing.payment_term_resource_id IS DISTINCT FROM v_entitlement->'paymentTermRef'->>'resourceId'
      OR v_existing.payment_term_semantic_revision IS DISTINCT FROM v_entitlement->>'semanticRevisionId'
      OR v_existing.effective_from IS DISTINCT FROM (v_entitlement->>'effectiveFrom')::timestamptz
    ) THEN
      RAISE EXCEPTION 'immutable payment term entitlement identity changed' USING ERRCODE = '22023';
    END IF;
    INSERT INTO commerce_customer_context.customer_payment_term_entitlements (
      customer_payment_term_entitlement_id, tenant_id, legal_entity_id, customer_profile_id,
      payment_term_resource_id, payment_term_semantic_revision, effective_from, effective_to,
      lifecycle, grant_schedule_known, original_effective_to, ended_at, cancelled_at,
      revision, action_invocation_id, actor_principal_id, reason, recorded_at
    ) VALUES (
      (v_entitlement->'entitlementRef'->>'resourceId')::uuid,
      p_tenant_id, p_legal_entity_id, v_profile_id,
      v_entitlement->'paymentTermRef'->>'resourceId', v_entitlement->>'semanticRevisionId',
      (v_entitlement->>'effectiveFrom')::timestamptz,
      nullif(v_entitlement->>'effectiveTo', '')::timestamptz,
      v_lifecycle, v_known, v_original_end, v_ended_at, v_cancelled_at,
      v_desired_revision, v_action_invocation_id, v_principal_id, v_reason, now()
    ) ON CONFLICT (customer_payment_term_entitlement_id) DO UPDATE SET
      effective_to = excluded.effective_to, lifecycle = excluded.lifecycle,
      grant_schedule_known = excluded.grant_schedule_known, original_effective_to = excluded.original_effective_to,
      ended_at = excluded.ended_at, cancelled_at = excluded.cancelled_at,
      revision = excluded.revision, action_invocation_id = excluded.action_invocation_id,
      actor_principal_id = excluded.actor_principal_id, reason = excluded.reason, recorded_at = excluded.recorded_at
    WHERE customer_payment_term_entitlements.tenant_id = p_tenant_id
      AND customer_payment_term_entitlements.legal_entity_id = p_legal_entity_id
      AND customer_payment_term_entitlements.customer_profile_id = v_profile_id
      AND (
        customer_payment_term_entitlements.effective_to IS DISTINCT FROM excluded.effective_to
        OR customer_payment_term_entitlements.lifecycle IS DISTINCT FROM excluded.lifecycle
      );
  END LOOP;
  IF (
    SELECT count(*)
    FROM commerce_customer_context.customer_payment_term_entitlements AS existing
    WHERE existing.tenant_id = p_tenant_id
      AND existing.legal_entity_id = p_legal_entity_id
      AND existing.customer_profile_id = v_profile_id
  ) <> jsonb_array_length(v_desired->'entitlements') THEN
    RAISE EXCEPTION 'customer payment term entitlement history cannot be removed' USING ERRCODE = '22023';
  END IF;

  -- Omitted preferences are future facts cancelled before effectiveness; effective history is
  -- retained as ENDED rows and every new or changed preference is attributed.
  UPDATE commerce_customer_context.customer_payment_term_preferences AS existing
  SET lifecycle = 'CANCELLED', revision = v_desired_revision,
      action_invocation_id = v_action_invocation_id, actor_principal_id = v_principal_id,
      reason = v_reason, recorded_at = now()
  WHERE existing.tenant_id = p_tenant_id
    AND existing.legal_entity_id = p_legal_entity_id
    AND existing.customer_profile_id = v_profile_id
    AND (
      existing.lifecycle = 'ACTIVE'
      OR (
        -- A finite preference is ENDED at creation, even before its start. Only the
        -- current exact support-removal invocation may cancel this omitted future fact.
        existing.lifecycle = 'ENDED'
        AND existing.effective_to IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM commerce_customer_context.customer_payment_term_entitlements AS removed
          WHERE removed.tenant_id = p_tenant_id
            AND removed.legal_entity_id = p_legal_entity_id
            AND removed.customer_profile_id = v_profile_id
            AND removed.payment_term_resource_id = existing.payment_term_resource_id
            AND removed.action_invocation_id = v_action_invocation_id
            AND removed.grant_schedule_known
            AND removed.effective_from <= existing.effective_from
            AND (removed.original_effective_to IS NULL OR existing.effective_to <= removed.original_effective_to)
            AND (
              (removed.lifecycle = 'CANCELLED' AND removed.cancelled_at <= existing.effective_from)
              OR (removed.lifecycle = 'ENDED' AND removed.ended_at <= existing.effective_from)
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM commerce_customer_context.customer_payment_term_entitlements AS covering
          WHERE covering.tenant_id = p_tenant_id
            AND covering.legal_entity_id = p_legal_entity_id
            AND covering.customer_profile_id = v_profile_id
            AND covering.payment_term_resource_id = existing.payment_term_resource_id
            AND covering.lifecycle IN ('ACTIVE', 'ENDED')
            AND covering.effective_from <= existing.effective_from
            AND (covering.effective_to IS NULL OR existing.effective_to <= covering.effective_to)
        )
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_desired->'preferences') AS desired
      WHERE desired->'paymentTermRef'->>'resourceId' = existing.payment_term_resource_id
        AND (desired->>'effectiveFrom')::timestamptz = existing.effective_from
    );
  FOR v_preference IN SELECT value FROM jsonb_array_elements(v_desired->'preferences') LOOP
    UPDATE commerce_customer_context.customer_payment_term_preferences AS existing
    SET effective_to = nullif(v_preference->>'effectiveTo', '')::timestamptz,
        lifecycle = CASE WHEN v_preference ? 'effectiveTo' THEN 'ENDED' ELSE 'ACTIVE' END,
        revision = v_desired_revision, action_invocation_id = v_action_invocation_id,
        actor_principal_id = v_principal_id, reason = v_reason, recorded_at = now()
    WHERE existing.tenant_id = p_tenant_id
      AND existing.legal_entity_id = p_legal_entity_id
      AND existing.customer_profile_id = v_profile_id
      AND existing.lifecycle IN ('ACTIVE', 'ENDED')
      AND existing.payment_term_resource_id = v_preference->'paymentTermRef'->>'resourceId'
      AND existing.effective_from = (v_preference->>'effectiveFrom')::timestamptz
      AND (
        existing.effective_to IS DISTINCT FROM nullif(v_preference->>'effectiveTo', '')::timestamptz
        OR existing.lifecycle IS DISTINCT FROM (
          CASE WHEN v_preference ? 'effectiveTo' THEN 'ENDED' ELSE 'ACTIVE' END
        )
      );
    IF NOT FOUND AND NOT EXISTS (
      SELECT 1
      FROM commerce_customer_context.customer_payment_term_preferences AS existing
      WHERE existing.tenant_id = p_tenant_id
        AND existing.legal_entity_id = p_legal_entity_id
        AND existing.customer_profile_id = v_profile_id
        AND existing.lifecycle IN ('ACTIVE', 'ENDED')
        AND existing.payment_term_resource_id = v_preference->'paymentTermRef'->>'resourceId'
        AND existing.effective_from = (v_preference->>'effectiveFrom')::timestamptz
    ) THEN
      INSERT INTO commerce_customer_context.customer_payment_term_preferences (
        tenant_id, legal_entity_id, customer_profile_id, payment_term_resource_id,
        effective_from, effective_to, lifecycle, revision, action_invocation_id,
        actor_principal_id, reason
      ) VALUES (
        p_tenant_id, p_legal_entity_id, v_profile_id,
        v_preference->'paymentTermRef'->>'resourceId',
        (v_preference->>'effectiveFrom')::timestamptz,
        nullif(v_preference->>'effectiveTo', '')::timestamptz,
        CASE WHEN v_preference ? 'effectiveTo' THEN 'ENDED' ELSE 'ACTIVE' END,
        v_desired_revision, v_action_invocation_id, v_principal_id, v_reason
      );
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM commerce_customer_context.customer_payment_term_preferences AS preference
    WHERE preference.tenant_id = p_tenant_id
      AND preference.legal_entity_id = p_legal_entity_id
      AND preference.customer_profile_id = v_profile_id
      AND preference.lifecycle IN ('ACTIVE', 'ENDED')
      AND NOT EXISTS (
        SELECT 1
        FROM commerce_customer_context.customer_payment_term_entitlements AS entitlement
        WHERE entitlement.tenant_id = p_tenant_id
          AND entitlement.legal_entity_id = p_legal_entity_id
          AND entitlement.customer_profile_id = v_profile_id
          AND entitlement.payment_term_resource_id = preference.payment_term_resource_id
          AND entitlement.lifecycle IN ('ACTIVE', 'ENDED')
          AND entitlement.effective_from <= preference.effective_from
          AND (entitlement.effective_to IS NULL OR (
            preference.effective_to IS NOT NULL
            AND preference.effective_to <= entitlement.effective_to
          ))
      )
  ) THEN
    RAISE EXCEPTION 'payment term preference is not covered by an entitlement' USING ERRCODE = '23514';
  END IF;

  UPDATE commerce_customer_context.customer_setting_revisions
  SET current_revision = v_desired_revision,
      last_action_invocation_id = v_action_invocation_id,
      updated_at = now()
  WHERE tenant_id = p_tenant_id
    AND legal_entity_id = p_legal_entity_id
    AND customer_profile_id = v_profile_id
    AND setting_kind = 'PAYMENT_TERMS';
  RETURN QUERY SELECT
    'APPLIED'::text,
    v_desired_revision,
    commerce_customer_context.customer_payment_terms_state_json(
      p_tenant_id, p_legal_entity_id, v_profile_id, v_profile_kind
    );
END;
$$;
