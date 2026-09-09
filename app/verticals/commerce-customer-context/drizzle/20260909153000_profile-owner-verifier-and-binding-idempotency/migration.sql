-- BIND/RECOVER/REVOKE changes only the explicit Principal-to-Profile relation.  The authorization
-- state is staged durably in the owner row and one immutable intent row per reviewed baseline
-- Permission; the worker finalizes those intents after the external relationship write.
-- Bindings created before the authorization intent journal existed are not trusted as Current.
-- Preserve their explicit lifecycle for reads, but require an owner Action to restage an exact
-- grant/revoke intent set before any Retail Portal Permission can be considered usable.
UPDATE "commerce_customer_context"."retail_portal_profile_bindings" binding
   SET authorization_operation=CASE WHEN binding.lifecycle='REVOKED' THEN 'revoke' ELSE 'grant' END,
       authorization_state='RECONCILIATION_REQUIRED'
 WHERE (
   SELECT count(*)
     FROM "commerce_customer_context"."retail_portal_profile_binding_permission_mutations" intent
    WHERE intent.tenant_id=binding.tenant_id
      AND intent.legal_entity_id=binding.legal_entity_id
      AND intent.retail_portal_profile_binding_id=binding.retail_portal_profile_binding_id
      AND intent.action_invocation_id=binding.action_invocation_id
      AND intent.operation=CASE WHEN binding.lifecycle='REVOKED' THEN 'revoke' ELSE 'grant' END
 ) <> 8;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "commerce_customer_context"."mutate_retail_portal_binding"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_profile_id uuid,
  p_principal_id uuid,
  p_auth_binding_id uuid,
  p_enrollment_evidence_ref text,
  p_expected_state text,
  p_expected_revision integer,
  p_operation text,
  p_effective_at timestamptz,
  p_reason text,
  p_action_invocation_id uuid,
  p_actor_principal_id uuid
) RETURNS TABLE(outcome text, payload jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
DECLARE
  v_binding retail_portal_profile_bindings%ROWTYPE;
  v_profile_state text;
  v_next_state text;
  v_next_revision integer;
  v_existing boolean := false;
  v_pending boolean := false;
  v_inserted_count integer := 0;
  v_permission_mutations jsonb := '[]'::jsonb;
  v_authorization_operation text;
  v_authorization_state text;
  v_effective_at timestamptz;
  v_previous_state text;
  v_idempotent boolean := false;
BEGIN
  PERFORM assert_profile_operation_scope(p_tenant_id, p_legal_entity_id);
  IF p_action_invocation_id IS NULL OR p_actor_principal_id IS NULL OR p_auth_binding_id IS NULL
     OR p_profile_id IS NULL OR p_principal_id IS NULL OR p_effective_at IS NULL
     OR nullif(btrim(p_enrollment_evidence_ref), '') IS NULL OR nullif(btrim(p_reason), '') IS NULL
     OR p_operation IS NULL OR p_operation NOT IN ('BIND','RECOVER','REVOKE') THEN
    RETURN QUERY SELECT 'ENROLLMENT_EVIDENCE_INSUFFICIENT', NULL::jsonb;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text || ':' || p_legal_entity_id::text || ':binding:' ||
    p_profile_id::text || ':' || p_principal_id::text, 0));

  SELECT cp.lifecycle INTO v_profile_state
    FROM retail_customer_profiles rp
    JOIN customer_profiles cp
      ON cp.tenant_id=rp.tenant_id AND cp.legal_entity_id=rp.legal_entity_id
     AND cp.customer_profile_id=rp.retail_customer_profile_id
   WHERE rp.tenant_id=p_tenant_id AND rp.legal_entity_id=p_legal_entity_id
     AND rp.retail_customer_profile_id=p_profile_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'PROFILE_NOT_FOUND', NULL::jsonb;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM profile_reconciliation_case_members member
      JOIN profile_reconciliation_cases reconciliation
        USING (tenant_id, legal_entity_id, profile_reconciliation_case_id)
     WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
       AND member.customer_profile_id=p_profile_id AND reconciliation.lifecycle<>'COMPLETED'
  ) THEN
    RETURN QUERY SELECT 'CURRENT_STATE_CONFLICT', NULL::jsonb;
    RETURN;
  END IF;
  IF p_operation IN ('BIND','RECOVER') AND v_profile_state <> 'ACTIVE' THEN
    RETURN QUERY SELECT 'PROFILE_NOT_ACTIVE', NULL::jsonb;
    RETURN;
  END IF;

  SELECT * INTO v_binding
    FROM retail_portal_profile_bindings
   WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
     AND retail_customer_profile_id=p_profile_id AND principal_id=p_principal_id
  ORDER BY revision DESC, created_at DESC
  LIMIT 1
  FOR UPDATE;
  v_existing := FOUND;

  IF v_existing
     AND v_binding.authorization_state IN ('PENDING_GRANT','PENDING_REVOKE','RECONCILIATION_REQUIRED')
     AND v_binding.action_invocation_id IS DISTINCT FROM p_action_invocation_id THEN
    RETURN QUERY SELECT 'BINDING_CONFLICT', NULL::jsonb;
    RETURN;
  END IF;

  -- A retried Action must reuse the exact owner transition.  The idempotency key is not a
  -- substitute for the target tuple: a replay with a different Principal, auth binding, or
  -- evidence remains a conflict even when it happens to reuse the same UUID.
  IF v_existing
     AND p_operation <> 'BIND'
     AND v_binding.action_invocation_id = p_action_invocation_id
     AND v_binding.auth_binding_id = p_auth_binding_id
     AND v_binding.enrollment_evidence_ref = btrim(p_enrollment_evidence_ref)
     AND ((p_operation='RECOVER' AND v_binding.lifecycle='ACTIVE'
           AND v_binding.authorization_operation='grant'
           AND v_binding.authorization_state IN ('PENDING_GRANT','ACTIVE','RECONCILIATION_REQUIRED'))
       OR (p_operation='REVOKE' AND v_binding.lifecycle='REVOKED'
           AND v_binding.authorization_operation='revoke'
           AND v_binding.authorization_state IN ('PENDING_REVOKE','REVOKED','RECONCILIATION_REQUIRED'))) THEN
    v_idempotent := true;
    v_next_state := v_binding.lifecycle;
    v_next_revision := v_binding.revision;
    SELECT history.effective_at INTO v_effective_at
      FROM retail_portal_profile_binding_history history
     WHERE history.tenant_id=p_tenant_id AND history.legal_entity_id=p_legal_entity_id
       AND history.retail_portal_profile_binding_id=v_binding.retail_portal_profile_binding_id
       AND history.revision=v_binding.revision;
    v_effective_at := coalesce(v_effective_at, p_effective_at);
  END IF;

  IF p_operation = 'BIND' THEN
    IF p_expected_state IS NOT NULL OR p_expected_revision IS NOT NULL THEN
      RETURN QUERY SELECT 'CURRENT_STATE_CONFLICT', NULL::jsonb;
      RETURN;
    END IF;
    IF v_existing THEN
      IF v_binding.lifecycle='ACTIVE'
         AND v_binding.auth_binding_id=p_auth_binding_id
         AND v_binding.enrollment_evidence_ref=btrim(p_enrollment_evidence_ref)
         AND v_binding.authorization_operation='grant'
         AND v_binding.authorization_state IN ('PENDING_GRANT','ACTIVE','RECONCILIATION_REQUIRED')
         AND v_binding.action_invocation_id=p_action_invocation_id THEN
        v_next_state := 'ACTIVE';
        v_next_revision := v_binding.revision;
        SELECT history.effective_at INTO v_effective_at
          FROM retail_portal_profile_binding_history history
         WHERE history.tenant_id=p_tenant_id AND history.legal_entity_id=p_legal_entity_id
           AND history.retail_portal_profile_binding_id=v_binding.retail_portal_profile_binding_id
           AND history.revision=v_binding.revision;
        v_effective_at := coalesce(v_effective_at, p_effective_at);
      ELSE
        RETURN QUERY SELECT 'BINDING_CONFLICT', NULL::jsonb;
        RETURN;
      END IF;
    ELSE
      INSERT INTO retail_portal_profile_bindings(
        tenant_id, legal_entity_id, retail_customer_profile_id, principal_id, auth_binding_id,
        enrollment_evidence_ref, lifecycle, authorization_operation, authorization_state,
        revision, revoked_at, action_invocation_id, actor_principal_id, reason
      ) VALUES (
        p_tenant_id,p_legal_entity_id,p_profile_id,p_principal_id,p_auth_binding_id,
        btrim(p_enrollment_evidence_ref),'ACTIVE','grant','PENDING_GRANT',
        1,NULL,p_action_invocation_id,p_actor_principal_id,btrim(p_reason)
      ) RETURNING * INTO v_binding;
      v_next_state := 'ACTIVE';
      v_next_revision := 1;
      INSERT INTO retail_portal_profile_binding_history(
        tenant_id,legal_entity_id,retail_portal_profile_binding_id,revision,from_lifecycle,
        to_lifecycle,effective_at,enrollment_evidence_ref,action_invocation_id,actor_principal_id,reason
      ) VALUES (
        p_tenant_id,p_legal_entity_id,v_binding.retail_portal_profile_binding_id,1,NULL,'ACTIVE',
        p_effective_at,btrim(p_enrollment_evidence_ref),p_action_invocation_id,p_actor_principal_id,btrim(p_reason)
      );
    END IF;
  ELSE
    IF NOT v_existing THEN
      RETURN QUERY SELECT 'BINDING_NOT_FOUND', NULL::jsonb;
      RETURN;
    END IF;
    IF NOT v_idempotent THEN
      IF v_binding.auth_binding_id IS DISTINCT FROM p_auth_binding_id
         OR v_binding.lifecycle IS DISTINCT FROM p_expected_state
         OR v_binding.revision IS DISTINCT FROM p_expected_revision THEN
        RETURN QUERY SELECT CASE
          WHEN v_binding.auth_binding_id IS DISTINCT FROM p_auth_binding_id THEN 'BINDING_CONFLICT'
          ELSE 'CURRENT_STATE_CONFLICT' END, NULL::jsonb;
        RETURN;
      END IF;
      IF (p_operation='RECOVER' AND p_expected_state<>'REVOKED')
         OR (p_operation='REVOKE' AND p_expected_state<>'ACTIVE') THEN
        RETURN QUERY SELECT 'CURRENT_STATE_CONFLICT', NULL::jsonb;
        RETURN;
      END IF;
      v_previous_state := v_binding.lifecycle;
      v_next_state := CASE p_operation WHEN 'RECOVER' THEN 'ACTIVE' ELSE 'REVOKED' END;
      v_next_revision := v_binding.revision + 1;
      UPDATE retail_portal_profile_bindings
         SET lifecycle=v_next_state,
             authorization_operation=CASE WHEN p_operation='REVOKE' THEN 'revoke' ELSE 'grant' END,
             authorization_state=CASE WHEN p_operation='REVOKE' THEN 'PENDING_REVOKE' ELSE 'PENDING_GRANT' END,
             revision=v_next_revision,
             revoked_at=CASE WHEN v_next_state='REVOKED' THEN p_effective_at ELSE NULL END,
             enrollment_evidence_ref=btrim(p_enrollment_evidence_ref),
             action_invocation_id=p_action_invocation_id,
             actor_principal_id=p_actor_principal_id,
             reason=btrim(p_reason),
             updated_at=clock_timestamp()
       WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
         AND retail_portal_profile_binding_id=v_binding.retail_portal_profile_binding_id
       RETURNING * INTO v_binding;
      v_effective_at := p_effective_at;
      INSERT INTO retail_portal_profile_binding_history(
        tenant_id,legal_entity_id,retail_portal_profile_binding_id,revision,from_lifecycle,
        to_lifecycle,effective_at,enrollment_evidence_ref,action_invocation_id,actor_principal_id,reason
      ) VALUES (
        p_tenant_id,p_legal_entity_id,v_binding.retail_portal_profile_binding_id,v_next_revision,
        v_previous_state,v_next_state,p_effective_at,btrim(p_enrollment_evidence_ref),
        p_action_invocation_id,p_actor_principal_id,btrim(p_reason));
    END IF;
  END IF;

  v_effective_at := coalesce(v_effective_at, p_effective_at);

  v_pending := v_binding.authorization_state IN ('PENDING_GRANT','PENDING_REVOKE','RECONCILIATION_REQUIRED');
  IF v_pending THEN
    v_authorization_operation := v_binding.authorization_operation;
    v_authorization_state := v_binding.authorization_state;
    INSERT INTO retail_portal_profile_binding_permission_mutations(
      tenant_id, legal_entity_id, retail_portal_profile_binding_id, retail_customer_profile_id,
      principal_id, permission_code, operation, state, revision, finalized_at,
      action_invocation_id, actor_principal_id, reason
    )
    SELECT
      p_tenant_id, p_legal_entity_id, v_binding.retail_portal_profile_binding_id,
      v_binding.retail_customer_profile_id, v_binding.principal_id, permission_code,
      v_authorization_operation, v_authorization_state, 1, NULL,
      p_action_invocation_id, p_actor_principal_id, btrim(p_reason)
    FROM unnest(ARRAY[
      'retail.profile.read',
      'retail.address_book.use',
      'retail.address_book.manage',
      'retail.history.read',
      'retail.repeat_order',
      'retail.aftercare.read',
      'retail.claim.create',
      'retail.consent.manage'
    ]::text[]) AS baseline(permission_code)
    ON CONFLICT (
      tenant_id, legal_entity_id, retail_portal_profile_binding_id,
      action_invocation_id, operation, permission_code
    ) DO NOTHING;
    GET DIAGNOSTICS v_inserted_count = ROW_COUNT;
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'mutationId', mutation.retail_portal_profile_binding_permission_mutation_id,
      'operation', mutation.operation,
      'permission', mutation.permission_code,
      'staged', (v_inserted_count > 0),
      'state', mutation.state
    ) ORDER BY mutation.permission_code), '[]'::jsonb)
      INTO v_permission_mutations
      FROM retail_portal_profile_binding_permission_mutations mutation
     WHERE mutation.tenant_id=p_tenant_id AND mutation.legal_entity_id=p_legal_entity_id
       AND mutation.retail_portal_profile_binding_id=v_binding.retail_portal_profile_binding_id
       AND mutation.action_invocation_id=p_action_invocation_id
       AND mutation.operation=v_authorization_operation;
  END IF;

  RETURN QUERY SELECT
    CASE p_operation WHEN 'BIND' THEN 'BINDING_ACTIVATED'
                    WHEN 'RECOVER' THEN 'BINDING_RECOVERED'
                    ELSE 'BINDING_REVOKED' END,
    jsonb_build_object(
      'bindingRef',jsonb_build_object(
        'moduleId','commerce.customer-context',
        'resourceId',v_binding.retail_portal_profile_binding_id,
        'resourceType','commerce.customer-context.retail-portal-profile-binding',
        'tenantId',p_tenant_id),
      'effectiveAt',to_char(v_effective_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'outcome',CASE p_operation WHEN 'BIND' THEN 'BINDING_ACTIVATED'
                                 WHEN 'RECOVER' THEN 'BINDING_RECOVERED'
                                 ELSE 'BINDING_REVOKED' END,
      'revision',v_next_revision,
      'state',v_binding.lifecycle,
      'authorizationOperation',v_binding.authorization_operation,
      'authorizationState',v_binding.authorization_state
    ) || CASE WHEN v_pending
      THEN jsonb_build_object(
        'authorizationMutationId',p_action_invocation_id,
        'permissionMutations',v_permission_mutations
      )
      ELSE '{}'::jsonb END;
END
$routine$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."mutate_retail_portal_binding"(uuid,uuid,uuid,uuid,uuid,text,text,integer,text,timestamptz,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."mutate_retail_portal_binding"(uuid,uuid,uuid,uuid,uuid,text,text,integer,text,timestamptz,text,uuid,uuid) TO "ontos_runtime";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "commerce_customer_context"."read_retail_portal_binding"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_binding_id uuid,
  p_requesting_principal_id uuid
) RETURNS TABLE(outcome text, payload jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
DECLARE
  v_binding retail_portal_profile_bindings%ROWTYPE;
  v_case_id uuid;
BEGIN
  PERFORM assert_profile_operation_scope(p_tenant_id,p_legal_entity_id);
  SELECT * INTO v_binding
    FROM retail_portal_profile_bindings
   WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
     AND retail_portal_profile_binding_id=p_binding_id
     AND principal_id=p_requesting_principal_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'BINDING_NOT_FOUND',NULL::jsonb;
    RETURN;
  END IF;
  SELECT reconciliation.profile_reconciliation_case_id INTO v_case_id
    FROM profile_reconciliation_case_members member
    JOIN profile_reconciliation_cases reconciliation
      USING (tenant_id,legal_entity_id,profile_reconciliation_case_id)
   WHERE member.tenant_id=p_tenant_id AND member.legal_entity_id=p_legal_entity_id
     AND member.customer_profile_id=v_binding.retail_customer_profile_id
     AND reconciliation.lifecycle<>'COMPLETED'
   ORDER BY reconciliation.recorded_at
   LIMIT 1;
  IF v_case_id IS NOT NULL THEN
    RETURN QUERY SELECT 'BINDING_RECONCILIATION_REQUIRED',jsonb_build_object(
      'bindingId',p_binding_id,'profileId',v_binding.retail_customer_profile_id,'caseId',v_case_id,
      'observedAt',to_char(v_binding.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'revision',v_binding.revision);
    RETURN;
  END IF;
  RETURN QUERY SELECT 'BINDING_AVAILABLE',jsonb_build_object(
    'actorPrincipalId',v_binding.actor_principal_id,
    'actionInvocationId',v_binding.action_invocation_id,
    'authorizationMutationId',v_binding.action_invocation_id,
    'authorizationOperation',v_binding.authorization_operation,
    'authorizationState',v_binding.authorization_state,
    'bindingId',v_binding.retail_portal_profile_binding_id,
    'profileId',v_binding.retail_customer_profile_id,
    'principalId',v_binding.principal_id,
    'enrollmentEvidenceRef',v_binding.enrollment_evidence_ref,
    'state',v_binding.lifecycle,
    'revision',v_binding.revision,
    'revokedAt',CASE WHEN v_binding.revoked_at IS NULL THEN NULL ELSE to_char(v_binding.revoked_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'createdAt',to_char(v_binding.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt',to_char(v_binding.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'reason',coalesce(v_binding.reason,'Binding transition recorded'));
END
$routine$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."read_retail_portal_binding"(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_retail_portal_binding"(uuid,uuid,uuid,uuid) TO "ontos_runtime";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "commerce_customer_context"."read_retail_portal_binding_authorization"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_binding_id uuid,
  p_operation text
) RETURNS TABLE(outcome text, payload jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
DECLARE
  v_binding retail_portal_profile_bindings%ROWTYPE;
  v_expected_operation text;
  v_expected_pending text;
  v_expected_terminal text;
  v_total integer;
  v_pending integer;
  v_terminal integer;
  v_conflicting integer;
  v_expected integer;
  v_distinct integer;
BEGIN
  PERFORM assert_profile_operation_scope(p_tenant_id,p_legal_entity_id);
  IF p_binding_id IS NULL OR p_operation NOT IN ('grant','revoke') THEN
    RETURN QUERY SELECT 'AUTHORIZATION_UNAVAILABLE',NULL::jsonb;
    RETURN;
  END IF;
  SELECT * INTO v_binding
    FROM retail_portal_profile_bindings
   WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
     AND retail_portal_profile_binding_id=p_binding_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'BINDING_NOT_FOUND',NULL::jsonb;
    RETURN;
  END IF;
  v_expected_operation:=p_operation;
  v_expected_pending:=CASE p_operation WHEN 'grant' THEN 'PENDING_GRANT' ELSE 'PENDING_REVOKE' END;
  v_expected_terminal:=CASE p_operation WHEN 'grant' THEN 'ACTIVE' ELSE 'REVOKED' END;
  IF v_binding.authorization_operation IS DISTINCT FROM v_expected_operation
     OR (p_operation='grant' AND v_binding.lifecycle IS DISTINCT FROM 'ACTIVE')
     OR (p_operation='revoke' AND v_binding.lifecycle IS DISTINCT FROM 'REVOKED')
     OR v_binding.authorization_state NOT IN (v_expected_pending,v_expected_terminal,'RECONCILIATION_REQUIRED') THEN
    RETURN QUERY SELECT 'AUTHORIZATION_CONFLICT',NULL::jsonb;
    RETURN;
  END IF;
  SELECT count(*),
         count(*) FILTER (WHERE intent.state=v_expected_pending),
         count(*) FILTER (WHERE intent.state=v_expected_terminal),
         count(*) FILTER (WHERE intent.state NOT IN (v_expected_pending,v_expected_terminal,'RECONCILIATION_REQUIRED')),
         count(*) FILTER (WHERE intent.permission_code IN (
           'retail.profile.read','retail.address_book.use','retail.address_book.manage',
           'retail.history.read','retail.repeat_order','retail.aftercare.read',
           'retail.claim.create','retail.consent.manage'))
         ,count(DISTINCT intent.permission_code)
    INTO v_total,v_pending,v_terminal,v_conflicting,v_expected,v_distinct
    FROM retail_portal_profile_binding_permission_mutations intent
   WHERE intent.tenant_id=p_tenant_id AND intent.legal_entity_id=p_legal_entity_id
     AND intent.retail_portal_profile_binding_id=p_binding_id
     AND intent.action_invocation_id=v_binding.action_invocation_id
     AND intent.operation=v_expected_operation;
  IF v_total<>8 OR v_expected<>8 OR v_distinct<>8 OR v_conflicting<>0 THEN
    RETURN QUERY SELECT 'AUTHORIZATION_UNAVAILABLE',NULL::jsonb;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'AUTHORIZATION_AVAILABLE',jsonb_build_object(
    'authorizationOperation',v_binding.authorization_operation,
    'authorizationState',v_binding.authorization_state,
    'bindingId',v_binding.retail_portal_profile_binding_id,
    'profileId',v_binding.retail_customer_profile_id,
    'principalId',v_binding.principal_id,
    'operation',v_expected_operation,
    'pendingCount',v_pending,
    'terminalCount',v_terminal,
    'revision',v_binding.revision,
    'updatedAt',to_char(v_binding.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END
$routine$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."read_retail_portal_binding_authorization"(uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_retail_portal_binding_authorization"(uuid,uuid,uuid,text) TO "ontos_runtime";
--> statement-breakpoint
