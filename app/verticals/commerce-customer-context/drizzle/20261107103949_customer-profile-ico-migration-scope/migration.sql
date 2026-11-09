CREATE OR REPLACE FUNCTION commerce_customer_context.migrate_customer_profile_ico(p_tenant_id uuid,p_legal_entity_id uuid,p_principal_id uuid,p_invocation_id uuid,p_recorded_at timestamptz,p_input jsonb)
RETURNS TABLE(outcome text,result jsonb) LANGUAGE plpgsql SECURITY DEFINER SET row_security = on SET search_path=pg_catalog,commerce_customer_context,pg_temp
AS $$
DECLARE v_authority commerce_customer_context.customer_profile_ico_authority%ROWTYPE;v_targets jsonb;v_plan jsonb:=p_input->'plan';v_record jsonb;v_target jsonb;v_assertion jsonb;v_profile_id uuid;v_required jsonb;v_replayed boolean:=false;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('ccc.profile-ico:'||p_tenant_id::text,0));
  SELECT x.result INTO v_targets FROM commerce_customer_context.profile_ico_target_inventory(p_tenant_id,p_legal_entity_id) x;
  IF v_plan->>'tenantId' IS DISTINCT FROM p_tenant_id::text OR v_plan->>'targetInventoryVersion' IS DISTINCT FROM v_targets->>'version' THEN RETURN QUERY SELECT 'STALE_PLAN',NULL::jsonb;RETURN;END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan->'records') r CROSS JOIN LATERAL jsonb_array_elements(r->'targets') t
    WHERE r->>'classification'='MATCHED' AND t->'profileRef'->>'kind'='RETAIL' AND t->>'legalEntityId' IS DISTINCT FROM p_legal_entity_id::text) THEN
    RETURN QUERY SELECT 'PLAN_CONFLICT',NULL::jsonb;RETURN;
  END IF;
  SELECT * INTO v_authority FROM commerce_customer_context.customer_profile_ico_authority WHERE tenant_id=p_tenant_id FOR UPDATE;
  IF FOUND AND (v_authority.plan_id IS DISTINCT FROM v_plan->>'planId' OR (v_authority.plan-'migrationRequiredProfileIds') IS DISTINCT FROM v_plan) THEN RETURN QUERY SELECT 'PLAN_CONFLICT',NULL::jsonb;RETURN;END IF;
  IF FOUND THEN v_replayed:=true; END IF;
  IF p_input->>'operation'='STAGE' THEN
    IF NOT v_replayed THEN
      SELECT coalesce(jsonb_agg(DISTINCT t->'profileRef'->>'resourceId'),'[]'::jsonb) INTO v_required FROM jsonb_array_elements(v_plan->'records') r CROSS JOIN LATERAL jsonb_array_elements(r->'targets') t WHERE r->>'classification' NOT IN('MATCHED','HISTORICAL_ONLY');
      -- Any Counterparty without a proved Party relationship remains explicitly unresolved.
      SELECT v_required||coalesce(jsonb_agg(t->'profileRef'->>'resourceId'),'[]'::jsonb) INTO v_required FROM jsonb_array_elements(v_targets->'targets') t WHERE t->'profileRef'->>'kind'='COUNTERPARTY' AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan->'records') r CROSS JOIN LATERAL jsonb_array_elements(r->'targets') rt WHERE rt->'profileRef'->>'resourceId'=t->'profileRef'->>'resourceId' AND rt ? 'partyCorrelation') AND EXISTS(SELECT 1 FROM jsonb_array_elements(v_plan->'records') r WHERE (r->'legacy'->>'isCurrent')::boolean);
      INSERT INTO commerce_customer_context.customer_profile_ico_authority(tenant_id,phase,plan_id,inventory_version,party_fence_id,plan,action_invocation_id,actor_principal_id,recorded_at)
        VALUES(p_tenant_id,'STAGING',v_plan->>'planId',v_plan->>'partySnapshotVersion','',v_plan||jsonb_build_object('migrationRequiredProfileIds',v_required),p_invocation_id,p_principal_id,p_recorded_at);
      FOR v_record IN SELECT value FROM jsonb_array_elements(v_plan->'records') WHERE value->>'classification'='MATCHED' LOOP
        v_target:=v_record->'targets'->0;v_profile_id:=(v_target->'profileRef'->>'resourceId')::uuid;
        IF EXISTS(SELECT 1 FROM commerce_customer_context.customer_profile_ico_assertions WHERE tenant_id=p_tenant_id AND customer_profile_id=v_profile_id) THEN RAISE EXCEPTION 'staging conflicts with existing IČO ledger';END IF;
        v_assertion:=jsonb_build_object('actorPrincipalId',p_principal_id::text,'effectId','ico-migration:'||md5((v_plan->>'planId')||':'||(v_record->'legacy'->'assertionRef'->>'resourceId')),'effectiveAt',v_record->'legacy'->>'validFrom','normalizedValue',v_record->'legacy'->>'normalizedValue','normalizerVersion',NULL,'operation','SET','originalInput',v_record->'legacy'->'originalInput'->>'digits','provenance',jsonb_build_object('countryCode','CZ','assertionId',v_record->'legacy'->'assertionRef'->>'resourceId','evidenceRef',v_plan->>'planId','source',v_record->'legacy'->'provenance'->>'source','sourceRevision',v_record->'legacy'->>'revision','sourceContext',v_plan->'sourceContext','legacy',v_record->'legacy'),'reason',v_plan->>'reason','recordedAt',to_char(p_recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'revision',1);
        INSERT INTO commerce_customer_context.customer_profile_ico_assertions(tenant_id,customer_profile_id,revision,effect_id,is_current,effective_at,normalized_value,assertion,intent,action_invocation_id,actor_principal_id,recorded_at)
          VALUES(p_tenant_id,v_profile_id,1,v_assertion->>'effectId',false,(v_assertion->>'effectiveAt')::timestamptz,v_assertion->>'normalizedValue',v_assertion,v_record,p_invocation_id,p_principal_id,p_recorded_at);
      END LOOP;
    END IF;
  ELSE
    IF NOT v_replayed OR p_input->'fence'->>'tenantId' IS DISTINCT FROM p_tenant_id::text OR p_input->'fence'->>'snapshotVersion' IS DISTINCT FROM v_plan->>'partySnapshotVersion' OR p_input->'fence'->>'migrationPlanRef' IS DISTINCT FROM v_plan->>'planId' THEN RETURN QUERY SELECT 'AUTHORITY_NOT_FENCED',NULL::jsonb;RETURN;END IF;
    v_replayed:=v_authority.phase='COMMERCE';
    IF v_authority.phase <> 'COMMERCE' THEN
      UPDATE commerce_customer_context.customer_profile_ico_assertions SET is_current=true WHERE tenant_id=p_tenant_id AND revision=1 AND intent ? 'legacy';
    END IF;
    UPDATE commerce_customer_context.customer_profile_ico_authority SET phase='COMMERCE',party_fence_id=p_input->'fence'->>'fenceId' WHERE tenant_id=p_tenant_id;
  END IF;
  SELECT * INTO v_authority FROM commerce_customer_context.customer_profile_ico_authority WHERE tenant_id=p_tenant_id;
  RETURN QUERY SELECT 'APPLIED',jsonb_build_object('phase',v_authority.phase,'plan',v_authority.plan-'migrationRequiredProfileIds','replayed',v_replayed,'partyFenceId',nullif(v_authority.party_fence_id,''));
END; $$;
