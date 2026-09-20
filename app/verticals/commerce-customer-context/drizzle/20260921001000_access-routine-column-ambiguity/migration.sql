-- Every routine below declares an output column whose name is also a table column it writes:
-- `revision` in each `SET revision = revision + 1`, and `action_invocation_id` in each
-- `ON CONFLICT (tenant_id, action_invocation_id, ...)` inference list. PL/pgSQL refused those
-- references as ambiguous (42702), so the branches failed the first time they ran, and an
-- inference list cannot be table-qualified. `#variable_conflict use_column` states the intent
-- these routines already had: a name that can be a column is the column. No routine here reads
-- one of its own output parameters, so nothing else changes.
CREATE OR REPLACE FUNCTION "commerce_customer_context"."begin_access_grant"(
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
#variable_conflict use_column
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
CREATE OR REPLACE FUNCTION "commerce_customer_context"."begin_access_revoke"(
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
#variable_conflict use_column
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
CREATE OR REPLACE FUNCTION "commerce_customer_context"."transition_access_grant"(
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
#variable_conflict use_column
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
CREATE OR REPLACE FUNCTION "commerce_customer_context"."stage_access_invitation_claim_grants"(
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
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
#variable_conflict use_column
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
    AND coalesce(stored.claimed_by_principal_id, stored.claim_origin_principal_id)
      = v_claim.subject_principal_id
    AND stored.lifecycle IN ('CLAIMING', 'RECONCILIATION_REQUIRED', 'CLAIMED', 'REVOKED')
  FOR UPDATE;
  -- CLAIMED is terminal and must never be mutated; REVOKED remains readable only for the
  -- compensation branch so a revoke/claim race cannot strand its claim-created tuples.
  IF NOT FOUND OR v_invitation.lifecycle = 'CLAIMED'
     OR (v_invitation.lifecycle = 'REVOKED' AND NOT p_compensate) THEN
    RETURN;
  END IF;
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
CREATE OR REPLACE FUNCTION "commerce_customer_context"."finalize_reconciled_access_invitation"(
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
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $function$
#variable_conflict use_column
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
    AND coalesce(stored.claimed_by_principal_id, stored.claim_origin_principal_id)
      = v_claim.subject_principal_id
  FOR UPDATE;
  IF NOT FOUND OR v_invitation.lifecycle = 'REVOKED' THEN
    -- A revoked claim is compensation-only; never promote it or turn a revoke into a claim.
    RETURN;
  END IF;
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
