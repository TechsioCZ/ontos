CREATE FUNCTION "commerce_customer_context"."read_purchase_limit_policies"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_counterparty_resource_id text,
  p_principal_id uuid
)
RETURNS TABLE (
  outcome text,
  source text,
  policy_id uuid,
  policy_kind text,
  amount numeric,
  currency_code text,
  revision integer,
  recorded_at timestamptz,
  source_revision text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
SET row_security = on
AS $purchase_limit_read$
DECLARE
  v_profile_id uuid;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'verified operation scope does not match routine scope'
      USING ERRCODE = '42501';
  END IF;

  IF p_counterparty_resource_id IS NULL
    OR p_counterparty_resource_id <> btrim(p_counterparty_resource_id)
    OR length(p_counterparty_resource_id) = 0
    OR p_principal_id IS NULL
  THEN
    RAISE EXCEPTION 'invalid purchase limit read subject' USING ERRCODE = '22023';
  END IF;

  SELECT profile.counterparty_purchasing_profile_id
    INTO v_profile_id
  FROM "commerce_customer_context"."counterparty_purchasing_profiles" AS profile
  WHERE profile.tenant_id = p_tenant_id
    AND profile.legal_entity_id = p_legal_entity_id
    AND profile.counterparty_resource_id = p_counterparty_resource_id;

  IF v_profile_id IS NULL THEN
    outcome := 'PROFILE_NOT_FOUND';
    source := NULL;
    policy_id := NULL;
    policy_kind := NULL;
    amount := NULL;
    currency_code := NULL;
    revision := NULL;
    recorded_at := NULL;
    source_revision := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  RETURN QUERY
    SELECT
      'PRESENT'::text,
      'COUNTERPARTY_DEFAULT'::text,
      policy.counterparty_purchase_limit_default_id,
      policy.policy_kind,
      policy.amount,
      policy.currency_code,
      policy.revision,
      policy.recorded_at,
      ('counterparty-policy:' || policy.revision::text)::text
    FROM "commerce_customer_context"."counterparty_purchase_limit_defaults" AS policy
    WHERE policy.tenant_id = p_tenant_id
      AND policy.legal_entity_id = p_legal_entity_id
      AND policy.counterparty_purchasing_profile_id = v_profile_id
      AND policy.is_current
    UNION ALL
    SELECT
      'PRESENT'::text,
      'PRINCIPAL_OVERRIDE'::text,
      policy.principal_purchase_limit_override_id,
      policy.policy_kind,
      policy.amount,
      policy.currency_code,
      policy.revision,
      policy.recorded_at,
      ('principal-override:' || policy.revision::text)::text
    FROM "commerce_customer_context"."principal_purchase_limit_overrides" AS policy
    WHERE policy.tenant_id = p_tenant_id
      AND policy.legal_entity_id = p_legal_entity_id
      AND policy.counterparty_purchasing_profile_id = v_profile_id
      AND policy.principal_id = p_principal_id
      AND policy.is_current
    ORDER BY 2;
END;
$purchase_limit_read$;
--> statement-breakpoint
CREATE FUNCTION "commerce_customer_context"."change_purchase_limit_policy"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_counterparty_resource_id text,
  p_principal_id uuid,
  p_expected_revision integer,
  p_change_kind text,
  p_policy_kind text,
  p_amount numeric,
  p_currency_code text,
  p_reason text,
  p_actor_principal_id uuid,
  p_action_invocation_id uuid
)
RETURNS TABLE (
  outcome text,
  current_policy_id uuid,
  current_policy_kind text,
  current_amount numeric,
  current_currency_code text,
  current_revision integer,
  current_recorded_at timestamptz,
  previous_policy_id uuid,
  previous_policy_kind text,
  previous_amount numeric,
  previous_currency_code text,
  previous_revision integer,
  previous_recorded_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
SET row_security = on
AS $purchase_limit_change$
DECLARE
  v_profile_id uuid;
  v_current record;
  v_prior record;
  v_replay record;
  v_inserted record;
  v_next_revision integer;
  v_logical_revision integer;
  v_now timestamptz := clock_timestamp();
  v_replay_matches boolean;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'verified operation scope does not match routine scope'
      USING ERRCODE = '42501';
  END IF;

  IF p_counterparty_resource_id IS NULL
    OR p_counterparty_resource_id <> btrim(p_counterparty_resource_id)
    OR length(p_counterparty_resource_id) = 0
    OR p_actor_principal_id IS NULL
    OR p_action_invocation_id IS NULL
    OR p_reason IS NULL
    OR p_reason <> btrim(p_reason)
    OR length(p_reason) = 0
    OR p_expected_revision < 1
    OR p_change_kind NOT IN ('SET', 'CLEAR')
    OR (
      p_change_kind = 'CLEAR'
      AND (p_policy_kind IS NOT NULL OR p_amount IS NOT NULL OR p_currency_code IS NOT NULL)
    )
    OR (
      p_change_kind = 'SET'
      AND NOT (
        (p_policy_kind = 'UNLIMITED' AND p_amount IS NULL AND p_currency_code IS NULL)
        OR
        (p_policy_kind = 'MONETARY_LIMIT' AND p_amount IS NOT NULL AND p_amount >= 0 AND p_currency_code ~ '^[A-Z]{3}$')
      )
    )
  THEN
    RAISE EXCEPTION 'invalid purchase limit mutation' USING ERRCODE = '22023';
  END IF;

  -- The profile row is the exact Counterparty/Selling-LE serialization anchor. It makes
  -- same-subject CAS decisions deterministic and prevents interleaved default/override races.
  SELECT profile.counterparty_purchasing_profile_id
    INTO v_profile_id
  FROM "commerce_customer_context"."counterparty_purchasing_profiles" AS profile
  WHERE profile.tenant_id = p_tenant_id
    AND profile.legal_entity_id = p_legal_entity_id
    AND profile.counterparty_resource_id = p_counterparty_resource_id
  FOR UPDATE;

  IF v_profile_id IS NULL THEN
    outcome := 'PROFILE_NOT_FOUND';
    RETURN NEXT;
    RETURN;
  END IF;

  IF p_principal_id IS NULL THEN
    SELECT policy.* INTO v_current
    FROM "commerce_customer_context"."counterparty_purchase_limit_defaults" AS policy
    WHERE policy.tenant_id = p_tenant_id
      AND policy.legal_entity_id = p_legal_entity_id
      AND policy.counterparty_purchasing_profile_id = v_profile_id
      AND policy.is_current
    FOR UPDATE;

    SELECT policy.* INTO v_replay
    FROM "commerce_customer_context"."counterparty_purchase_limit_defaults" AS policy
    WHERE policy.tenant_id = p_tenant_id
      AND policy.legal_entity_id = p_legal_entity_id
      AND policy.counterparty_purchasing_profile_id = v_profile_id
      AND policy.action_invocation_id = p_action_invocation_id
    ORDER BY policy.revision DESC
    LIMIT 1;

    IF v_replay.counterparty_purchase_limit_default_id IS NOT NULL THEN
      v_replay_matches :=
        (p_change_kind = 'CLEAR' AND v_replay.policy_kind = 'CLEARED')
        OR
        (p_change_kind = 'SET' AND v_replay.policy_kind = p_policy_kind
          AND v_replay.amount IS NOT DISTINCT FROM p_amount
          AND v_replay.currency_code IS NOT DISTINCT FROM p_currency_code);
      IF NOT v_replay_matches THEN
        outcome := 'REVISION_CONFLICT';
        IF v_current.counterparty_purchase_limit_default_id IS NOT NULL AND v_current.policy_kind <> 'CLEARED' THEN
          current_policy_id := v_current.counterparty_purchase_limit_default_id;
          current_policy_kind := v_current.policy_kind;
          current_amount := v_current.amount;
          current_currency_code := v_current.currency_code;
          current_revision := v_current.revision;
          current_recorded_at := v_current.recorded_at;
        END IF;
        RETURN NEXT;
        RETURN;
      END IF;

      outcome := 'APPLIED';
      SELECT policy.* INTO v_prior
      FROM "commerce_customer_context"."counterparty_purchase_limit_defaults" AS policy
      WHERE policy.tenant_id = p_tenant_id
        AND policy.legal_entity_id = p_legal_entity_id
        AND policy.counterparty_purchasing_profile_id = v_profile_id
        AND policy.revision < v_replay.revision
      ORDER BY policy.revision DESC
      LIMIT 1;

      IF v_replay.policy_kind <> 'CLEARED' THEN
        current_policy_id := v_replay.counterparty_purchase_limit_default_id;
        current_policy_kind := v_replay.policy_kind;
        current_amount := v_replay.amount;
        current_currency_code := v_replay.currency_code;
        current_revision := v_replay.revision;
        current_recorded_at := v_replay.recorded_at;
      END IF;
      IF v_prior.counterparty_purchase_limit_default_id IS NOT NULL AND v_prior.policy_kind <> 'CLEARED' THEN
        previous_policy_id := v_prior.counterparty_purchase_limit_default_id;
        previous_policy_kind := v_prior.policy_kind;
        previous_amount := v_prior.amount;
        previous_currency_code := v_prior.currency_code;
        previous_revision := v_prior.revision;
        previous_recorded_at := v_prior.recorded_at;
      END IF;
      RETURN NEXT;
      RETURN;
    END IF;

    IF (p_change_kind = 'CLEAR' AND (v_current.counterparty_purchase_limit_default_id IS NULL OR v_current.policy_kind = 'CLEARED'))
      OR
      (p_change_kind = 'SET' AND v_current.policy_kind = p_policy_kind
        AND v_current.amount IS NOT DISTINCT FROM p_amount
        AND v_current.currency_code IS NOT DISTINCT FROM p_currency_code)
    THEN
      outcome := 'UNCHANGED';
      IF v_current.counterparty_purchase_limit_default_id IS NOT NULL AND v_current.policy_kind <> 'CLEARED' THEN
        current_policy_id := v_current.counterparty_purchase_limit_default_id;
        current_policy_kind := v_current.policy_kind;
        current_amount := v_current.amount;
        current_currency_code := v_current.currency_code;
        current_revision := v_current.revision;
        current_recorded_at := v_current.recorded_at;
        previous_policy_id := current_policy_id;
        previous_policy_kind := current_policy_kind;
        previous_amount := current_amount;
        previous_currency_code := current_currency_code;
        previous_revision := current_revision;
        previous_recorded_at := current_recorded_at;
      END IF;
      RETURN NEXT;
      RETURN;
    END IF;

    v_logical_revision := CASE WHEN v_current.policy_kind <> 'CLEARED' THEN v_current.revision ELSE NULL END;
    IF p_expected_revision IS DISTINCT FROM v_logical_revision THEN
      outcome := 'REVISION_CONFLICT';
      IF v_current.counterparty_purchase_limit_default_id IS NOT NULL AND v_current.policy_kind <> 'CLEARED' THEN
        current_policy_id := v_current.counterparty_purchase_limit_default_id;
        current_policy_kind := v_current.policy_kind;
        current_amount := v_current.amount;
        current_currency_code := v_current.currency_code;
        current_revision := v_current.revision;
        current_recorded_at := v_current.recorded_at;
      END IF;
      RETURN NEXT;
      RETURN;
    END IF;

    SELECT coalesce(max(policy.revision), 0) + 1 INTO v_next_revision
    FROM "commerce_customer_context"."counterparty_purchase_limit_defaults" AS policy
    WHERE policy.tenant_id = p_tenant_id
      AND policy.legal_entity_id = p_legal_entity_id
      AND policy.counterparty_purchasing_profile_id = v_profile_id;

    UPDATE "commerce_customer_context"."counterparty_purchase_limit_defaults" AS policy
    SET is_current = false, superseded_at = v_now
    WHERE policy.tenant_id = p_tenant_id
      AND policy.legal_entity_id = p_legal_entity_id
      AND policy.counterparty_purchasing_profile_id = v_profile_id
      AND policy.is_current;

    INSERT INTO "commerce_customer_context"."counterparty_purchase_limit_defaults" (
      tenant_id, legal_entity_id, counterparty_purchasing_profile_id,
      policy_kind, amount, currency_code, revision, is_current, superseded_at,
      action_invocation_id, actor_principal_id, reason, recorded_at
    ) VALUES (
      p_tenant_id, p_legal_entity_id, v_profile_id,
      CASE WHEN p_change_kind = 'CLEAR' THEN 'CLEARED' ELSE p_policy_kind END,
      CASE WHEN p_change_kind = 'CLEAR' THEN NULL ELSE p_amount END,
      CASE WHEN p_change_kind = 'CLEAR' THEN NULL ELSE p_currency_code END,
      v_next_revision, true, NULL,
      p_action_invocation_id, p_actor_principal_id, p_reason, v_now
    ) RETURNING * INTO v_inserted;

    outcome := 'APPLIED';
    IF v_inserted.policy_kind <> 'CLEARED' THEN
      current_policy_id := v_inserted.counterparty_purchase_limit_default_id;
      current_policy_kind := v_inserted.policy_kind;
      current_amount := v_inserted.amount;
      current_currency_code := v_inserted.currency_code;
      current_revision := v_inserted.revision;
      current_recorded_at := v_inserted.recorded_at;
    END IF;
    IF v_current.counterparty_purchase_limit_default_id IS NOT NULL AND v_current.policy_kind <> 'CLEARED' THEN
      previous_policy_id := v_current.counterparty_purchase_limit_default_id;
      previous_policy_kind := v_current.policy_kind;
      previous_amount := v_current.amount;
      previous_currency_code := v_current.currency_code;
      previous_revision := v_current.revision;
      previous_recorded_at := v_current.recorded_at;
    END IF;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT policy.* INTO v_current
  FROM "commerce_customer_context"."principal_purchase_limit_overrides" AS policy
  WHERE policy.tenant_id = p_tenant_id
    AND policy.legal_entity_id = p_legal_entity_id
    AND policy.counterparty_purchasing_profile_id = v_profile_id
    AND policy.principal_id = p_principal_id
    AND policy.is_current
  FOR UPDATE;

  SELECT policy.* INTO v_replay
  FROM "commerce_customer_context"."principal_purchase_limit_overrides" AS policy
  WHERE policy.tenant_id = p_tenant_id
    AND policy.legal_entity_id = p_legal_entity_id
    AND policy.counterparty_purchasing_profile_id = v_profile_id
    AND policy.principal_id = p_principal_id
    AND policy.action_invocation_id = p_action_invocation_id
  ORDER BY policy.revision DESC
  LIMIT 1;

  IF v_replay.principal_purchase_limit_override_id IS NOT NULL THEN
    v_replay_matches :=
      (p_change_kind = 'CLEAR' AND v_replay.policy_kind = 'CLEARED')
      OR
      (p_change_kind = 'SET' AND v_replay.policy_kind = p_policy_kind
        AND v_replay.amount IS NOT DISTINCT FROM p_amount
        AND v_replay.currency_code IS NOT DISTINCT FROM p_currency_code);
    IF NOT v_replay_matches THEN
      outcome := 'REVISION_CONFLICT';
      IF v_current.principal_purchase_limit_override_id IS NOT NULL AND v_current.policy_kind <> 'CLEARED' THEN
        current_policy_id := v_current.principal_purchase_limit_override_id;
        current_policy_kind := v_current.policy_kind;
        current_amount := v_current.amount;
        current_currency_code := v_current.currency_code;
        current_revision := v_current.revision;
        current_recorded_at := v_current.recorded_at;
      END IF;
      RETURN NEXT;
      RETURN;
    END IF;

    outcome := 'APPLIED';
    SELECT policy.* INTO v_prior
    FROM "commerce_customer_context"."principal_purchase_limit_overrides" AS policy
    WHERE policy.tenant_id = p_tenant_id
      AND policy.legal_entity_id = p_legal_entity_id
      AND policy.counterparty_purchasing_profile_id = v_profile_id
      AND policy.principal_id = p_principal_id
      AND policy.revision < v_replay.revision
    ORDER BY policy.revision DESC
    LIMIT 1;

    IF v_replay.policy_kind <> 'CLEARED' THEN
      current_policy_id := v_replay.principal_purchase_limit_override_id;
      current_policy_kind := v_replay.policy_kind;
      current_amount := v_replay.amount;
      current_currency_code := v_replay.currency_code;
      current_revision := v_replay.revision;
      current_recorded_at := v_replay.recorded_at;
    END IF;
    IF v_prior.principal_purchase_limit_override_id IS NOT NULL AND v_prior.policy_kind <> 'CLEARED' THEN
      previous_policy_id := v_prior.principal_purchase_limit_override_id;
      previous_policy_kind := v_prior.policy_kind;
      previous_amount := v_prior.amount;
      previous_currency_code := v_prior.currency_code;
      previous_revision := v_prior.revision;
      previous_recorded_at := v_prior.recorded_at;
    END IF;
    RETURN NEXT;
    RETURN;
  END IF;

  IF (p_change_kind = 'CLEAR' AND (v_current.principal_purchase_limit_override_id IS NULL OR v_current.policy_kind = 'CLEARED'))
    OR
    (p_change_kind = 'SET' AND v_current.policy_kind = p_policy_kind
      AND v_current.amount IS NOT DISTINCT FROM p_amount
      AND v_current.currency_code IS NOT DISTINCT FROM p_currency_code)
  THEN
    outcome := 'UNCHANGED';
    IF v_current.principal_purchase_limit_override_id IS NOT NULL AND v_current.policy_kind <> 'CLEARED' THEN
      current_policy_id := v_current.principal_purchase_limit_override_id;
      current_policy_kind := v_current.policy_kind;
      current_amount := v_current.amount;
      current_currency_code := v_current.currency_code;
      current_revision := v_current.revision;
      current_recorded_at := v_current.recorded_at;
      previous_policy_id := current_policy_id;
      previous_policy_kind := current_policy_kind;
      previous_amount := current_amount;
      previous_currency_code := current_currency_code;
      previous_revision := current_revision;
      previous_recorded_at := current_recorded_at;
    END IF;
    RETURN NEXT;
    RETURN;
  END IF;

  v_logical_revision := CASE WHEN v_current.policy_kind <> 'CLEARED' THEN v_current.revision ELSE NULL END;
  IF p_expected_revision IS DISTINCT FROM v_logical_revision THEN
    outcome := 'REVISION_CONFLICT';
    IF v_current.principal_purchase_limit_override_id IS NOT NULL AND v_current.policy_kind <> 'CLEARED' THEN
      current_policy_id := v_current.principal_purchase_limit_override_id;
      current_policy_kind := v_current.policy_kind;
      current_amount := v_current.amount;
      current_currency_code := v_current.currency_code;
      current_revision := v_current.revision;
      current_recorded_at := v_current.recorded_at;
    END IF;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT coalesce(max(policy.revision), 0) + 1 INTO v_next_revision
  FROM "commerce_customer_context"."principal_purchase_limit_overrides" AS policy
  WHERE policy.tenant_id = p_tenant_id
    AND policy.legal_entity_id = p_legal_entity_id
    AND policy.counterparty_purchasing_profile_id = v_profile_id
    AND policy.principal_id = p_principal_id;

  UPDATE "commerce_customer_context"."principal_purchase_limit_overrides" AS policy
  SET is_current = false, superseded_at = v_now
  WHERE policy.tenant_id = p_tenant_id
    AND policy.legal_entity_id = p_legal_entity_id
    AND policy.counterparty_purchasing_profile_id = v_profile_id
    AND policy.principal_id = p_principal_id
    AND policy.is_current;

  INSERT INTO "commerce_customer_context"."principal_purchase_limit_overrides" (
    tenant_id, legal_entity_id, counterparty_purchasing_profile_id, principal_id,
    policy_kind, amount, currency_code, revision, is_current, superseded_at,
    action_invocation_id, actor_principal_id, reason, recorded_at
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_profile_id, p_principal_id,
    CASE WHEN p_change_kind = 'CLEAR' THEN 'CLEARED' ELSE p_policy_kind END,
    CASE WHEN p_change_kind = 'CLEAR' THEN NULL ELSE p_amount END,
    CASE WHEN p_change_kind = 'CLEAR' THEN NULL ELSE p_currency_code END,
    v_next_revision, true, NULL,
    p_action_invocation_id, p_actor_principal_id, p_reason, v_now
  ) RETURNING * INTO v_inserted;

  outcome := 'APPLIED';
  IF v_inserted.policy_kind <> 'CLEARED' THEN
    current_policy_id := v_inserted.principal_purchase_limit_override_id;
    current_policy_kind := v_inserted.policy_kind;
    current_amount := v_inserted.amount;
    current_currency_code := v_inserted.currency_code;
    current_revision := v_inserted.revision;
    current_recorded_at := v_inserted.recorded_at;
  END IF;
  IF v_current.principal_purchase_limit_override_id IS NOT NULL AND v_current.policy_kind <> 'CLEARED' THEN
    previous_policy_id := v_current.principal_purchase_limit_override_id;
    previous_policy_kind := v_current.policy_kind;
    previous_amount := v_current.amount;
    previous_currency_code := v_current.currency_code;
    previous_revision := v_current.revision;
    previous_recorded_at := v_current.recorded_at;
  END IF;
  RETURN NEXT;
END;
$purchase_limit_change$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."read_purchase_limit_policies"(uuid, uuid, text, uuid) FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."change_purchase_limit_policy"(uuid, uuid, text, uuid, integer, text, text, numeric, text, text, uuid, uuid) FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_purchase_limit_policies"(uuid, uuid, text, uuid) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."change_purchase_limit_policy"(uuid, uuid, text, uuid, integer, text, text, numeric, text, text, uuid, uuid) TO "ontos_runtime";
