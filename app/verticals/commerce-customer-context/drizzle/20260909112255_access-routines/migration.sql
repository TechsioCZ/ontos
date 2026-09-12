ALTER TABLE "commerce_customer_context"."counterparty_access_invitations"
  DROP CONSTRAINT "ccc_access_invitations_claim_ck";
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_access_invitations"
  ADD CONSTRAINT "ccc_access_invitations_claim_ck" CHECK (
    (lifecycle = 'CLAIMED' AND claimed_by_principal_id IS NOT NULL AND claimed_at IS NOT NULL)
    OR (lifecycle IN ('CLAIMING', 'RECONCILIATION_REQUIRED')
      AND claimed_by_principal_id IS NOT NULL AND claimed_at IS NULL)
    OR (lifecycle IN ('PENDING', 'EXPIRED')
      AND claimed_by_principal_id IS NULL AND claimed_at IS NULL)
    OR (lifecycle = 'REVOKED' AND claimed_at IS NULL)
  );
--> statement-breakpoint

CREATE FUNCTION "commerce_customer_context"."access_grant_row"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_grant_id uuid,
  p_operation_outcome text DEFAULT NULL
)
RETURNS TABLE (
  counterparty_resource_id text,
  grant_id uuid,
  granted_at timestamptz,
  granted_by uuid,
  operation_outcome text,
  permission_code text,
  principal_id uuid,
  reason text,
  revision integer,
  revoked_at timestamptz,
  revoked_by uuid,
  state text,
  storefront_resource_id text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $function$
  SELECT
    profile.counterparty_resource_id,
    grant_row.counterparty_commerce_access_grant_id,
    grant_row.recorded_at,
    grant_row.actor_principal_id,
    p_operation_outcome,
    grant_row.permission_code,
    grant_row.principal_id,
    grant_row.reason,
    grant_row.revision,
    grant_row.revoked_at,
    (
      SELECT journal.actor_principal_id
      FROM commerce_customer_context.access_mutation_journal AS journal
      WHERE journal.tenant_id = p_tenant_id
        AND journal.legal_entity_id = p_legal_entity_id
        AND journal.resource_id = grant_row.counterparty_commerce_access_grant_id
        AND journal.mutation_kind = 'REVOKE'
      ORDER BY journal.recorded_at DESC, journal.access_mutation_id DESC
      LIMIT 1
    ),
    grant_row.lifecycle,
    grant_row.storefront_resource_id
  FROM commerce_customer_context.counterparty_commerce_access_grants AS grant_row
  JOIN commerce_customer_context.counterparty_purchasing_profiles AS profile
    ON profile.tenant_id = grant_row.tenant_id
    AND profile.legal_entity_id = grant_row.legal_entity_id
    AND profile.counterparty_purchasing_profile_id = grant_row.counterparty_purchasing_profile_id
  WHERE grant_row.tenant_id = p_tenant_id
    AND grant_row.legal_entity_id = p_legal_entity_id
    AND grant_row.counterparty_commerce_access_grant_id = p_grant_id;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."access_grant_row"(uuid, uuid, uuid, text) FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint

CREATE FUNCTION "commerce_customer_context"."list_access_grants"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_counterparty_resource_id text,
  p_principal_id uuid
)
RETURNS TABLE (
  counterparty_resource_id text,
  grant_id uuid,
  granted_at timestamptz,
  granted_by uuid,
  operation_outcome text,
  permission_code text,
  principal_id uuid,
  reason text,
  revision integer,
  revoked_at timestamptz,
  revoked_by uuid,
  state text,
  storefront_resource_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $function$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified operation scope mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT projection.*
  FROM commerce_customer_context.counterparty_commerce_access_grants AS grant_row
  JOIN commerce_customer_context.counterparty_purchasing_profiles AS profile
    ON profile.tenant_id = grant_row.tenant_id
    AND profile.legal_entity_id = grant_row.legal_entity_id
    AND profile.counterparty_purchasing_profile_id = grant_row.counterparty_purchasing_profile_id
  CROSS JOIN LATERAL commerce_customer_context.access_grant_row(
    p_tenant_id, p_legal_entity_id, grant_row.counterparty_commerce_access_grant_id, NULL
  ) AS projection
  WHERE profile.tenant_id = p_tenant_id
    AND profile.legal_entity_id = p_legal_entity_id
    AND profile.counterparty_resource_id = p_counterparty_resource_id
    AND (p_principal_id IS NULL OR grant_row.principal_id = p_principal_id)
  ORDER BY grant_row.recorded_at, grant_row.counterparty_commerce_access_grant_id;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."list_access_grants"(uuid, uuid, text, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."list_access_grants"(uuid, uuid, text, uuid) TO "ontos_runtime";
--> statement-breakpoint

CREATE FUNCTION "commerce_customer_context"."begin_access_grant"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_counterparty_resource_id text,
  p_principal_id uuid,
  p_permission_code text,
  p_storefront_resource_id text,
  p_actor_principal_id uuid,
  p_action_invocation_id uuid,
  p_reason text,
  p_bootstrap boolean
)
RETURNS TABLE (
  counterparty_resource_id text, grant_id uuid, granted_at timestamptz, granted_by uuid,
  operation_outcome text, permission_code text, principal_id uuid, reason text,
  revision integer, revoked_at timestamptz, revoked_by uuid, state text,
  storefront_resource_id text, action_invocation_id uuid, mutation_id uuid,
  mutation_operation text, mutation_staged boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $function$
DECLARE
  v_profile_id uuid;
  v_grant_id uuid;
  v_state text;
  v_latest_mutation text;
  v_mutation_id uuid;
  v_mutation_staged boolean := false;
  v_outcome text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified operation scope mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT profile.counterparty_purchasing_profile_id INTO v_profile_id
  FROM commerce_customer_context.counterparty_purchasing_profiles AS profile
  WHERE profile.tenant_id = p_tenant_id
    AND profile.legal_entity_id = p_legal_entity_id
    AND profile.counterparty_resource_id = p_counterparty_resource_id
  FOR UPDATE;
  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION 'counterparty profile is unavailable in scope' USING ERRCODE = 'P0002';
  END IF;

  IF p_bootstrap AND EXISTS (
    SELECT 1 FROM commerce_customer_context.counterparty_commerce_access_grants AS administrator
    WHERE administrator.tenant_id = p_tenant_id
      AND administrator.legal_entity_id = p_legal_entity_id
      AND administrator.counterparty_purchasing_profile_id = v_profile_id
      AND administrator.permission_code = 'counterparty.access.manage'
      AND administrator.lifecycle IN ('PENDING_GRANT', 'ACTIVE', 'PENDING_REVOKE', 'RECONCILIATION_REQUIRED')
      AND administrator.principal_id <> p_principal_id
  ) THEN
    SELECT administrator.counterparty_commerce_access_grant_id INTO v_grant_id
    FROM commerce_customer_context.counterparty_commerce_access_grants AS administrator
    WHERE administrator.tenant_id = p_tenant_id
      AND administrator.legal_entity_id = p_legal_entity_id
      AND administrator.counterparty_purchasing_profile_id = v_profile_id
      AND administrator.permission_code = 'counterparty.access.manage'
      AND administrator.lifecycle IN ('PENDING_GRANT', 'ACTIVE', 'PENDING_REVOKE', 'RECONCILIATION_REQUIRED')
    ORDER BY administrator.recorded_at LIMIT 1;
    RETURN QUERY SELECT projection.*, NULL::uuid, NULL::uuid, NULL::text, NULL::boolean
    FROM commerce_customer_context.access_grant_row(
      p_tenant_id, p_legal_entity_id, v_grant_id, 'CONFLICT'
    ) AS projection;
    RETURN;
  END IF;

  SELECT grant_row.counterparty_commerce_access_grant_id, grant_row.lifecycle
    INTO v_grant_id, v_state
  FROM commerce_customer_context.counterparty_commerce_access_grants AS grant_row
  WHERE grant_row.tenant_id = p_tenant_id
    AND grant_row.legal_entity_id = p_legal_entity_id
    AND grant_row.counterparty_purchasing_profile_id = v_profile_id
    AND grant_row.principal_id = p_principal_id
    AND grant_row.permission_code = p_permission_code
    AND grant_row.storefront_resource_id IS NOT DISTINCT FROM p_storefront_resource_id
    AND grant_row.lifecycle IN ('PENDING_GRANT', 'ACTIVE', 'PENDING_REVOKE', 'RECONCILIATION_REQUIRED')
  FOR UPDATE;

  IF v_grant_id IS NOT NULL THEN
    IF v_state = 'ACTIVE' THEN
      v_outcome := 'ALREADY_ACTIVE';
    ELSIF v_state = 'PENDING_REVOKE' THEN
      v_outcome := 'CONFLICT';
    ELSIF v_state = 'RECONCILIATION_REQUIRED' THEN
      SELECT journal.mutation_kind INTO v_latest_mutation
      FROM commerce_customer_context.access_mutation_journal AS journal
      WHERE journal.tenant_id = p_tenant_id AND journal.legal_entity_id = p_legal_entity_id
        AND journal.resource_id = v_grant_id
      ORDER BY journal.recorded_at DESC, journal.access_mutation_id DESC LIMIT 1;
      IF v_latest_mutation = 'REVOKE' THEN
        v_outcome := 'CONFLICT';
      ELSE
        UPDATE commerce_customer_context.counterparty_commerce_access_grants
          SET lifecycle = 'PENDING_GRANT', revision = revision + 1
        WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
          AND counterparty_commerce_access_grant_id = v_grant_id;
        v_outcome := 'PENDING_GRANT';
      END IF;
    ELSE
      v_outcome := 'PENDING_GRANT';
    END IF;
  ELSE
    INSERT INTO commerce_customer_context.counterparty_commerce_access_grants (
      tenant_id, legal_entity_id, counterparty_purchasing_profile_id, principal_id,
      permission_code, storefront_resource_id, lifecycle, revision, actor_principal_id,
      action_invocation_id, reason
    ) VALUES (
      p_tenant_id, p_legal_entity_id, v_profile_id, p_principal_id,
      p_permission_code, p_storefront_resource_id, 'PENDING_GRANT', 1,
      p_actor_principal_id, p_action_invocation_id, p_reason
    ) RETURNING counterparty_commerce_access_grant_id INTO v_grant_id;
    v_outcome := 'PENDING_GRANT';
  END IF;

  IF v_outcome = 'PENDING_GRANT' THEN
    INSERT INTO commerce_customer_context.access_mutation_journal (
      tenant_id, legal_entity_id, counterparty_purchasing_profile_id, subject_principal_id,
      mutation_kind, resource_id, revision, safe_facts, actor_principal_id,
      action_invocation_id, reason
    ) VALUES (
      p_tenant_id, p_legal_entity_id, v_profile_id, p_principal_id,
      CASE WHEN p_bootstrap THEN 'BOOTSTRAP_ADMIN' ELSE 'GRANT' END,
      v_grant_id, 1,
      jsonb_build_object('requestedState', 'PENDING_GRANT', 'permissionCode', p_permission_code,
        'storefrontScoped', p_storefront_resource_id IS NOT NULL),
      p_actor_principal_id, p_action_invocation_id, p_reason
    ) ON CONFLICT (tenant_id, action_invocation_id, mutation_kind, resource_id) DO NOTHING
    RETURNING access_mutation_id INTO v_mutation_id;
    v_mutation_staged := v_mutation_id IS NOT NULL;
    IF v_mutation_id IS NULL THEN
      SELECT journal.access_mutation_id INTO v_mutation_id
      FROM commerce_customer_context.access_mutation_journal AS journal
      WHERE journal.tenant_id = p_tenant_id
        AND journal.legal_entity_id = p_legal_entity_id
        AND journal.action_invocation_id = p_action_invocation_id
        AND journal.mutation_kind = CASE WHEN p_bootstrap THEN 'BOOTSTRAP_ADMIN' ELSE 'GRANT' END
        AND journal.resource_id = v_grant_id;
    END IF;
  END IF;
  RETURN QUERY SELECT projection.*,
    CASE WHEN v_mutation_id IS NULL THEN NULL::uuid ELSE p_action_invocation_id END,
    v_mutation_id,
    CASE WHEN v_mutation_id IS NULL THEN NULL::text ELSE 'grant'::text END,
    CASE WHEN v_mutation_id IS NULL THEN NULL::boolean ELSE v_mutation_staged END
  FROM commerce_customer_context.access_grant_row(
    p_tenant_id, p_legal_entity_id, v_grant_id, v_outcome
  ) AS projection;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."begin_access_grant"(uuid, uuid, text, uuid, text, text, uuid, uuid, text, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."begin_access_grant"(uuid, uuid, text, uuid, text, text, uuid, uuid, text, boolean) TO "ontos_runtime";
--> statement-breakpoint

CREATE FUNCTION "commerce_customer_context"."begin_access_revoke"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_counterparty_resource_id text,
  p_grant_id uuid, p_principal_id uuid, p_permission_code text,
  p_storefront_resource_id text, p_actor_principal_id uuid,
  p_action_invocation_id uuid, p_reason text
)
RETURNS TABLE (
  counterparty_resource_id text, grant_id uuid, granted_at timestamptz, granted_by uuid,
  operation_outcome text, permission_code text, principal_id uuid, reason text,
  revision integer, revoked_at timestamptz, revoked_by uuid, state text,
  storefront_resource_id text, action_invocation_id uuid, mutation_id uuid,
  mutation_operation text, mutation_staged boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $function$
DECLARE
  v_profile_id uuid;
  v_grant_id uuid;
  v_mutation_id uuid;
  v_mutation_staged boolean := false;
  v_state text;
  v_outcome text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified operation scope mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT profile.counterparty_purchasing_profile_id INTO v_profile_id
  FROM commerce_customer_context.counterparty_purchasing_profiles AS profile
  WHERE profile.tenant_id = p_tenant_id AND profile.legal_entity_id = p_legal_entity_id
    AND profile.counterparty_resource_id = p_counterparty_resource_id
  FOR UPDATE;
  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION 'counterparty profile is unavailable in scope' USING ERRCODE = 'P0002';
  END IF;

  IF p_grant_id IS NOT NULL THEN
    SELECT grant_row.counterparty_commerce_access_grant_id, grant_row.lifecycle
      INTO v_grant_id, v_state
    FROM commerce_customer_context.counterparty_commerce_access_grants AS grant_row
    WHERE grant_row.tenant_id = p_tenant_id AND grant_row.legal_entity_id = p_legal_entity_id
      AND grant_row.counterparty_commerce_access_grant_id = p_grant_id
      AND grant_row.counterparty_purchasing_profile_id = v_profile_id
    FOR UPDATE;
  ELSE
    SELECT grant_row.counterparty_commerce_access_grant_id, grant_row.lifecycle
      INTO v_grant_id, v_state
    FROM commerce_customer_context.counterparty_commerce_access_grants AS grant_row
    WHERE grant_row.tenant_id = p_tenant_id AND grant_row.legal_entity_id = p_legal_entity_id
      AND grant_row.counterparty_purchasing_profile_id = v_profile_id
      AND grant_row.principal_id = p_principal_id
      AND grant_row.permission_code = p_permission_code
      AND grant_row.storefront_resource_id IS NOT DISTINCT FROM p_storefront_resource_id
    ORDER BY (grant_row.lifecycle = 'REVOKED'), grant_row.recorded_at DESC
    LIMIT 1 FOR UPDATE;
  END IF;
  IF v_grant_id IS NULL THEN
    RAISE EXCEPTION 'access grant is unavailable in scope' USING ERRCODE = 'P0002';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM commerce_customer_context.counterparty_commerce_access_grants AS exact_grant
    WHERE exact_grant.tenant_id = p_tenant_id
      AND exact_grant.legal_entity_id = p_legal_entity_id
      AND exact_grant.counterparty_commerce_access_grant_id = v_grant_id
      AND exact_grant.counterparty_purchasing_profile_id = v_profile_id
      AND exact_grant.principal_id = p_principal_id
      AND exact_grant.permission_code = p_permission_code
      AND exact_grant.storefront_resource_id IS NOT DISTINCT FROM p_storefront_resource_id
  ) THEN
    v_outcome := 'SCOPE_MISMATCH';
  ELSIF v_state = 'REVOKED' THEN
    v_outcome := 'ALREADY_REVOKED';
  ELSIF p_permission_code = 'counterparty.access.manage' AND NOT EXISTS (
    SELECT 1 FROM commerce_customer_context.counterparty_commerce_access_grants AS other_admin
    WHERE other_admin.tenant_id = p_tenant_id
      AND other_admin.legal_entity_id = p_legal_entity_id
      AND other_admin.counterparty_purchasing_profile_id = v_profile_id
      AND other_admin.counterparty_commerce_access_grant_id <> v_grant_id
      AND other_admin.permission_code = 'counterparty.access.manage'
      AND other_admin.lifecycle = 'ACTIVE'
  ) THEN
    v_outcome := 'LAST_ADMIN_PROTECTED';
  ELSE
    UPDATE commerce_customer_context.counterparty_commerce_access_grants
      SET lifecycle = 'PENDING_REVOKE', revision = revision + 1
    WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
      AND counterparty_commerce_access_grant_id = v_grant_id
      AND lifecycle IS DISTINCT FROM 'PENDING_REVOKE';
    v_outcome := 'PENDING_REVOKE';
    INSERT INTO commerce_customer_context.access_mutation_journal (
      tenant_id, legal_entity_id, counterparty_purchasing_profile_id, subject_principal_id,
      mutation_kind, resource_id, revision, safe_facts, actor_principal_id,
      action_invocation_id, reason
    ) VALUES (
      p_tenant_id, p_legal_entity_id, v_profile_id, p_principal_id, 'REVOKE', v_grant_id, 1,
      jsonb_build_object('requestedState', 'PENDING_REVOKE', 'permissionCode', p_permission_code,
        'storefrontScoped', p_storefront_resource_id IS NOT NULL),
      p_actor_principal_id, p_action_invocation_id, p_reason
    ) ON CONFLICT (tenant_id, action_invocation_id, mutation_kind, resource_id) DO NOTHING
    RETURNING access_mutation_id INTO v_mutation_id;
    v_mutation_staged := v_mutation_id IS NOT NULL;
    IF v_mutation_id IS NULL THEN
      SELECT journal.access_mutation_id INTO v_mutation_id
      FROM commerce_customer_context.access_mutation_journal AS journal
      WHERE journal.tenant_id = p_tenant_id
        AND journal.legal_entity_id = p_legal_entity_id
        AND journal.action_invocation_id = p_action_invocation_id
        AND journal.mutation_kind = 'REVOKE'
        AND journal.resource_id = v_grant_id;
    END IF;
  END IF;
  RETURN QUERY SELECT projection.*,
    CASE WHEN v_mutation_id IS NULL THEN NULL::uuid ELSE p_action_invocation_id END,
    v_mutation_id,
    CASE WHEN v_mutation_id IS NULL THEN NULL::text ELSE 'revoke'::text END,
    CASE WHEN v_mutation_id IS NULL THEN NULL::boolean ELSE v_mutation_staged END
  FROM commerce_customer_context.access_grant_row(
    p_tenant_id, p_legal_entity_id, v_grant_id, v_outcome
  ) AS projection;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."begin_access_revoke"(uuid, uuid, text, uuid, uuid, text, text, uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."begin_access_revoke"(uuid, uuid, text, uuid, uuid, text, text, uuid, uuid, text) TO "ontos_runtime";
--> statement-breakpoint

CREATE FUNCTION "commerce_customer_context"."transition_access_grant"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_grant_id uuid, p_mutation_id uuid,
  p_expected_operation text, p_target_state text
)
RETURNS TABLE (
  counterparty_resource_id text, grant_id uuid, granted_at timestamptz, granted_by uuid,
  operation_outcome text, permission_code text, principal_id uuid, reason text,
  revision integer, revoked_at timestamptz, revoked_by uuid, state text,
  storefront_resource_id text, action_invocation_id uuid, mutation_id uuid,
  mutation_operation text, mutation_staged boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $function$
DECLARE
  v_action_invocation_id uuid;
  v_current_state text;
  v_latest_mutation_id uuid;
  v_latest_mutation_kind text;
  v_operation text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
    OR p_expected_operation NOT IN ('grant', 'revoke') THEN
    RAISE EXCEPTION 'verified operation scope mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT lifecycle INTO v_current_state
  FROM commerce_customer_context.counterparty_commerce_access_grants
  WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
    AND counterparty_commerce_access_grant_id = p_grant_id
  FOR UPDATE;
  IF v_current_state IS NULL THEN
    RAISE EXCEPTION 'access grant is unavailable in scope' USING ERRCODE = 'P0002';
  END IF;
  SELECT journal.access_mutation_id, journal.mutation_kind, journal.action_invocation_id
    INTO v_latest_mutation_id, v_latest_mutation_kind, v_action_invocation_id
  FROM commerce_customer_context.access_mutation_journal AS journal
  WHERE journal.tenant_id = p_tenant_id
    AND journal.legal_entity_id = p_legal_entity_id
    AND journal.resource_id = p_grant_id
  ORDER BY journal.recorded_at DESC, journal.access_mutation_id DESC
  LIMIT 1;
  v_operation := CASE WHEN v_latest_mutation_kind = 'REVOKE' THEN 'revoke' ELSE 'grant' END;
  IF v_latest_mutation_id IS DISTINCT FROM p_mutation_id
    OR v_operation IS DISTINCT FROM p_expected_operation THEN
    RAISE EXCEPTION 'access mutation intent is stale or mismatched' USING ERRCODE = '40001';
  END IF;
  IF p_target_state <> 'RECONCILIATION_REQUIRED'
    AND ((p_expected_operation = 'grant' AND p_target_state <> 'ACTIVE')
      OR (p_expected_operation = 'revoke' AND p_target_state <> 'REVOKED')) THEN
    RAISE EXCEPTION 'access mutation target conflicts with its operation' USING ERRCODE = '23514';
  END IF;
  IF NOT (
    p_target_state = v_current_state
    OR (p_target_state = 'ACTIVE' AND v_current_state IN ('PENDING_GRANT', 'RECONCILIATION_REQUIRED'))
    OR (p_target_state = 'REVOKED' AND v_current_state IN ('PENDING_REVOKE', 'RECONCILIATION_REQUIRED'))
    OR (p_target_state = 'RECONCILIATION_REQUIRED' AND v_current_state IN ('PENDING_GRANT', 'PENDING_REVOKE', 'RECONCILIATION_REQUIRED'))
  ) THEN
    RAISE EXCEPTION 'invalid access grant transition' USING ERRCODE = '23514';
  END IF;
  UPDATE commerce_customer_context.counterparty_commerce_access_grants
  SET lifecycle = p_target_state,
      revision = revision + CASE WHEN lifecycle = p_target_state THEN 0 ELSE 1 END,
      recorded_at = CASE
        WHEN p_target_state = 'ACTIVE' AND lifecycle <> 'ACTIVE' THEN statement_timestamp()
        ELSE recorded_at
      END,
      revoked_at = CASE WHEN p_target_state = 'REVOKED' THEN coalesce(revoked_at, statement_timestamp()) ELSE NULL END
  WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
    AND counterparty_commerce_access_grant_id = p_grant_id;
  RETURN QUERY SELECT projection.*, v_action_invocation_id, p_mutation_id,
    p_expected_operation, false
  FROM commerce_customer_context.access_grant_row(
    p_tenant_id, p_legal_entity_id, p_grant_id, NULL
  ) AS projection;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."transition_access_grant"(uuid, uuid, uuid, uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."transition_access_grant"(uuid, uuid, uuid, uuid, text, text) TO "ontos_runtime";
--> statement-breakpoint

CREATE FUNCTION "commerce_customer_context"."list_access_reconciliation"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_limit integer
)
RETURNS TABLE (
  counterparty_resource_id text, grant_id uuid, granted_at timestamptz, granted_by uuid,
  operation_outcome text, permission_code text, principal_id uuid, reason text,
  revision integer, revoked_at timestamptz, revoked_by uuid, state text,
  storefront_resource_id text, action_invocation_id uuid, mutation_id uuid,
  recovery_operation text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $function$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
    OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid scoped reconciliation request' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT projection.*, latest.action_invocation_id, latest.access_mutation_id,
    CASE WHEN latest.mutation_kind = 'REVOKE' OR grant_row.lifecycle = 'PENDING_REVOKE'
      THEN 'revoke' ELSE 'grant' END
  FROM commerce_customer_context.counterparty_commerce_access_grants AS grant_row
  CROSS JOIN LATERAL commerce_customer_context.access_grant_row(
    p_tenant_id, p_legal_entity_id, grant_row.counterparty_commerce_access_grant_id, NULL
  ) AS projection
  JOIN LATERAL (
    SELECT journal.access_mutation_id, journal.action_invocation_id, journal.mutation_kind
    FROM commerce_customer_context.access_mutation_journal AS journal
    WHERE journal.tenant_id = p_tenant_id AND journal.legal_entity_id = p_legal_entity_id
      AND journal.resource_id = grant_row.counterparty_commerce_access_grant_id
    ORDER BY journal.recorded_at DESC, journal.access_mutation_id DESC LIMIT 1
  ) AS latest ON true
  WHERE grant_row.tenant_id = p_tenant_id AND grant_row.legal_entity_id = p_legal_entity_id
    AND grant_row.lifecycle IN ('PENDING_GRANT', 'PENDING_REVOKE', 'RECONCILIATION_REQUIRED')
  ORDER BY grant_row.recorded_at, grant_row.counterparty_commerce_access_grant_id
  LIMIT p_limit FOR UPDATE OF grant_row SKIP LOCKED;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."list_access_reconciliation"(uuid, uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."list_access_reconciliation"(uuid, uuid, integer) TO "ontos_runtime";
--> statement-breakpoint

CREATE FUNCTION "commerce_customer_context"."read_access_reconciliation"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_mutation_id uuid
)
RETURNS TABLE (
  counterparty_resource_id text, grant_id uuid, granted_at timestamptz, granted_by uuid,
  operation_outcome text, permission_code text, principal_id uuid, reason text,
  revision integer, revoked_at timestamptz, revoked_by uuid, state text,
  storefront_resource_id text, action_invocation_id uuid, mutation_id uuid,
  recovery_operation text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $function$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'invalid scoped reconciliation request' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT projection.*, requested.action_invocation_id, requested.access_mutation_id,
    CASE WHEN requested.mutation_kind = 'REVOKE' THEN 'revoke' ELSE 'grant' END
  FROM commerce_customer_context.access_mutation_journal AS requested
  JOIN commerce_customer_context.counterparty_commerce_access_grants AS grant_row
    ON grant_row.tenant_id = requested.tenant_id
    AND grant_row.legal_entity_id = requested.legal_entity_id
    AND grant_row.counterparty_commerce_access_grant_id = requested.resource_id
  CROSS JOIN LATERAL commerce_customer_context.access_grant_row(
    p_tenant_id, p_legal_entity_id, grant_row.counterparty_commerce_access_grant_id, NULL
  ) AS projection
  WHERE requested.tenant_id = p_tenant_id
    AND requested.legal_entity_id = p_legal_entity_id
    AND requested.access_mutation_id = p_mutation_id
    AND requested.mutation_kind IN ('BOOTSTRAP_ADMIN', 'GRANT', 'REVOKE')
    AND NOT EXISTS (
      SELECT 1 FROM commerce_customer_context.access_mutation_journal AS newer
      WHERE newer.tenant_id = requested.tenant_id
        AND newer.legal_entity_id = requested.legal_entity_id
        AND newer.resource_id = requested.resource_id
        AND (newer.recorded_at, newer.access_mutation_id) >
          (requested.recorded_at, requested.access_mutation_id)
    )
  FOR UPDATE OF grant_row;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."read_access_reconciliation"(uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_access_reconciliation"(uuid, uuid, uuid) TO "ontos_runtime";
--> statement-breakpoint

CREATE FUNCTION "commerce_customer_context"."invitation_grant_progress"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_invitation_id uuid
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $function$
  SELECT coalesce(jsonb_agg(
    CASE WHEN grant_row.lifecycle IN ('ACTIVE', 'PENDING_REVOKE', 'RECONCILIATION_REQUIRED') THEN
      jsonb_build_object(
        'permission', permission.value,
        'state', CASE WHEN grant_row.lifecycle = 'PENDING_REVOKE'
          THEN 'RECONCILIATION_REQUIRED' ELSE grant_row.lifecycle END,
        'grantRef', jsonb_build_object(
          'moduleId', 'commerce.customer-context',
          'resourceId', grant_row.counterparty_commerce_access_grant_id::text,
          'resourceType', 'commerce.customer-context.counterparty-commerce-access-grant',
          'tenantId', p_tenant_id::text
        )
      )
    ELSE jsonb_build_object('permission', permission.value, 'state', 'PENDING_GRANT') END
    ORDER BY permission.ordinality
  ), '[]'::jsonb)
  FROM commerce_customer_context.counterparty_access_invitations AS invitation
  CROSS JOIN LATERAL jsonb_array_elements_text(invitation.requested_permission_codes)
    WITH ORDINALITY AS permission(value, ordinality)
  LEFT JOIN LATERAL (
    SELECT access_grant.*
    FROM commerce_customer_context.counterparty_commerce_access_grants AS access_grant
    WHERE access_grant.tenant_id = invitation.tenant_id
      AND access_grant.legal_entity_id = invitation.legal_entity_id
      AND access_grant.counterparty_purchasing_profile_id = invitation.counterparty_purchasing_profile_id
      AND access_grant.principal_id = coalesce(
        invitation.claimed_by_principal_id,
        (SELECT journal.subject_principal_id
         FROM commerce_customer_context.access_mutation_journal AS journal
         WHERE journal.tenant_id = invitation.tenant_id
           AND journal.legal_entity_id = invitation.legal_entity_id
           AND journal.resource_id = invitation.counterparty_access_invitation_id
           AND journal.mutation_kind = 'CLAIM_INVITE'
         ORDER BY journal.recorded_at DESC, journal.access_mutation_id DESC LIMIT 1)
      )
      AND access_grant.permission_code = permission.value
      AND access_grant.storefront_resource_id IS NOT DISTINCT FROM invitation.storefront_resource_id
      AND access_grant.lifecycle IN ('PENDING_GRANT', 'ACTIVE', 'PENDING_REVOKE', 'RECONCILIATION_REQUIRED')
    ORDER BY access_grant.recorded_at DESC LIMIT 1
  ) AS grant_row ON true
  WHERE invitation.tenant_id = p_tenant_id
    AND invitation.legal_entity_id = p_legal_entity_id
    AND invitation.counterparty_access_invitation_id = p_invitation_id;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."invitation_grant_progress"(uuid, uuid, uuid) FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint

CREATE FUNCTION "commerce_customer_context"."read_access_invitation"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_invitation_id uuid,
  p_counterparty_resource_id text, p_storefront_resource_id text
)
RETURNS TABLE (
  claimed_at timestamptz, claimed_by_principal_id uuid, counterparty_resource_id text,
  created_at timestamptz, delivery_method text, delivery_reference text, expires_at timestamptz,
  grant_progress jsonb, invitation_id uuid, invited_by uuid, operation_outcome text,
  reason text, requested_permission_codes jsonb, revision integer, state text,
  storefront_resource_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $function$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified operation scope mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT invitation.claimed_at, invitation.claimed_by_principal_id,
    profile.counterparty_resource_id, invitation.recorded_at, invitation.delivery_method,
    invitation.delivery_reference, invitation.expires_at,
    CASE WHEN invitation.lifecycle IN ('PENDING', 'EXPIRED') THEN '[]'::jsonb
      ELSE commerce_customer_context.invitation_grant_progress(
        p_tenant_id, p_legal_entity_id, invitation.counterparty_access_invitation_id
      ) END,
    invitation.counterparty_access_invitation_id, invitation.actor_principal_id,
    NULL::text, coalesce(invitation.reason, 'Access invitation'),
    invitation.requested_permission_codes, invitation.revision, invitation.lifecycle,
    invitation.storefront_resource_id
  FROM commerce_customer_context.counterparty_access_invitations AS invitation
  JOIN commerce_customer_context.counterparty_purchasing_profiles AS profile
    ON profile.tenant_id = invitation.tenant_id
    AND profile.legal_entity_id = invitation.legal_entity_id
    AND profile.counterparty_purchasing_profile_id = invitation.counterparty_purchasing_profile_id
  WHERE invitation.tenant_id = p_tenant_id AND invitation.legal_entity_id = p_legal_entity_id
    AND invitation.counterparty_access_invitation_id = p_invitation_id
    AND profile.counterparty_resource_id = p_counterparty_resource_id
    AND invitation.storefront_resource_id IS NOT DISTINCT FROM p_storefront_resource_id;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."read_access_invitation"(uuid, uuid, uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_access_invitation"(uuid, uuid, uuid, text, text) TO "ontos_runtime";
--> statement-breakpoint

CREATE FUNCTION "commerce_customer_context"."create_access_invitation"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_counterparty_resource_id text,
  p_delivery_method text, p_delivery_reference text, p_permission_codes text[],
  p_storefront_resource_id text, p_expires_at timestamptz, p_actor_principal_id uuid,
  p_action_invocation_id uuid, p_reason text
)
RETURNS TABLE (
  claimed_at timestamptz, claimed_by_principal_id uuid, counterparty_resource_id text,
  created_at timestamptz, delivery_method text, delivery_reference text, expires_at timestamptz,
  grant_progress jsonb, invitation_id uuid, invited_by uuid, operation_outcome text,
  reason text, requested_permission_codes jsonb, revision integer, state text,
  storefront_resource_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $function$
DECLARE v_profile_id uuid; v_invitation_id uuid; v_outcome text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
    OR p_expires_at <= statement_timestamp() OR cardinality(p_permission_codes) NOT BETWEEN 1 AND 64
    OR cardinality(p_permission_codes) <> (SELECT count(DISTINCT code) FROM unnest(p_permission_codes) AS code) THEN
    RAISE EXCEPTION 'invalid scoped invitation request' USING ERRCODE = '23514';
  END IF;
  SELECT profile.counterparty_purchasing_profile_id INTO v_profile_id
  FROM commerce_customer_context.counterparty_purchasing_profiles AS profile
  WHERE profile.tenant_id = p_tenant_id AND profile.legal_entity_id = p_legal_entity_id
    AND profile.counterparty_resource_id = p_counterparty_resource_id FOR UPDATE;
  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION 'counterparty profile is unavailable in scope' USING ERRCODE = 'P0002';
  END IF;
  SELECT invitation.counterparty_access_invitation_id INTO v_invitation_id
  FROM commerce_customer_context.counterparty_access_invitations AS invitation
  WHERE invitation.tenant_id = p_tenant_id AND invitation.legal_entity_id = p_legal_entity_id
    AND invitation.counterparty_purchasing_profile_id = v_profile_id
    AND invitation.delivery_reference = p_delivery_reference AND invitation.lifecycle = 'PENDING'
  FOR UPDATE;
  IF v_invitation_id IS NOT NULL THEN
    v_outcome := 'ALREADY_PENDING';
  ELSE
    INSERT INTO commerce_customer_context.counterparty_access_invitations (
      tenant_id, legal_entity_id, counterparty_purchasing_profile_id, delivery_method,
      delivery_reference, requested_permission_codes, storefront_resource_id, lifecycle,
      revision, expires_at, actor_principal_id, action_invocation_id, reason
    ) VALUES (
      p_tenant_id, p_legal_entity_id, v_profile_id, p_delivery_method,
      p_delivery_reference, to_jsonb(p_permission_codes), p_storefront_resource_id, 'PENDING',
      1, p_expires_at, p_actor_principal_id, p_action_invocation_id, p_reason
    ) RETURNING counterparty_access_invitation_id INTO v_invitation_id;
    INSERT INTO commerce_customer_context.access_mutation_journal (
      tenant_id, legal_entity_id, counterparty_purchasing_profile_id, mutation_kind,
      resource_id, revision, safe_facts, actor_principal_id, action_invocation_id, reason
    ) VALUES (
      p_tenant_id, p_legal_entity_id, v_profile_id, 'INVITE', v_invitation_id, 1,
      jsonb_build_object('requestedState', 'PENDING', 'deliveryMethod', p_delivery_method,
        'permissionCount', cardinality(p_permission_codes), 'invitationRef',
        jsonb_build_object('moduleId', 'commerce.customer-context',
          'resourceId', v_invitation_id::text,
          'resourceType', 'commerce.customer-context.counterparty-access-invitation',
          'tenantId', p_tenant_id::text)),
      p_actor_principal_id, p_action_invocation_id, p_reason
    ) ON CONFLICT (tenant_id, action_invocation_id, mutation_kind, resource_id) DO NOTHING;
    v_outcome := 'CREATED';
  END IF;
  RETURN QUERY
  SELECT invitation.claimed_at, invitation.claimed_by_principal_id,
    invitation.counterparty_resource_id, invitation.created_at, invitation.delivery_method,
    invitation.delivery_reference, invitation.expires_at, invitation.grant_progress,
    invitation.invitation_id, invitation.invited_by, v_outcome, invitation.reason,
    invitation.requested_permission_codes, invitation.revision, invitation.state,
    invitation.storefront_resource_id
  FROM commerce_customer_context.read_access_invitation(
    p_tenant_id, p_legal_entity_id, v_invitation_id,
    p_counterparty_resource_id, p_storefront_resource_id
  ) AS invitation;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."create_access_invitation"(uuid, uuid, text, text, text, text[], text, timestamptz, uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."create_access_invitation"(uuid, uuid, text, text, text, text[], text, timestamptz, uuid, uuid, text) TO "ontos_runtime";
--> statement-breakpoint

CREATE FUNCTION "commerce_customer_context"."mutate_access_invitation"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_invitation_id uuid,
  p_counterparty_resource_id text, p_storefront_resource_id text,
  p_expected_revision integer, p_operation text, p_actor_principal_id uuid,
  p_action_invocation_id uuid, p_reason text, p_claimant_principal_id uuid,
  p_claim_proof_reference text
)
RETURNS TABLE (
  claimed_at timestamptz, claimed_by_principal_id uuid, counterparty_resource_id text,
  created_at timestamptz, delivery_method text, delivery_reference text, expires_at timestamptz,
  grant_progress jsonb, invitation_id uuid, invited_by uuid, operation_outcome text,
  reason text, requested_permission_codes jsonb, revision integer, state text,
  storefront_resource_id text, mutation_id uuid, mutation_staged boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $function$
DECLARE
  v_invitation commerce_customer_context.counterparty_access_invitations%ROWTYPE;
  v_mutation_id uuid;
  v_profile_counterparty text;
  v_mutation_kind text;
  v_mutation_staged boolean := false;
  v_outcome text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
    OR p_operation NOT IN (
      'RESEND', 'REVOKE', 'BEGIN_CLAIM', 'REJECT_CLAIM', 'EXPIRE_CLAIM',
      'FINISH_CLAIM', 'FINISH_RECONCILIATION'
    ) THEN
    RAISE EXCEPTION 'invalid scoped invitation mutation' USING ERRCODE = '42501';
  END IF;
  SELECT invitation.* INTO v_invitation
  FROM commerce_customer_context.counterparty_access_invitations AS invitation
  WHERE invitation.tenant_id = p_tenant_id AND invitation.legal_entity_id = p_legal_entity_id
    AND invitation.counterparty_access_invitation_id = p_invitation_id
  FOR UPDATE;
  IF NOT FOUND THEN v_outcome := 'INVALID';
  ELSE
    SELECT profile.counterparty_resource_id INTO v_profile_counterparty
    FROM commerce_customer_context.counterparty_purchasing_profiles AS profile
    WHERE profile.tenant_id = p_tenant_id AND profile.legal_entity_id = p_legal_entity_id
      AND profile.counterparty_purchasing_profile_id = v_invitation.counterparty_purchasing_profile_id;
    IF v_profile_counterparty IS DISTINCT FROM p_counterparty_resource_id
      OR v_invitation.storefront_resource_id IS DISTINCT FROM p_storefront_resource_id THEN
      v_outcome := 'INVALID';
    ELSIF p_operation = 'RESEND' THEN
      v_mutation_kind := 'RESEND_INVITE';
      IF EXISTS (
        SELECT 1 FROM commerce_customer_context.access_mutation_journal AS journal
        WHERE journal.tenant_id = p_tenant_id AND journal.action_invocation_id = p_action_invocation_id
          AND journal.mutation_kind = v_mutation_kind AND journal.resource_id = p_invitation_id
      ) THEN v_outcome := 'ALREADY_SENT';
      ELSIF v_invitation.expires_at <= statement_timestamp() THEN
        UPDATE commerce_customer_context.counterparty_access_invitations
          SET lifecycle = 'EXPIRED', revision = revision + 1
        WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
          AND counterparty_access_invitation_id = p_invitation_id;
        v_outcome := 'EXPIRED';
      ELSIF v_invitation.lifecycle <> 'PENDING' THEN v_outcome := 'INVALID';
      ELSIF v_invitation.revision <> p_expected_revision THEN v_outcome := 'REVISION_CONFLICT';
      ELSE
        UPDATE commerce_customer_context.counterparty_access_invitations
          SET revision = revision + 1
        WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
          AND counterparty_access_invitation_id = p_invitation_id;
        v_outcome := 'RESENT';
      END IF;
    ELSIF p_operation = 'REVOKE' THEN
      v_mutation_kind := 'REVOKE_INVITE';
      IF v_invitation.lifecycle = 'REVOKED' OR EXISTS (
        SELECT 1 FROM commerce_customer_context.access_mutation_journal AS journal
        WHERE journal.tenant_id = p_tenant_id AND journal.action_invocation_id = p_action_invocation_id
          AND journal.mutation_kind = v_mutation_kind AND journal.resource_id = p_invitation_id
      ) THEN v_outcome := 'ALREADY_REVOKED';
      ELSIF v_invitation.lifecycle NOT IN ('PENDING', 'CLAIMING', 'RECONCILIATION_REQUIRED') THEN
        v_outcome := 'INVALID';
      ELSIF v_invitation.revision <> p_expected_revision THEN v_outcome := 'REVISION_CONFLICT';
      ELSE
        UPDATE commerce_customer_context.counterparty_access_invitations
          SET lifecycle = 'REVOKED', revoked_at = statement_timestamp(), revision = revision + 1,
              claim_proof_reference = NULL
        WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
          AND counterparty_access_invitation_id = p_invitation_id;
        v_outcome := 'REVOKED';
      END IF;
    ELSIF p_operation = 'BEGIN_CLAIM' THEN
      v_mutation_kind := 'CLAIM_INVITE';
      IF v_invitation.lifecycle = 'CLAIMED' THEN v_outcome := 'ALREADY_CLAIMED';
      ELSIF v_invitation.expires_at <= statement_timestamp() THEN
        UPDATE commerce_customer_context.counterparty_access_invitations
          SET lifecycle = 'EXPIRED', revision = revision + 1,
              claimed_by_principal_id = NULL, claimed_at = NULL,
              claim_proof_reference = NULL,
              claim_origin_principal_id = NULL,
              claim_origin_action_invocation_id = NULL,
              claim_origin_proof_reference = NULL
        WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
          AND counterparty_access_invitation_id = p_invitation_id;
        v_outcome := 'EXPIRED';
      ELSIF EXISTS (
        SELECT 1 FROM commerce_customer_context.access_mutation_journal AS journal
        WHERE journal.tenant_id = p_tenant_id AND journal.action_invocation_id = p_action_invocation_id
          AND journal.mutation_kind = v_mutation_kind AND journal.resource_id = p_invitation_id
          AND journal.subject_principal_id = p_claimant_principal_id
      ) AND v_invitation.lifecycle IN ('CLAIMING', 'RECONCILIATION_REQUIRED') THEN
        v_outcome := 'CLAIMING';
      ELSIF v_invitation.lifecycle <> 'PENDING' OR p_claimant_principal_id IS NULL
        OR p_claim_proof_reference IS NULL THEN v_outcome := 'INVALID';
      ELSIF v_invitation.revision <> p_expected_revision THEN v_outcome := 'REVISION_CONFLICT';
      ELSE
        UPDATE commerce_customer_context.counterparty_access_invitations
          SET lifecycle = 'CLAIMING', revision = revision + 1,
              claimed_by_principal_id = p_claimant_principal_id,
              claim_proof_reference = p_claim_proof_reference
        WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
          AND counterparty_access_invitation_id = p_invitation_id;
        v_outcome := 'CLAIMING';
      END IF;
    ELSIF p_operation IN ('REJECT_CLAIM', 'EXPIRE_CLAIM') THEN
      v_mutation_kind := 'CLAIM_INVITE';
      IF v_invitation.lifecycle NOT IN ('CLAIMING', 'RECONCILIATION_REQUIRED')
        OR p_claimant_principal_id IS NULL OR p_claim_proof_reference IS NULL
        OR v_invitation.claimed_by_principal_id IS DISTINCT FROM p_claimant_principal_id
        OR v_invitation.claim_proof_reference IS DISTINCT FROM p_claim_proof_reference
        OR NOT EXISTS (
          SELECT 1 FROM commerce_customer_context.access_mutation_journal AS claim
          WHERE claim.tenant_id = p_tenant_id AND claim.legal_entity_id = p_legal_entity_id
            AND claim.action_invocation_id = p_action_invocation_id
            AND claim.mutation_kind = 'CLAIM_INVITE' AND claim.resource_id = p_invitation_id
            AND claim.subject_principal_id = p_claimant_principal_id
        ) THEN
        v_outcome := 'INVALID';
      ELSE
        UPDATE commerce_customer_context.counterparty_access_invitations
          SET lifecycle = CASE WHEN p_operation = 'EXPIRE_CLAIM' THEN 'EXPIRED' ELSE 'PENDING' END,
              revision = revision + 1, claimed_by_principal_id = NULL,
              claimed_at = NULL, claim_proof_reference = NULL
        WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
          AND counterparty_access_invitation_id = p_invitation_id;
        v_outcome := CASE WHEN p_operation = 'EXPIRE_CLAIM' THEN 'EXPIRED' ELSE 'CLAIM_REJECTED' END;
      END IF;
    ELSE
      v_mutation_kind := 'CLAIM_INVITE';
      IF v_invitation.lifecycle = 'CLAIMED' THEN v_outcome := 'ALREADY_CLAIMED';
      ELSIF v_invitation.lifecycle NOT IN ('CLAIMING', 'RECONCILIATION_REQUIRED')
        OR p_claimant_principal_id IS NULL OR p_claim_proof_reference IS NULL THEN
        v_outcome := 'INVALID';
      ELSIF v_invitation.revision <> p_expected_revision THEN v_outcome := 'REVISION_CONFLICT';
      ELSIF p_operation = 'FINISH_RECONCILIATION' THEN
        UPDATE commerce_customer_context.counterparty_access_invitations
          SET lifecycle = 'RECONCILIATION_REQUIRED', revision = revision + 1,
              claim_proof_reference = p_claim_proof_reference
        WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
          AND counterparty_access_invitation_id = p_invitation_id;
        v_outcome := 'RECONCILIATION_REQUIRED';
      ELSE
        UPDATE commerce_customer_context.counterparty_access_invitations
          SET lifecycle = 'CLAIMED', claimed_by_principal_id = p_claimant_principal_id,
              claimed_at = statement_timestamp(), revision = revision + 1,
              claim_proof_reference = p_claim_proof_reference
        WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
          AND counterparty_access_invitation_id = p_invitation_id;
        v_outcome := 'CLAIMING';
      END IF;
    END IF;

    IF v_mutation_kind IS NOT NULL AND v_outcome IN ('RESENT', 'REVOKED', 'CLAIMING', 'RECONCILIATION_REQUIRED') THEN
      INSERT INTO commerce_customer_context.access_mutation_journal (
        tenant_id, legal_entity_id, counterparty_purchasing_profile_id, subject_principal_id,
        mutation_kind, resource_id, revision, safe_facts, actor_principal_id,
        action_invocation_id, reason
      ) VALUES (
        p_tenant_id, p_legal_entity_id, v_invitation.counterparty_purchasing_profile_id,
        p_claimant_principal_id, v_mutation_kind, p_invitation_id, v_invitation.revision,
        jsonb_build_object('operation', p_operation, 'requestedState',
          CASE p_operation WHEN 'RESEND' THEN 'PENDING' WHEN 'REVOKE' THEN 'REVOKED'
            WHEN 'FINISH_CLAIM' THEN 'CLAIMED' WHEN 'FINISH_RECONCILIATION' THEN 'RECONCILIATION_REQUIRED'
            ELSE 'CLAIMING' END, 'invitationRef',
          jsonb_build_object('moduleId', 'commerce.customer-context',
            'resourceId', p_invitation_id::text,
            'resourceType', 'commerce.customer-context.counterparty-access-invitation',
            'tenantId', p_tenant_id::text)),
        p_actor_principal_id, p_action_invocation_id, p_reason
      ) ON CONFLICT (tenant_id, action_invocation_id, mutation_kind, resource_id) DO NOTHING
      RETURNING access_mutation_id INTO v_mutation_id;
      v_mutation_staged := v_mutation_id IS NOT NULL;
    END IF;
    IF v_mutation_kind IS NOT NULL AND v_mutation_id IS NULL THEN
      SELECT journal.access_mutation_id INTO v_mutation_id
      FROM commerce_customer_context.access_mutation_journal AS journal
      WHERE journal.tenant_id = p_tenant_id
        AND journal.legal_entity_id = p_legal_entity_id
        AND journal.action_invocation_id = p_action_invocation_id
        AND journal.mutation_kind = v_mutation_kind
        AND journal.resource_id = p_invitation_id;
    END IF;
  END IF;

  IF v_outcome = 'INVALID' THEN RETURN; END IF;
  RETURN QUERY
  SELECT invitation.claimed_at, invitation.claimed_by_principal_id,
    invitation.counterparty_resource_id, invitation.created_at, invitation.delivery_method,
    invitation.delivery_reference, invitation.expires_at, invitation.grant_progress,
    invitation.invitation_id, invitation.invited_by, v_outcome, invitation.reason,
    invitation.requested_permission_codes, invitation.revision, invitation.state,
    invitation.storefront_resource_id, v_mutation_id,
    CASE WHEN v_mutation_id IS NULL THEN NULL::boolean ELSE v_mutation_staged END
  FROM commerce_customer_context.read_access_invitation(
    p_tenant_id, p_legal_entity_id, p_invitation_id,
    p_counterparty_resource_id, p_storefront_resource_id
  ) AS invitation;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."mutate_access_invitation"(uuid, uuid, uuid, text, text, integer, text, uuid, uuid, text, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."mutate_access_invitation"(uuid, uuid, uuid, text, text, integer, text, uuid, uuid, text, uuid, text) TO "ontos_runtime";
--> statement-breakpoint

CREATE FUNCTION "commerce_customer_context"."read_access_invitation_claim_reconciliation"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_claim_mutation_id uuid
)
RETURNS TABLE (
  claimed_at timestamptz, claimed_by_principal_id uuid, counterparty_resource_id text,
  created_at timestamptz, delivery_method text, delivery_reference text, expires_at timestamptz,
  grant_progress jsonb, invitation_id uuid, invited_by uuid, operation_outcome text,
  reason text, requested_permission_codes jsonb, revision integer, state text,
  storefront_resource_id text, attestation_reference text, claim_mutation_id uuid,
  source_action_invocation_id uuid, verified_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $function$
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'invalid scoped invitation reconciliation request' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT invitation.*, proof.attestation_reference, claim.access_mutation_id,
    claim.action_invocation_id, proof.consumed_at
  FROM commerce_customer_context.access_mutation_journal AS claim
  JOIN commerce_customer_context.counterparty_access_invitations AS stored
    ON stored.tenant_id = claim.tenant_id AND stored.legal_entity_id = claim.legal_entity_id
    AND stored.counterparty_access_invitation_id = claim.resource_id
    AND stored.counterparty_purchasing_profile_id = claim.counterparty_purchasing_profile_id
    AND stored.claimed_by_principal_id = claim.subject_principal_id
  JOIN commerce_customer_context.counterparty_purchasing_profiles AS profile
    ON profile.tenant_id = stored.tenant_id AND profile.legal_entity_id = stored.legal_entity_id
    AND profile.counterparty_purchasing_profile_id = stored.counterparty_purchasing_profile_id
  JOIN commerce_customer_context.counterparty_invitation_claim_proofs AS proof
    ON proof.tenant_id = stored.tenant_id AND proof.legal_entity_id = stored.legal_entity_id
    AND proof.invitation_id = stored.counterparty_access_invitation_id
    AND proof.claimant_principal_id = stored.claimed_by_principal_id
    AND proof.consume_action_invocation_id = claim.action_invocation_id
    AND proof.lifecycle = 'CONSUMED'
    AND proof.attestation_reference = stored.claim_proof_reference
  CROSS JOIN LATERAL commerce_customer_context.read_access_invitation(
    p_tenant_id, p_legal_entity_id, stored.counterparty_access_invitation_id,
    profile.counterparty_resource_id, stored.storefront_resource_id
  ) AS invitation
  WHERE claim.tenant_id = p_tenant_id AND claim.legal_entity_id = p_legal_entity_id
    AND claim.access_mutation_id = p_claim_mutation_id AND claim.mutation_kind = 'CLAIM_INVITE';
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."read_access_invitation_claim_reconciliation"(uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_access_invitation_claim_reconciliation"(uuid, uuid, uuid) TO "ontos_runtime";
--> statement-breakpoint

CREATE FUNCTION "commerce_customer_context"."stage_access_invitation_claim_grants"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_claim_mutation_id uuid,
  p_compensate boolean
)
RETURNS TABLE (
  counterparty_resource_id text, grant_id uuid, granted_at timestamptz, granted_by uuid,
  operation_outcome text, permission_code text, principal_id uuid, reason text,
  revision integer, revoked_at timestamptz, revoked_by uuid, state text,
  storefront_resource_id text, action_invocation_id uuid, mutation_id uuid,
  recovery_operation text, mutation_staged boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $function$
DECLARE
  v_claim commerce_customer_context.access_mutation_journal%ROWTYPE;
  v_invitation commerce_customer_context.counterparty_access_invitations%ROWTYPE;
  v_counterparty_resource_id text;
  v_permission text;
  v_begin record;
  v_current_grant_id uuid;
  v_current_mutation_id uuid;
  v_current_operation text;
  v_compensation_mutation_id uuid;
  v_compensation_staged boolean;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'invalid scoped invitation reconciliation request' USING ERRCODE = '42501';
  END IF;
  SELECT claim.* INTO v_claim
  FROM commerce_customer_context.access_mutation_journal AS claim
  WHERE claim.tenant_id = p_tenant_id AND claim.legal_entity_id = p_legal_entity_id
    AND claim.access_mutation_id = p_claim_mutation_id AND claim.mutation_kind = 'CLAIM_INVITE'
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT stored.* INTO v_invitation
  FROM commerce_customer_context.counterparty_access_invitations AS stored
  WHERE stored.tenant_id = p_tenant_id AND stored.legal_entity_id = p_legal_entity_id
    AND stored.counterparty_access_invitation_id = v_claim.resource_id
    AND stored.counterparty_purchasing_profile_id = v_claim.counterparty_purchasing_profile_id
    AND stored.claimed_by_principal_id = v_claim.subject_principal_id
    AND stored.lifecycle IN ('CLAIMING', 'RECONCILIATION_REQUIRED', 'CLAIMED')
  FOR UPDATE;
  IF NOT FOUND OR v_invitation.lifecycle = 'CLAIMED' THEN RETURN; END IF;
  SELECT profile.counterparty_resource_id INTO v_counterparty_resource_id
  FROM commerce_customer_context.counterparty_purchasing_profiles AS profile
  WHERE profile.tenant_id = p_tenant_id AND profile.legal_entity_id = p_legal_entity_id
    AND profile.counterparty_purchasing_profile_id = v_claim.counterparty_purchasing_profile_id;

  IF p_compensate THEN
    FOR v_current_grant_id IN
      SELECT claim_grant.counterparty_commerce_access_grant_id
      FROM commerce_customer_context.counterparty_commerce_access_grants AS claim_grant
      WHERE claim_grant.tenant_id = p_tenant_id
        AND claim_grant.legal_entity_id = p_legal_entity_id
        AND claim_grant.counterparty_purchasing_profile_id = v_claim.counterparty_purchasing_profile_id
        AND claim_grant.principal_id = v_claim.subject_principal_id
        AND claim_grant.storefront_resource_id IS NOT DISTINCT FROM v_invitation.storefront_resource_id
        AND claim_grant.permission_code IN (
          SELECT permission.value
          FROM jsonb_array_elements_text(v_invitation.requested_permission_codes) AS permission(value)
        )
        AND claim_grant.lifecycle <> 'REVOKED'
        AND EXISTS (
          SELECT 1 FROM commerce_customer_context.access_mutation_journal AS origin
          WHERE origin.tenant_id = p_tenant_id AND origin.legal_entity_id = p_legal_entity_id
            AND origin.resource_id = claim_grant.counterparty_commerce_access_grant_id
            AND origin.mutation_kind = 'GRANT'
            AND origin.action_invocation_id = v_claim.action_invocation_id
        )
      FOR UPDATE OF claim_grant
    LOOP
      v_compensation_mutation_id := NULL;
      INSERT INTO commerce_customer_context.access_mutation_journal (
        tenant_id, legal_entity_id, counterparty_purchasing_profile_id, subject_principal_id,
        mutation_kind, resource_id, revision, safe_facts, actor_principal_id,
        action_invocation_id, reason
      ) VALUES (
        p_tenant_id, p_legal_entity_id, v_claim.counterparty_purchasing_profile_id,
        v_claim.subject_principal_id, 'REVOKE', v_current_grant_id, v_claim.revision,
        jsonb_build_object('requestedState', 'PENDING_REVOKE',
          'compensatesClaimMutationId', p_claim_mutation_id::text),
        v_claim.actor_principal_id, v_claim.action_invocation_id,
        'Compensate invitation claim after inviter authority was lost'
      ) ON CONFLICT (tenant_id, action_invocation_id, mutation_kind, resource_id) DO NOTHING
      RETURNING access_mutation_id INTO v_compensation_mutation_id;
      v_compensation_staged := v_compensation_mutation_id IS NOT NULL;
      IF v_compensation_mutation_id IS NULL THEN
        SELECT compensation.access_mutation_id INTO v_compensation_mutation_id
        FROM commerce_customer_context.access_mutation_journal AS compensation
        WHERE compensation.tenant_id = p_tenant_id
          AND compensation.legal_entity_id = p_legal_entity_id
          AND compensation.resource_id = v_current_grant_id
          AND compensation.mutation_kind = 'REVOKE'
          AND compensation.action_invocation_id = v_claim.action_invocation_id;
      END IF;
      UPDATE commerce_customer_context.counterparty_commerce_access_grants
        SET lifecycle = 'PENDING_REVOKE', revision = revision + 1
      WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
        AND counterparty_commerce_access_grant_id = v_current_grant_id
        AND lifecycle <> 'PENDING_REVOKE';
      PERFORM * FROM commerce_customer_context.transition_access_grant(
        p_tenant_id, p_legal_entity_id, v_current_grant_id, v_compensation_mutation_id,
        'revoke', 'RECONCILIATION_REQUIRED'
      );
      RETURN QUERY
      SELECT pending.*, v_compensation_staged
      FROM commerce_customer_context.read_access_reconciliation(
        p_tenant_id, p_legal_entity_id, v_compensation_mutation_id
      ) AS pending;
    END LOOP;
    RETURN;
  END IF;

  FOR v_permission IN
    SELECT permission.value
    FROM jsonb_array_elements_text(v_invitation.requested_permission_codes)
      WITH ORDINALITY AS permission(value, ordinality)
    ORDER BY permission.ordinality
  LOOP
    SELECT * INTO v_begin
    FROM commerce_customer_context.begin_access_grant(
      p_tenant_id, p_legal_entity_id, v_counterparty_resource_id,
      v_claim.subject_principal_id, v_permission, v_invitation.storefront_resource_id,
      v_claim.actor_principal_id, v_claim.action_invocation_id, v_claim.reason, false
    );
    IF v_begin.operation_outcome = 'PENDING_GRANT' AND v_begin.mutation_id IS NOT NULL THEN
      PERFORM * FROM commerce_customer_context.transition_access_grant(
        p_tenant_id, p_legal_entity_id, v_begin.grant_id, v_begin.mutation_id,
        'grant', 'RECONCILIATION_REQUIRED'
      );
      RETURN QUERY
      SELECT pending.*, v_begin.mutation_staged
      FROM commerce_customer_context.read_access_reconciliation(
        p_tenant_id, p_legal_entity_id, v_begin.mutation_id
      ) AS pending;
    ELSIF v_begin.operation_outcome = 'CONFLICT' THEN
      SELECT current_grant.counterparty_commerce_access_grant_id
        INTO v_current_grant_id
      FROM commerce_customer_context.counterparty_commerce_access_grants AS current_grant
      WHERE current_grant.tenant_id = p_tenant_id
        AND current_grant.legal_entity_id = p_legal_entity_id
        AND current_grant.counterparty_purchasing_profile_id = v_claim.counterparty_purchasing_profile_id
        AND current_grant.principal_id = v_claim.subject_principal_id
        AND current_grant.permission_code = v_permission
        AND current_grant.storefront_resource_id IS NOT DISTINCT FROM v_invitation.storefront_resource_id
        AND current_grant.lifecycle IN ('PENDING_REVOKE', 'RECONCILIATION_REQUIRED')
      ORDER BY current_grant.recorded_at DESC LIMIT 1;
      SELECT latest.access_mutation_id,
        CASE WHEN latest.mutation_kind = 'REVOKE' THEN 'revoke' ELSE 'grant' END
        INTO v_current_mutation_id, v_current_operation
      FROM commerce_customer_context.access_mutation_journal AS latest
      WHERE latest.tenant_id = p_tenant_id AND latest.legal_entity_id = p_legal_entity_id
        AND latest.resource_id = v_current_grant_id
      ORDER BY latest.recorded_at DESC, latest.access_mutation_id DESC LIMIT 1;
      RETURN QUERY
      SELECT pending.*, false
      FROM commerce_customer_context.read_access_reconciliation(
        p_tenant_id, p_legal_entity_id, v_current_mutation_id
      ) AS pending
      WHERE pending.recovery_operation = v_current_operation;
    END IF;
  END LOOP;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."stage_access_invitation_claim_grants"(uuid, uuid, uuid, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."stage_access_invitation_claim_grants"(uuid, uuid, uuid, boolean) TO "ontos_runtime";
--> statement-breakpoint

CREATE FUNCTION "commerce_customer_context"."finalize_reconciled_access_invitation"(
  p_tenant_id uuid, p_legal_entity_id uuid, p_claim_mutation_id uuid
)
RETURNS TABLE (
  claimed_at timestamptz, claimed_by_principal_id uuid, counterparty_resource_id text,
  created_at timestamptz, delivery_method text, delivery_reference text, expires_at timestamptz,
  grant_progress jsonb, invitation_id uuid, invited_by uuid, reason text,
  requested_permission_codes jsonb, revision integer, state text, storefront_resource_id text,
  attestation_reference text, claim_mutation_id uuid, source_action_invocation_id uuid,
  verified_at timestamptz, operation_outcome text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context
AS $function$
DECLARE
  v_claim commerce_customer_context.access_mutation_journal%ROWTYPE;
  v_invitation commerce_customer_context.counterparty_access_invitations%ROWTYPE;
  v_outcome text;
  v_permission_count integer;
  v_active_count integer;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'invalid scoped invitation reconciliation request' USING ERRCODE = '42501';
  END IF;
  SELECT claim.* INTO v_claim
  FROM commerce_customer_context.access_mutation_journal AS claim
  WHERE claim.tenant_id = p_tenant_id AND claim.legal_entity_id = p_legal_entity_id
    AND claim.access_mutation_id = p_claim_mutation_id AND claim.mutation_kind = 'CLAIM_INVITE'
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT stored.* INTO v_invitation
  FROM commerce_customer_context.counterparty_access_invitations AS stored
  WHERE stored.tenant_id = p_tenant_id AND stored.legal_entity_id = p_legal_entity_id
    AND stored.counterparty_access_invitation_id = v_claim.resource_id
    AND stored.counterparty_purchasing_profile_id = v_claim.counterparty_purchasing_profile_id
    AND stored.claimed_by_principal_id = v_claim.subject_principal_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_invitation.lifecycle = 'CLAIMED' THEN
    v_outcome := 'ALREADY_CLAIMED';
  ELSE
    SELECT jsonb_array_length(v_invitation.requested_permission_codes), count(active_grant.*)
      INTO v_permission_count, v_active_count
    FROM jsonb_array_elements_text(v_invitation.requested_permission_codes) AS permission(value)
    LEFT JOIN commerce_customer_context.counterparty_commerce_access_grants AS active_grant
      ON active_grant.tenant_id = p_tenant_id
      AND active_grant.legal_entity_id = p_legal_entity_id
      AND active_grant.counterparty_purchasing_profile_id = v_invitation.counterparty_purchasing_profile_id
      AND active_grant.principal_id = v_claim.subject_principal_id
      AND active_grant.permission_code = permission.value
      AND active_grant.storefront_resource_id IS NOT DISTINCT FROM v_invitation.storefront_resource_id
      AND active_grant.lifecycle = 'ACTIVE';
    IF v_invitation.lifecycle IN ('CLAIMING', 'RECONCILIATION_REQUIRED')
      AND v_active_count = v_permission_count THEN
      UPDATE commerce_customer_context.counterparty_access_invitations
        SET lifecycle = 'CLAIMED', claimed_at = statement_timestamp(), revision = revision + 1
      WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
        AND counterparty_access_invitation_id = v_invitation.counterparty_access_invitation_id;
      v_outcome := 'CLAIMED';
    ELSE
      UPDATE commerce_customer_context.counterparty_access_invitations
        SET lifecycle = 'RECONCILIATION_REQUIRED',
            revision = revision + CASE WHEN lifecycle = 'RECONCILIATION_REQUIRED' THEN 0 ELSE 1 END
      WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
        AND counterparty_access_invitation_id = v_invitation.counterparty_access_invitation_id
        AND lifecycle IN ('CLAIMING', 'RECONCILIATION_REQUIRED');
      v_outcome := 'PENDING_AUTHORIZATION';
    END IF;
  END IF;
  RETURN QUERY
  SELECT reconciled.claimed_at, reconciled.claimed_by_principal_id,
    reconciled.counterparty_resource_id, reconciled.created_at, reconciled.delivery_method,
    reconciled.delivery_reference, reconciled.expires_at, reconciled.grant_progress,
    reconciled.invitation_id, reconciled.invited_by, reconciled.reason,
    reconciled.requested_permission_codes, reconciled.revision, reconciled.state,
    reconciled.storefront_resource_id, reconciled.attestation_reference,
    reconciled.claim_mutation_id, reconciled.source_action_invocation_id,
    reconciled.verified_at, v_outcome
  FROM commerce_customer_context.read_access_invitation_claim_reconciliation(
    p_tenant_id, p_legal_entity_id, p_claim_mutation_id
  ) AS reconciled;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."finalize_reconciled_access_invitation"(uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."finalize_reconciled_access_invitation"(uuid, uuid, uuid) TO "ontos_runtime";
