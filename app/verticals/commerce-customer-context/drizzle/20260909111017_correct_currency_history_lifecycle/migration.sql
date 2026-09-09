ALTER TABLE "commerce_customer_context"."customer_currency_preferences" DROP CONSTRAINT "ccc_currency_preferences_code_ck", ADD CONSTRAINT "ccc_currency_preferences_code_ck" CHECK (("lifecycle" in ('ACTIVE', 'ENDED') and "currency_code" ~ '^[A-Z]{3}$') or ("lifecycle" = 'CLEARED' and "currency_code" is null));
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."read_currency_preference"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_profile_resource_id text,
  p_profile_kind text,
  p_counterparty_resource_id text
)
RETURNS TABLE (
  outcome text,
  revision integer,
  currency_code text,
  preference_id text,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $$
DECLARE
  v_profile_id uuid;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Commerce Customer Context routine scope mismatch' USING ERRCODE = '42501';
  END IF;

  SELECT profile.customer_profile_id
  INTO v_profile_id
  FROM commerce_customer_context.customer_profiles AS profile
  WHERE profile.tenant_id = p_tenant_id
    AND profile.legal_entity_id = p_legal_entity_id
    AND profile.customer_profile_id::text = p_profile_resource_id
    AND profile.profile_kind = p_profile_kind;

  IF v_profile_id IS NULL THEN
    RETURN QUERY SELECT 'PROFILE_NOT_FOUND'::text, 0, NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  IF (p_profile_kind = 'RETAIL' AND p_counterparty_resource_id IS NOT NULL)
    OR (p_profile_kind = 'COUNTERPARTY' AND NOT EXISTS (
      SELECT 1
      FROM commerce_customer_context.counterparty_purchasing_profiles AS counterparty_profile
      WHERE counterparty_profile.tenant_id = p_tenant_id
        AND counterparty_profile.legal_entity_id = p_legal_entity_id
        AND counterparty_profile.counterparty_purchasing_profile_id = v_profile_id
        AND counterparty_profile.counterparty_resource_id = p_counterparty_resource_id
    ))
  THEN
    RETURN QUERY SELECT 'SUBJECT_MISMATCH'::text, 0, NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    CASE WHEN preference.lifecycle = 'ACTIVE' THEN 'PRESENT' ELSE 'ABSENT' END,
    coalesce(setting.current_revision, preference.revision, 0),
    CASE WHEN preference.lifecycle = 'ACTIVE' THEN preference.currency_code ELSE NULL END,
    CASE WHEN preference.lifecycle = 'ACTIVE' THEN preference.customer_currency_preference_id::text ELSE NULL END,
    CASE WHEN preference.lifecycle = 'ACTIVE' THEN preference.effective_from ELSE NULL END,
    CASE WHEN preference.lifecycle = 'ACTIVE' THEN preference.recorded_at ELSE NULL END
  FROM (SELECT v_profile_id AS customer_profile_id) AS target
  LEFT JOIN commerce_customer_context.customer_setting_revisions AS setting
    ON setting.tenant_id = p_tenant_id
   AND setting.legal_entity_id = p_legal_entity_id
   AND setting.customer_profile_id = target.customer_profile_id
   AND setting.setting_kind = 'CURRENCY'
  LEFT JOIN LATERAL (
    SELECT candidate.*
    FROM commerce_customer_context.customer_currency_preferences AS candidate
    WHERE candidate.tenant_id = p_tenant_id
      AND candidate.legal_entity_id = p_legal_entity_id
      AND candidate.customer_profile_id = target.customer_profile_id
      AND candidate.effective_to IS NULL
      AND candidate.lifecycle IN ('ACTIVE', 'CLEARED')
    ORDER BY candidate.revision DESC
    LIMIT 1
  ) AS preference ON true;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."change_currency_preference"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_profile_resource_id text,
  p_profile_kind text,
  p_counterparty_resource_id text,
  p_expected_revision integer,
  p_change_kind text,
  p_currency_code text,
  p_recognized_currency_codes text[],
  p_actor_principal_id uuid,
  p_action_invocation_id uuid
)
RETURNS TABLE (
  outcome text,
  revision integer,
  currency_code text,
  previous_currency_code text,
  preference_id text,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $$
DECLARE
  v_profile_id uuid;
  v_profile_kind text;
  v_current commerce_customer_context.customer_currency_preferences%ROWTYPE;
  v_current_revision integer := 0;
  v_next_revision integer;
  v_now timestamptz := clock_timestamp();
  v_preference_id uuid;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Commerce Customer Context routine scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_change_kind NOT IN ('SET', 'CLEAR') OR p_expected_revision < 0 THEN
    RAISE EXCEPTION 'Invalid Currency Preference command' USING ERRCODE = '22023';
  END IF;

  SELECT profile.customer_profile_id, profile.profile_kind
  INTO v_profile_id, v_profile_kind
  FROM commerce_customer_context.customer_profiles AS profile
  WHERE profile.tenant_id = p_tenant_id
    AND profile.legal_entity_id = p_legal_entity_id
    AND profile.customer_profile_id::text = p_profile_resource_id
    AND profile.profile_kind = p_profile_kind
  FOR UPDATE;

  IF v_profile_id IS NULL THEN
    RETURN QUERY SELECT 'PROFILE_NOT_FOUND'::text, 0, NULL::text, NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  IF (v_profile_kind = 'RETAIL' AND p_counterparty_resource_id IS NOT NULL)
    OR (v_profile_kind = 'COUNTERPARTY' AND NOT EXISTS (
      SELECT 1
      FROM commerce_customer_context.counterparty_purchasing_profiles AS counterparty_profile
      WHERE counterparty_profile.tenant_id = p_tenant_id
        AND counterparty_profile.legal_entity_id = p_legal_entity_id
        AND counterparty_profile.counterparty_purchasing_profile_id = v_profile_id
        AND counterparty_profile.counterparty_resource_id = p_counterparty_resource_id
    ))
  THEN
    RETURN QUERY SELECT 'SUBJECT_MISMATCH'::text, 0, NULL::text, NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT coalesce((
    SELECT setting.current_revision
    FROM commerce_customer_context.customer_setting_revisions AS setting
    WHERE setting.tenant_id = p_tenant_id
      AND setting.legal_entity_id = p_legal_entity_id
      AND setting.customer_profile_id = v_profile_id
      AND setting.setting_kind = 'CURRENCY'
  ), 0)
  INTO v_current_revision
  ;

  SELECT preference.*
  INTO v_current
  FROM commerce_customer_context.customer_currency_preferences AS preference
  WHERE preference.tenant_id = p_tenant_id
    AND preference.legal_entity_id = p_legal_entity_id
    AND preference.customer_profile_id = v_profile_id
    AND preference.effective_to IS NULL
    AND preference.lifecycle IN ('ACTIVE', 'CLEARED')
  ORDER BY preference.revision DESC
  LIMIT 1;

  IF v_current_revision = 0 AND v_current.revision IS NOT NULL THEN
    v_current_revision := v_current.revision;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM commerce_customer_context.profile_reconciliation_case_members AS member
    JOIN commerce_customer_context.profile_reconciliation_cases AS reconciliation
      ON reconciliation.tenant_id = member.tenant_id
      AND reconciliation.legal_entity_id = member.legal_entity_id
      AND reconciliation.profile_reconciliation_case_id = member.profile_reconciliation_case_id
    WHERE member.tenant_id = p_tenant_id
      AND member.legal_entity_id = p_legal_entity_id
      AND member.customer_profile_id = v_profile_id
      AND reconciliation.lifecycle <> 'COMPLETED'
  ) THEN
    RETURN QUERY SELECT 'RECONCILIATION_REQUIRED'::text, v_current_revision, NULL::text, NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  IF p_change_kind = 'SET' AND v_current.lifecycle = 'ACTIVE' AND v_current.currency_code = p_currency_code THEN
    RETURN QUERY SELECT 'UNCHANGED'::text, v_current_revision, v_current.currency_code, v_current.currency_code, v_current.customer_currency_preference_id::text, v_current.effective_from, v_current.recorded_at;
    RETURN;
  END IF;
  IF p_change_kind = 'CLEAR' AND (v_current.customer_currency_preference_id IS NULL OR v_current.lifecycle = 'CLEARED') THEN
    RETURN QUERY SELECT 'UNCHANGED'::text, v_current_revision, NULL::text, NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;
  IF p_expected_revision <> v_current_revision THEN
    RETURN QUERY SELECT 'REVISION_CONFLICT'::text, v_current_revision, NULL::text, NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;
  IF p_change_kind = 'SET' AND NOT (p_currency_code = ANY(p_recognized_currency_codes)) THEN
    RETURN QUERY SELECT 'CURRENCY_UNRECOGNIZED'::text, v_current_revision, p_currency_code, NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  IF v_current.customer_currency_preference_id IS NOT NULL THEN
    v_now := greatest(v_now, v_current.effective_from + interval '1 microsecond');
    UPDATE commerce_customer_context.customer_currency_preferences
    SET effective_to = v_now,
        lifecycle = CASE WHEN lifecycle = 'ACTIVE' THEN 'ENDED' ELSE lifecycle END
    WHERE customer_currency_preference_id = v_current.customer_currency_preference_id;
  END IF;

  v_next_revision := v_current_revision + 1;
  v_preference_id := gen_random_uuid();
  INSERT INTO commerce_customer_context.customer_currency_preferences (
    customer_currency_preference_id, tenant_id, legal_entity_id, customer_profile_id,
    currency_code, effective_from, lifecycle, revision, action_invocation_id,
    actor_principal_id, recorded_at
  ) VALUES (
    v_preference_id, p_tenant_id, p_legal_entity_id, v_profile_id,
    CASE WHEN p_change_kind = 'SET' THEN p_currency_code ELSE NULL END,
    v_now, CASE WHEN p_change_kind = 'SET' THEN 'ACTIVE' ELSE 'CLEARED' END,
    v_next_revision, p_action_invocation_id, p_actor_principal_id, v_now
  );
  INSERT INTO commerce_customer_context.customer_setting_revisions (
    tenant_id, legal_entity_id, customer_profile_id, setting_kind, current_revision,
    last_action_invocation_id, updated_at
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_profile_id, 'CURRENCY', v_next_revision,
    p_action_invocation_id, v_now
  )
  ON CONFLICT (tenant_id, legal_entity_id, customer_profile_id, setting_kind)
  DO UPDATE SET current_revision = excluded.current_revision,
                last_action_invocation_id = excluded.last_action_invocation_id,
                updated_at = excluded.updated_at;

  RETURN QUERY SELECT
    'APPLIED'::text,
    v_next_revision,
    CASE WHEN p_change_kind = 'SET' THEN p_currency_code ELSE NULL END,
    CASE WHEN v_current.lifecycle = 'ACTIVE' THEN v_current.currency_code ELSE NULL END,
    CASE WHEN p_change_kind = 'SET' THEN v_preference_id::text ELSE NULL END,
    CASE WHEN p_change_kind = 'SET' THEN v_now ELSE NULL END,
    CASE WHEN p_change_kind = 'SET' THEN v_now ELSE NULL END;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."read_currency_preference"(uuid, uuid, text, text, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."change_currency_preference"(uuid, uuid, text, text, text, integer, text, text, text[], uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_currency_preference"(uuid, uuid, text, text, text) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."change_currency_preference"(uuid, uuid, text, text, text, integer, text, text, text[], uuid, uuid) TO "ontos_runtime";
