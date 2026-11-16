-- The two owners use this database-local advisory protocol only to fence mutable Party facts.
CREATE FUNCTION commerce_customer_context.lock_profile_ico_correlation(p_tenant_id uuid,p_legal_entity_id uuid)
RETURNS TABLE(challenge uuid) LANGUAGE plpgsql SECURITY DEFINER
SET row_security=on SET search_path=pg_catalog,commerce_customer_context,pg_temp AS $$
DECLARE v_challenge uuid := gen_random_uuid();
BEGIN
 IF p_legal_entity_id IS NULL OR
   p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id',true),'')::uuid OR
   p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id',true),'')::uuid
 THEN RAISE EXCEPTION 'invalid scope' USING ERRCODE='42501'; END IF;
 IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('ontos.owner-fact.party-ico.correlation:'||p_tenant_id::text,0)) THEN RETURN; END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('ontos.owner-fact.party-ico.challenge:'||p_tenant_id::text||':'||p_legal_entity_id::text||':'||v_challenge::text,0));
 RETURN QUERY SELECT v_challenge;
END $$;
REVOKE ALL ON FUNCTION commerce_customer_context.lock_profile_ico_correlation(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_customer_context.lock_profile_ico_correlation(uuid,uuid) TO ontos_runtime;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION commerce_customer_context.migrate_customer_profile_ico(p_tenant_id uuid,p_legal_entity_id uuid,p_principal_id uuid,p_invocation_id uuid,p_recorded_at timestamptz,p_input jsonb)
RETURNS TABLE(outcome text,result jsonb) LANGUAGE plpgsql SECURITY DEFINER SET row_security=on SET search_path=pg_catalog,commerce_customer_context,pg_temp AS $$
DECLARE v_authority commerce_customer_context.customer_profile_ico_authority%ROWTYPE; v_existing commerce_customer_context.customer_profile_ico_assertions%ROWTYPE;
 v_targets jsonb;v_plan jsonb:=(p_input->'plan')-'authorityRevision'-'reusedCurrentAssertions'-'migrationHomeId';v_record jsonb;v_target jsonb;v_assertion jsonb;v_profile_id uuid;v_required jsonb;v_replayed boolean:=false;v_had_authority boolean;v_operation text:=p_input->>'operation';v_effect text;v_ledger_reads jsonb:='[]'::jsonb;
 v_reused jsonb:='{}'::jsonb; v_requires_home_coverage boolean; v_fence_keys bigint[];
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('ccc.profile-ico:'||p_tenant_id::text,0));
 SELECT x.result INTO v_targets FROM commerce_customer_context.profile_ico_target_inventory(p_tenant_id,p_legal_entity_id) x;
 IF v_operation NOT IN('STAGE','CUTOVER','RESTAGE','RECONCILE') OR v_plan->>'tenantId' IS DISTINCT FROM p_tenant_id::text OR coalesce(v_plan->>'nativeTargetInventoryVersion',v_plan->>'targetInventoryVersion') IS DISTINCT FROM v_targets->>'version' THEN RETURN QUERY SELECT 'STALE_PLAN',NULL::jsonb;RETURN;END IF;
 v_requires_home_coverage := EXISTS(
   SELECT 1 FROM jsonb_array_elements(v_targets->'targets') t
   WHERE t->'profileRef'->>'kind'='COUNTERPARTY' AND t->>'legalEntityId' IS DISTINCT FROM p_legal_entity_id::text
 );
 IF v_requires_home_coverage THEN
   IF coalesce(v_plan->>'correlationCoverageVersion','') !~ '^[0-9a-f]{64}$' OR p_input->>'commitFenceChallenge' IS NULL THEN
     RETURN QUERY SELECT 'STALE_PLAN',NULL::jsonb;RETURN;
   END IF;
   v_fence_keys:=ARRAY[
     hashtextextended('ontos.owner-fact.party-ico.correlation:'||p_tenant_id::text,0),
     hashtextextended('ontos.owner-fact.party-ico.challenge:'||p_tenant_id::text||':'||p_legal_entity_id::text||':'||(p_input->>'commitFenceChallenge'),0)
   ];
   IF EXISTS(SELECT 1 FROM unnest(v_fence_keys) AS key(value) WHERE NOT EXISTS(
     SELECT 1 FROM pg_locks l WHERE l.locktype='advisory' AND l.pid=pg_backend_pid()
       AND l.classid=((key.value >> 32) & 4294967295)::oid AND l.objid=(key.value & 4294967295)::oid
       AND l.objsubid=1 AND l.mode='ShareLock' AND l.granted
   )) THEN RETURN QUERY SELECT 'STALE_PLAN',NULL::jsonb;RETURN;END IF;
 END IF;
 -- Re-read the scoped observation after taking the same lock as native IČO changes.
 IF EXISTS(
   SELECT 1 FROM jsonb_array_elements(v_plan->'records') r
   WHERE r->>'classification'='MATCHED' AND (
     jsonb_array_length(r->'targets')<>1 OR NOT EXISTS(
       SELECT 1 FROM jsonb_array_elements(v_targets->'targets') t
       WHERE t->'profileRef'=r->'targets'->0->'profileRef'
         AND t->>'legalEntityId'=p_legal_entity_id::text
         AND t->>'revision'=r->'targets'->0->>'revision'
         AND t->'currentIcoRevision' IS NOT DISTINCT FROM r->'targets'->0->'currentIcoRevision'
     )
   )
 ) THEN RETURN QUERY SELECT 'STALE_PLAN',NULL::jsonb;RETURN;END IF;
 SELECT * INTO v_authority FROM commerce_customer_context.customer_profile_ico_authority WHERE tenant_id=p_tenant_id FOR UPDATE;v_had_authority:=FOUND;
 IF v_had_authority AND v_authority.plan_id=v_plan->>'planId' THEN
   v_reused:=coalesce(v_authority.plan->'reusedCurrentAssertions','{}'::jsonb);
 END IF;
 IF v_had_authority AND v_operation IN('RESTAGE','CUTOVER') AND (
   (v_authority.plan?'migrationHomeId' AND v_authority.plan->>'migrationHomeId' IS DISTINCT FROM p_legal_entity_id::text)
   OR EXISTS(
     SELECT 1 FROM jsonb_array_elements(v_authority.plan->'records') r
     WHERE r->>'classification'='MATCHED' AND r->'targets'->0->>'legalEntityId' IS DISTINCT FROM p_legal_entity_id::text
   )
 ) THEN RETURN QUERY SELECT 'PLAN_CONFLICT',NULL::jsonb;RETURN;END IF;
 IF v_operation IN('RESTAGE','RECONCILE') THEN
  IF NOT v_had_authority OR (p_input->>'expectedAuthorityRevision')::integer IS DISTINCT FROM v_authority.revision THEN RETURN QUERY SELECT 'STALE_PLAN',NULL::jsonb;RETURN;END IF;
  IF (v_operation='RESTAGE' AND v_authority.phase<>'STAGING') OR (v_operation='RECONCILE' AND v_authority.phase<>'COMMERCE') THEN RETURN QUERY SELECT 'PLAN_CONFLICT',NULL::jsonb;RETURN;END IF;
 ELSE
  IF v_had_authority AND (v_authority.plan_id IS DISTINCT FROM v_plan->>'planId' OR (v_authority.plan-'migrationRequiredProfileIds'-'authorityRevision'-'reusedCurrentAssertions'-'migrationHomeId') IS DISTINCT FROM v_plan) THEN RETURN QUERY SELECT 'PLAN_CONFLICT',NULL::jsonb;RETURN;END IF;
  v_replayed:=v_had_authority;
 END IF;
 IF p_input->'fence'<>'null'::jsonb AND (p_input->'fence'->>'tenantId' IS DISTINCT FROM p_tenant_id::text OR p_input->'fence'->>'snapshotVersion' IS DISTINCT FROM v_plan->>'partySnapshotVersion' OR p_input->'fence'->>'migrationPlanRef' IS DISTINCT FROM v_plan->>'planId') THEN RETURN QUERY SELECT 'AUTHORITY_NOT_FENCED',NULL::jsonb;RETURN;END IF;
 IF v_operation IN('CUTOVER','RECONCILE') AND (NOT v_had_authority OR p_input->'fence' IS NULL OR p_input->'fence'='null'::jsonb OR p_input->'fence'->>'tenantId' IS DISTINCT FROM p_tenant_id::text OR p_input->'fence'->>'snapshotVersion' IS DISTINCT FROM v_plan->>'partySnapshotVersion' OR p_input->'fence'->>'migrationPlanRef' IS DISTINCT FROM v_plan->>'planId') THEN RETURN QUERY SELECT 'AUTHORITY_NOT_FENCED',NULL::jsonb;RETURN;END IF;
 IF v_operation='RECONCILE' AND (v_authority.plan_id IS DISTINCT FROM v_plan->>'planId' OR v_authority.inventory_version IS DISTINCT FROM v_plan->>'partySnapshotVersion') THEN RETURN QUERY SELECT 'PLAN_CONFLICT',NULL::jsonb;RETURN;END IF;
 IF v_operation IN('STAGE','RESTAGE','RECONCILE') AND NOT v_replayed THEN
  SELECT coalesce(jsonb_agg(DISTINCT t->'profileRef'->>'resourceId'),'[]'::jsonb) INTO v_required FROM jsonb_array_elements(v_plan->'records') r CROSS JOIN LATERAL jsonb_array_elements(r->'targets') t WHERE r->>'classification' NOT IN('MATCHED','HISTORICAL_ONLY');
  -- Preserve the existing conservative fence on uncorrelated local Counterparties.
  SELECT v_required||coalesce(jsonb_agg(t->'profileRef'->>'resourceId'),'[]'::jsonb)
    INTO v_required FROM jsonb_array_elements(v_targets->'targets') t
    WHERE t->'profileRef'->>'kind'='COUNTERPARTY'
      AND t->>'legalEntityId'=p_legal_entity_id::text
      AND NOT EXISTS(
        SELECT 1 FROM jsonb_array_elements(v_plan->'records') r CROSS JOIN LATERAL jsonb_array_elements(r->'targets') rt
        WHERE rt->'profileRef'->>'resourceId'=t->'profileRef'->>'resourceId' AND rt?'partyCorrelation'
      )
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(v_plan->'records') r WHERE (r->'legacy'->>'isCurrent')::boolean);
  IF v_operation='RECONCILE' THEN SELECT coalesce(jsonb_agg(x.value),'[]'::jsonb) INTO v_required FROM jsonb_array_elements(v_required) x WHERE NOT EXISTS(SELECT 1 FROM commerce_customer_context.customer_profile_ico_assertions a WHERE a.tenant_id=p_tenant_id AND a.customer_profile_id::text=x.value#>>'{}');END IF;
  -- Visibility for a foreign home remains fenced until that home independently reconciles.
  IF v_requires_home_coverage THEN
   SELECT v_required||coalesce(jsonb_agg(t->'profileRef'->>'resourceId'),'[]'::jsonb)
     INTO v_required
     FROM jsonb_array_elements(v_targets->'targets') t
     WHERE t->>'legalEntityId' IS DISTINCT FROM p_legal_entity_id::text
       AND (v_operation<>'RECONCILE' OR coalesce(v_authority.plan->'migrationRequiredProfileIds','[]'::jsonb)?(t->'profileRef'->>'resourceId'));
  END IF;
  IF v_operation='RESTAGE' THEN
   -- Replace only never-authoritative staged imports. The accepted prior plan is archived below.
   DELETE FROM commerce_customer_context.customer_profile_ico_assertions a WHERE a.tenant_id=p_tenant_id AND a.revision=1 AND NOT a.is_current AND a.action_invocation_id=v_authority.action_invocation_id AND a.intent?'legacy' AND a.effect_id='ico-migration:'||md5(v_authority.plan_id||':'||(a.intent->'legacy'->'assertionRef'->>'resourceId'))
     AND EXISTS(SELECT 1 FROM commerce_customer_context.customer_profiles p
       WHERE p.tenant_id=p_tenant_id AND p.customer_profile_id=a.customer_profile_id AND p.legal_entity_id=p_legal_entity_id);
  END IF;
  -- A bounded company plan never consumes protected provenance or a personal target.
  IF v_plan->>'projection'='ORGANIZATION_ICO_FIELDS_V1' AND (
    v_plan->'sourceContext' IS DISTINCT FROM 'null'::jsonb OR
    EXISTS(SELECT 1 FROM jsonb_array_elements(v_plan->'records') r
      WHERE r->'legacy'->'provenance'->'ownerReceiptRef' IS DISTINCT FROM r->'legacy'->'assertionRef'
        OR (SELECT count(*) FROM jsonb_object_keys(r->'legacy'->'provenance'))<>1
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(r->'targets') t WHERE t->'profileRef'->>'kind' IS DISTINCT FROM 'COUNTERPARTY'))
  ) THEN RETURN QUERY SELECT 'PLAN_CONFLICT',NULL::jsonb;RETURN;END IF;
  FOR v_record IN SELECT value FROM jsonb_array_elements(v_plan->'records') WHERE value->>'classification'='MATCHED' LOOP
   v_target:=v_record->'targets'->0;v_profile_id:=(v_target->'profileRef'->>'resourceId')::uuid;v_effect:='ico-migration:'||md5((v_plan->>'planId')||':'||(v_record->'legacy'->'assertionRef'->>'resourceId'));
   IF v_plan->>'projection'='ORGANIZATION_ICO_FIELDS_V1' OR v_target?'organizationIcoAuthority' THEN
    IF NOT(v_target?'organizationIcoAuthority')
      OR v_target->'profileRef'->>'kind' IS DISTINCT FROM 'COUNTERPARTY'
      OR v_target->'organizationIcoAuthority'->'profileRef'->>'resourceId' IS DISTINCT FROM v_profile_id::text
      OR v_target->'organizationIcoAuthority'->'profileRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
      OR v_target->'organizationIcoAuthority'->'partyRef' IS DISTINCT FROM v_record->'legacy'->'partyRef'
      OR v_record->'legacy'->'provenance'->'ownerReceiptRef' IS DISTINCT FROM v_record->'legacy'->'assertionRef'
      OR (SELECT count(*) FROM jsonb_object_keys(v_record->'legacy'->'provenance'))<>1
      OR NOT EXISTS(SELECT 1 FROM commerce_customer_context.customer_profiles p
        JOIN commerce_customer_context.counterparty_purchasing_profiles cp ON cp.tenant_id=p.tenant_id AND cp.counterparty_purchasing_profile_id=p.customer_profile_id
        WHERE p.tenant_id=p_tenant_id AND p.legal_entity_id=p_legal_entity_id AND cp.legal_entity_id=p_legal_entity_id
          AND p.customer_profile_id=v_profile_id AND p.profile_kind='COUNTERPARTY' AND p.lifecycle='ACTIVE'
          AND p.revision=(v_target->'organizationIcoAuthority'->>'profileRevision')::integer)
    THEN RETURN QUERY SELECT 'STALE_PLAN',NULL::jsonb;RETURN;END IF;
   END IF;
   SELECT * INTO v_existing FROM commerce_customer_context.customer_profile_ico_assertions WHERE tenant_id=p_tenant_id AND effect_id=v_effect;
   IF FOUND THEN
    IF v_operation<>'RECONCILE' OR v_existing.customer_profile_id<>v_profile_id OR v_existing.intent->'legacy' IS DISTINCT FROM v_record->'legacy' THEN RETURN QUERY SELECT 'PLAN_CONFLICT',NULL::jsonb;RETURN;END IF;
    v_ledger_reads:=v_ledger_reads||jsonb_build_array(jsonb_build_object('profileRef',v_target->'profileRef','resultCount',1));
    CONTINUE;
   END IF;
   SELECT * INTO v_existing FROM commerce_customer_context.customer_profile_ico_assertions
     WHERE tenant_id=p_tenant_id AND customer_profile_id=v_profile_id AND is_current;
   IF FOUND THEN
    IF v_existing.intent?'legacy' OR v_existing.effective_at>p_recorded_at
      OR v_existing.normalized_value IS DISTINCT FROM v_record->'legacy'->>'normalizedValue'
    THEN RETURN QUERY SELECT 'PLAN_CONFLICT',NULL::jsonb;RETURN;END IF;
    -- The migration effect points to the accepted independent assertion without changing that ledger.
    IF v_reused?v_effect THEN
     IF v_reused->v_effect->'profileRef' IS DISTINCT FROM v_target->'profileRef'
       OR v_reused->v_effect->>'legacyRevision' IS DISTINCT FROM v_record->'legacy'->>'revision'
     THEN RETURN QUERY SELECT 'PLAN_CONFLICT',NULL::jsonb;RETURN;END IF;
    ELSE
     v_reused:=v_reused||jsonb_build_object(v_effect,jsonb_build_object(
       'assertionRef',v_record->'legacy'->'assertionRef','legacyRevision',v_record->'legacy'->>'revision',
       'profileRef',v_target->'profileRef','currentRevision',v_existing.revision,
       'currentEffectId',v_existing.effect_id,'currentActionInvocationId',v_existing.action_invocation_id,
       'migrationActionInvocationId',p_invocation_id
     ));
    END IF;
    v_ledger_reads:=v_ledger_reads||jsonb_build_array(jsonb_build_object('profileRef',v_target->'profileRef','resultCount',1));
    CONTINUE;
   END IF;
   IF EXISTS(SELECT 1 FROM commerce_customer_context.customer_profile_ico_assertions WHERE tenant_id=p_tenant_id AND customer_profile_id=v_profile_id) THEN RETURN QUERY SELECT 'PLAN_CONFLICT',NULL::jsonb;RETURN;END IF;
   v_ledger_reads:=v_ledger_reads||jsonb_build_array(jsonb_build_object('profileRef',v_target->'profileRef','resultCount',0));
        IF v_plan->>'projection'='ORGANIZATION_ICO_FIELDS_V1' OR v_target?'organizationIcoAuthority' THEN
          v_assertion:=jsonb_build_object('partyRef',v_record->'legacy'->'partyRef','effectId',v_effect,
            'effectiveAt',v_record->'legacy'->>'validFrom','normalizedValue',v_record->'legacy'->>'normalizedValue',
            'normalizerVersion',NULL,'operation','SET','originalInput',v_record->'legacy'->'originalInput'->>'digits',
            'recordedAt',to_char(p_recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'revision',1);
        ELSE
        v_assertion:=jsonb_build_object('actorPrincipalId',p_principal_id::text,'effectId','ico-migration:'||md5((v_plan->>'planId')||':'||(v_record->'legacy'->'assertionRef'->>'resourceId')),'effectiveAt',v_record->'legacy'->>'validFrom','normalizedValue',v_record->'legacy'->>'normalizedValue','normalizerVersion',NULL,'operation','SET','originalInput',v_record->'legacy'->'originalInput'->>'digits','provenance',jsonb_build_object('countryCode','CZ','assertionId',v_record->'legacy'->'assertionRef'->>'resourceId','evidenceRef',v_plan->>'planId','source',v_record->'legacy'->'provenance'->>'source','sourceRevision',v_record->'legacy'->>'revision','sourceContext',v_plan->'sourceContext','legacy',v_record->'legacy'),'reason',v_plan->>'reason','recordedAt',to_char(p_recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'revision',1);
        END IF;
        INSERT INTO commerce_customer_context.customer_profile_ico_assertions(tenant_id,customer_profile_id,revision,effect_id,is_current,effective_at,normalized_value,assertion,intent,action_invocation_id,actor_principal_id,recorded_at)
          VALUES(p_tenant_id,v_profile_id,1,v_assertion->>'effectId',p_input->>'operation'='RECONCILE',(v_assertion->>'effectiveAt')::timestamptz,v_assertion->>'normalizedValue',v_assertion,v_record,p_invocation_id,p_principal_id,p_recorded_at);

  END LOOP;
  v_plan:=v_plan||jsonb_build_object('migrationRequiredProfileIds',v_required,'migrationHomeId',p_legal_entity_id);
  IF v_reused<>'{}'::jsonb THEN
   v_plan:=v_plan||jsonb_build_object('reusedCurrentAssertions',v_reused);
  END IF;
  IF v_operation='STAGE' THEN
   INSERT INTO commerce_customer_context.customer_profile_ico_authority(tenant_id,phase,plan_id,inventory_version,party_fence_id,plan,action_invocation_id,actor_principal_id,recorded_at)
     VALUES(p_tenant_id,'STAGING',v_plan->>'planId',v_plan->>'partySnapshotVersion','',v_plan,p_invocation_id,p_principal_id,p_recorded_at);
  ELSE
   UPDATE commerce_customer_context.customer_profile_ico_authority
     SET plan_id=v_plan->>'planId',inventory_version=v_plan->>'partySnapshotVersion',plan=v_plan,
       action_invocation_id=p_invocation_id,actor_principal_id=p_principal_id,recorded_at=p_recorded_at
     WHERE tenant_id=p_tenant_id;
  END IF;
 ELSIF v_operation='CUTOVER' THEN
  v_replayed:=v_authority.phase='COMMERCE';
  IF NOT v_replayed THEN
   UPDATE commerce_customer_context.customer_profile_ico_assertions a SET is_current=true WHERE a.tenant_id=p_tenant_id AND a.revision=1 AND a.action_invocation_id=v_authority.action_invocation_id AND a.intent?'legacy' AND a.effect_id='ico-migration:'||md5(v_authority.plan_id||':'||(a.intent->'legacy'->'assertionRef'->>'resourceId'))
     AND EXISTS(SELECT 1 FROM commerce_customer_context.customer_profiles p
       WHERE p.tenant_id=p_tenant_id AND p.customer_profile_id=a.customer_profile_id AND p.legal_entity_id=p_legal_entity_id);
   UPDATE commerce_customer_context.customer_profile_ico_authority SET phase='COMMERCE',party_fence_id=p_input->'fence'->>'fenceId',action_invocation_id=p_invocation_id,actor_principal_id=p_principal_id,recorded_at=p_recorded_at WHERE tenant_id=p_tenant_id;
  END IF;
 END IF;
 SELECT * INTO v_authority FROM commerce_customer_context.customer_profile_ico_authority WHERE tenant_id=p_tenant_id;
 RETURN QUERY SELECT 'APPLIED',jsonb_build_object('authorityReadCount',CASE WHEN v_had_authority THEN 1 ELSE 0 END,'ledgerReads',v_ledger_reads,'phase',v_authority.phase,'plan',(v_authority.plan-'migrationRequiredProfileIds'-'reusedCurrentAssertions'-'migrationHomeId')||jsonb_build_object('authorityRevision',v_authority.revision),'replayed',v_replayed,'partyFenceId',nullif(v_authority.party_fence_id,''));
END $$;
