-- Complete the exact durable authorization projection requested by a Retail Portal binding
-- Action.  The worker may repeat this routine after an ambiguous external acknowledgement: the
-- binding/action/revision tuple is checked before any owner mutation, and a completed tuple returns
-- the same terminal outcome without rewriting terminal intent rows.
CREATE OR REPLACE FUNCTION "commerce_customer_context"."finalize_retail_portal_binding_authorization"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_binding_id uuid,
  p_operation text,
  p_expected_revision integer,
  p_action_invocation_id uuid,
  p_effective_at timestamptz,
  p_reason text,
  p_actor_principal_id uuid
) RETURNS TABLE(outcome text, payload jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
DECLARE
  v_binding retail_portal_profile_bindings%ROWTYPE;
  v_pending_state text;
  v_terminal_state text;
  v_pending integer;
  v_terminal integer;
  v_conflicting integer;
  v_total integer;
  v_expected integer;
  v_distinct integer;
  v_outcome text;
  v_now timestamptz;
  v_effective_at timestamptz;
BEGIN
  PERFORM assert_profile_operation_scope(p_tenant_id,p_legal_entity_id);
  IF p_binding_id IS NULL OR p_operation NOT IN ('grant','revoke')
     OR p_expected_revision IS NULL OR p_action_invocation_id IS NULL
     OR p_effective_at IS NULL OR nullif(btrim(p_reason),'') IS NULL THEN
    RETURN QUERY SELECT 'AUTHORIZATION_UNAVAILABLE',NULL::jsonb;
    RETURN;
  END IF;

  SELECT * INTO v_binding
    FROM retail_portal_profile_bindings
   WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
     AND retail_portal_profile_binding_id=p_binding_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'BINDING_NOT_FOUND',NULL::jsonb;
    RETURN;
  END IF;

  -- The worker can only complete the exact pending Action transition it read.  These checks are
  -- deliberately before the intent counts and before either the intents or binding are updated.
  IF v_binding.revision IS DISTINCT FROM p_expected_revision
     OR v_binding.action_invocation_id IS DISTINCT FROM p_action_invocation_id
     OR v_binding.authorization_operation IS DISTINCT FROM p_operation
     OR (p_operation='grant' AND v_binding.lifecycle IS DISTINCT FROM 'ACTIVE')
     OR (p_operation='revoke' AND v_binding.lifecycle IS DISTINCT FROM 'REVOKED')
     OR (p_actor_principal_id IS NOT NULL
         AND v_binding.actor_principal_id IS DISTINCT FROM p_actor_principal_id) THEN
    RETURN QUERY SELECT 'AUTHORIZATION_CONFLICT',NULL::jsonb;
    RETURN;
  END IF;

  SELECT history.effective_at INTO v_effective_at
    FROM retail_portal_profile_binding_history history
   WHERE history.tenant_id=p_tenant_id AND history.legal_entity_id=p_legal_entity_id
     AND history.retail_portal_profile_binding_id=v_binding.retail_portal_profile_binding_id
     AND history.revision=v_binding.revision;
  v_effective_at := coalesce(v_effective_at, p_effective_at);

  v_pending_state:=CASE p_operation WHEN 'grant' THEN 'PENDING_GRANT' ELSE 'PENDING_REVOKE' END;
  v_terminal_state:=CASE p_operation WHEN 'grant' THEN 'ACTIVE' ELSE 'REVOKED' END;
  SELECT count(*),count(*) FILTER (WHERE intent.state=v_pending_state),
         count(*) FILTER (WHERE intent.state=v_terminal_state),
         count(*) FILTER (WHERE intent.state NOT IN (v_pending_state,v_terminal_state)),
         count(*) FILTER (WHERE intent.permission_code IN (
           'retail.profile.read','retail.address_book.use','retail.address_book.manage',
           'retail.history.read','retail.repeat_order','retail.aftercare.read',
           'retail.claim.create','retail.consent.manage'))
         ,count(DISTINCT intent.permission_code)
    INTO v_total,v_pending,v_terminal,v_conflicting,v_expected,v_distinct
    FROM retail_portal_profile_binding_permission_mutations intent
   WHERE intent.tenant_id=p_tenant_id AND intent.legal_entity_id=p_legal_entity_id
     AND intent.retail_portal_profile_binding_id=p_binding_id
     AND intent.action_invocation_id=p_action_invocation_id
     AND intent.operation=p_operation;
  IF v_total<>8 OR v_expected<>8 OR v_distinct<>8 OR v_conflicting<>0 THEN
    RETURN QUERY SELECT 'AUTHORIZATION_UNAVAILABLE',NULL::jsonb;
    RETURN;
  END IF;

  IF v_pending=0 AND v_terminal=8 AND v_binding.authorization_state=v_terminal_state THEN
    v_outcome:='AUTHORIZATION_ALREADY_FINAL';
  ELSE
    IF v_binding.authorization_state IS DISTINCT FROM v_pending_state
       OR (v_pending=0 AND v_terminal<>8) THEN
      RETURN QUERY SELECT 'AUTHORIZATION_CONFLICT',NULL::jsonb;
      RETURN;
    END IF;
    UPDATE retail_portal_profile_binding_permission_mutations intent
       SET state=v_terminal_state, revision=intent.revision+1,
           finalized_at=v_effective_at
     WHERE intent.tenant_id=p_tenant_id AND intent.legal_entity_id=p_legal_entity_id
       AND intent.retail_portal_profile_binding_id=p_binding_id
       AND intent.action_invocation_id=p_action_invocation_id
       AND intent.operation=p_operation
       AND intent.state=v_pending_state;
    UPDATE retail_portal_profile_bindings
       SET authorization_state=v_terminal_state, updated_at=clock_timestamp()
     WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
       AND retail_portal_profile_binding_id=p_binding_id;
    v_outcome:='AUTHORIZATION_FINALIZED';
    v_now:=clock_timestamp();
  END IF;
  RETURN QUERY SELECT v_outcome,jsonb_build_object(
    'authorizationOperation',p_operation,
    'authorizationState',v_terminal_state,
    'bindingId',v_binding.retail_portal_profile_binding_id,
    'profileId',v_binding.retail_customer_profile_id,
    'principalId',v_binding.principal_id,
    'operation',p_operation,
    'revision',v_binding.revision,
    'effectiveAt',to_char(v_effective_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt',to_char(coalesce(v_now,v_effective_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END
$routine$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."finalize_retail_portal_binding_authorization"(uuid,uuid,uuid,text,integer,uuid,timestamptz,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."finalize_retail_portal_binding_authorization"(uuid,uuid,uuid,text,integer,uuid,timestamptz,text,uuid) TO "ontos_runtime";
