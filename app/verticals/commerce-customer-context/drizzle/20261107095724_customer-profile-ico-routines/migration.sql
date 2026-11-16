-- Custom SQL migration file, put your code below! --
ALTER TABLE commerce_customer_context.customer_profile_ico_assertions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE commerce_customer_context.customer_profile_ico_authority FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON commerce_customer_context.customer_profile_ico_assertions, commerce_customer_context.customer_profile_ico_authority FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.customer_profile_ico_state(p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb)
RETURNS TABLE (outcome text, result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET row_security = on
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $$
DECLARE
  v_profile commerce_customer_context.customer_profiles%ROWTYPE;
  v_id uuid := (p_input->'profileRef'->>'resourceId')::uuid;
  v_history jsonb;
  v_current jsonb;
  v_authority commerce_customer_context.customer_profile_ico_authority%ROWTYPE;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
     OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
     OR p_input->'profileRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text THEN
    RETURN QUERY SELECT 'PROFILE_NOT_FOUND', NULL::jsonb; RETURN;
  END IF;
  SELECT * INTO v_profile FROM commerce_customer_context.customer_profiles
    WHERE tenant_id=p_tenant_id AND customer_profile_id=v_id
    AND profile_kind=p_input->'profileRef'->>'kind'
    AND (profile_kind='COUNTERPARTY' OR legal_entity_id=p_legal_entity_id);
  IF NOT FOUND OR NOT (
    (v_profile.profile_kind='RETAIL' AND EXISTS (
      SELECT 1 FROM commerce_customer_context.retail_customer_profiles WHERE tenant_id=p_tenant_id
      AND retail_customer_profile_id=v_id AND legal_entity_id=p_legal_entity_id
      AND party_resource_id=p_input->'authorizationSubject'->'partyRef'->>'resourceId'
      AND p_input->'authorizationSubject'->'sellingLegalEntityRef'->>'resourceId'=p_legal_entity_id::text))
    OR (v_profile.profile_kind='COUNTERPARTY' AND EXISTS (
      SELECT 1 FROM commerce_customer_context.counterparty_purchasing_profiles WHERE tenant_id=p_tenant_id
      AND counterparty_purchasing_profile_id=v_id
      AND counterparty_resource_id=p_input->'authorizationSubject'->'counterpartyRef'->>'resourceId'))
  ) THEN RETURN QUERY SELECT 'PROFILE_NOT_FOUND', NULL::jsonb; RETURN; END IF;
  SELECT * INTO v_authority FROM commerce_customer_context.customer_profile_ico_authority WHERE tenant_id=p_tenant_id;
  IF NOT FOUND OR v_authority.phase <> 'COMMERCE' OR coalesce(v_authority.plan->'migrationRequiredProfileIds','[]'::jsonb) ? v_id::text THEN
    RETURN QUERY SELECT 'MIGRATION_REQUIRED', jsonb_build_object('_tag','MIGRATION_REQUIRED','profileRef',p_input->'profileRef'); RETURN;
  END IF;
  SELECT coalesce(jsonb_agg(assertion ORDER BY revision),'[]'::jsonb) INTO v_history
    FROM commerce_customer_context.customer_profile_ico_assertions WHERE tenant_id=p_tenant_id AND customer_profile_id=v_id;
  SELECT assertion INTO v_current FROM commerce_customer_context.customer_profile_ico_assertions
    WHERE tenant_id=p_tenant_id AND customer_profile_id=v_id AND effective_at<=coalesce((p_input->>'asOf')::timestamptz,current_timestamp)
    ORDER BY revision DESC LIMIT 1;
  IF v_current->>'operation'='END' THEN v_current:=NULL;END IF;
  RETURN QUERY SELECT 'AVAILABLE', jsonb_build_object('_tag',CASE WHEN v_current IS NULL THEN 'ABSENT' ELSE 'PRESENT' END,
    'profileRef',p_input->'profileRef','current',v_current,'history',v_history,'revision',jsonb_array_length(v_history));
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.customer_profile_ico_state(uuid,uuid,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.customer_profile_ico_state(uuid,uuid,jsonb) TO ontos_runtime;
--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.change_customer_profile_ico(p_tenant_id uuid, p_legal_entity_id uuid, p_principal_id uuid, p_invocation_id uuid, p_recorded_at timestamptz, p_input jsonb)
RETURNS TABLE (outcome text, result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET row_security = on
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $$
DECLARE
  v_id uuid := (p_input->'profileRef'->>'resourceId')::uuid;
  v_state record;
  v_prior commerce_customer_context.customer_profile_ico_assertions%ROWTYPE;
  v_latest commerce_customer_context.customer_profile_ico_assertions%ROWTYPE;
  v_revision integer;
  v_current boolean;
  v_assertion jsonb;
  v_result jsonb;
  v_effective_at timestamptz := (p_input->>'effectiveAt')::timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('ccc.profile-ico:'||p_tenant_id::text,0));
  SELECT * INTO v_state FROM commerce_customer_context.customer_profile_ico_state(p_tenant_id,p_legal_entity_id,p_input);
  IF v_state.outcome <> 'AVAILABLE' THEN RETURN QUERY SELECT v_state.outcome,NULL::jsonb; RETURN; END IF;
  PERFORM 1 FROM commerce_customer_context.customer_profiles WHERE tenant_id=p_tenant_id AND customer_profile_id=v_id AND lifecycle='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'PROFILE_INELIGIBLE',NULL::jsonb; RETURN; END IF;
  SELECT * INTO v_prior FROM commerce_customer_context.customer_profile_ico_assertions WHERE tenant_id=p_tenant_id AND effect_id=p_input->>'effectId';
  IF FOUND THEN
    IF v_prior.intent IS DISTINCT FROM p_input THEN RETURN QUERY SELECT 'EFFECT_CONFLICT',NULL::jsonb; RETURN; END IF;
    RETURN QUERY SELECT 'REPLAY',jsonb_build_object('outcome','REPLAY','profileRef',p_input->'profileRef','assertion',v_prior.assertion); RETURN;
  END IF;
  SELECT * INTO v_latest FROM commerce_customer_context.customer_profile_ico_assertions WHERE tenant_id=p_tenant_id AND customer_profile_id=v_id ORDER BY revision DESC LIMIT 1;
  v_revision := coalesce(v_latest.revision,0);
  IF v_revision <> (p_input->>'expectedRevision')::integer THEN RETURN QUERY SELECT 'REVISION_CONFLICT',NULL::jsonb; RETURN; END IF;
  v_current := coalesce(v_latest.is_current,false);
  IF v_effective_at > p_recorded_at OR (v_latest.effective_at IS NOT NULL AND v_effective_at < v_latest.effective_at)
    OR (p_input->>'operation'='SET' AND v_current)
    OR (p_input->>'operation' IN ('CORRECT','END') AND NOT v_current) THEN
    RETURN QUERY SELECT 'INVALID_TRANSITION',NULL::jsonb; RETURN;
  END IF;
  v_assertion := jsonb_build_object('actorPrincipalId',p_principal_id::text,'effectId',p_input->>'effectId',
    'effectiveAt',p_input->>'effectiveAt','normalizedValue',CASE WHEN p_input->>'operation'='END' THEN NULL ELSE p_input->>'normalizedValue' END,
    'normalizerVersion','CZ:ICO:party-v1','operation',p_input->>'operation',
    'originalInput',p_input->>'originalInput','provenance',p_input->'provenance','reason',p_input->>'reason',
    'recordedAt',to_char(p_recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'revision',v_revision+1);
  UPDATE commerce_customer_context.customer_profile_ico_assertions SET is_current=false,effective_to=v_effective_at
    WHERE tenant_id=p_tenant_id AND customer_profile_id=v_id AND is_current;
  INSERT INTO commerce_customer_context.customer_profile_ico_assertions(tenant_id,customer_profile_id,revision,effect_id,is_current,effective_at,normalized_value,assertion,intent,action_invocation_id,actor_principal_id,recorded_at)
    VALUES(p_tenant_id,v_id,v_revision+1,p_input->>'effectId',p_input->>'operation'<>'END',v_effective_at,
      CASE WHEN p_input->>'operation'='END' THEN NULL ELSE p_input->>'normalizedValue' END,v_assertion,p_input,p_invocation_id,p_principal_id,p_recorded_at);
  v_result := jsonb_build_object('outcome','APPLIED','profileRef',p_input->'profileRef','assertion',v_assertion);
  RETURN QUERY SELECT 'APPLIED',v_result;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.change_customer_profile_ico(uuid,uuid,uuid,uuid,timestamptz,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.change_customer_profile_ico(uuid,uuid,uuid,uuid,timestamptz,jsonb) TO ontos_runtime;
