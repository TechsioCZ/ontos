CREATE FUNCTION commerce_customer_context.project_organization_profile_ico_receipt(
 a commerce_customer_context.customer_profile_ico_assertions,p_profile_ref jsonb,p_as_of timestamptz,p_receipt boolean
) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,commerce_customer_context,pg_temp AS $$
 SELECT jsonb_build_object(
 'profileRef',p_profile_ref,
 'partyRef',coalesce(a.assertion->'partyRef',a.intent->'legacy'->'partyRef','null'::jsonb),
 'revision',a.revision,'normalizedValue',a.normalized_value,
 'normalizerVersion',CASE WHEN a.assertion->>'normalizerVersion'='CZ:ICO:party-v1' THEN 'CZ:ICO:party-v1' ELSE NULL END,
 'originalInput',CASE WHEN btrim(a.assertion->>'originalInput')~'^[0-9]{1,8}$' THEN jsonb_build_object('kind','KNOWN','digits',btrim(a.assertion->>'originalInput')) WHEN a.intent->'legacy'->'originalInput'->>'kind'='KNOWN' AND a.intent->'legacy'->'originalInput'->>'digits'~'^[0-9]{1,8}$' THEN jsonb_build_object('kind','KNOWN','digits',a.intent->'legacy'->'originalInput'->>'digits') ELSE jsonb_build_object('kind','UNKNOWN') END,
 'operation',a.assertion->>'operation',
 'effectiveAt',to_char(a.effective_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'effectiveTo',CASE WHEN p_receipt THEN coalesce(a.intent->'legacy'->'validTo','null'::jsonb) ELSE CASE WHEN a.effective_to IS NULL THEN NULL ELSE to_jsonb(to_char(a.effective_to AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END END,
 'isCurrent',CASE WHEN p_receipt THEN coalesce((a.intent->'legacy'->>'isCurrent')::boolean,a.assertion->>'operation'<>'END') ELSE a.assertion->>'operation'<>'END' AND a.effective_at<=p_as_of AND (a.effective_to IS NULL OR a.effective_to>p_as_of) END,
 'recordedAt',to_char(a.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'provenance',jsonb_build_object('ownerReceiptRef',CASE WHEN a.intent->'legacy'?'assertionRef' THEN a.intent->'legacy'->'assertionRef' ELSE jsonb_build_object('_tag','CORE_ACTION_INVOCATION','actionInvocationId',a.action_invocation_id::text) END)
 );
$$;
REVOKE ALL ON FUNCTION commerce_customer_context.project_organization_profile_ico_receipt(commerce_customer_context.customer_profile_ico_assertions,jsonb,timestamptz,boolean) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION commerce_customer_context.organization_profile_ico_state(p_tenant_id uuid,p_legal_entity_id uuid,p_input jsonb)
RETURNS TABLE(outcome text,result jsonb) LANGUAGE plpgsql SECURITY DEFINER SET row_security=on SET search_path=pg_catalog,commerce_customer_context,pg_temp AS $$
DECLARE v_id uuid:=(p_input->'profileRef'->>'resourceId')::uuid;v_revision integer;v_history jsonb;v_current jsonb;v_current_op text;v_as_of timestamptz:=coalesce((p_input->>'asOf')::timestamptz,current_timestamp);
BEGIN
 PERFORM commerce_customer_context.assert_profile_operation_scope(p_tenant_id,p_legal_entity_id);
 IF p_input->'profileRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text THEN RETURN QUERY SELECT 'PROFILE_NOT_ADMISSIBLE',NULL::jsonb;RETURN;END IF;
 SELECT p.revision INTO v_revision FROM commerce_customer_context.customer_profiles p JOIN commerce_customer_context.counterparty_purchasing_profiles cp ON cp.tenant_id=p.tenant_id AND cp.counterparty_purchasing_profile_id=p.customer_profile_id WHERE p.tenant_id=p_tenant_id AND p.legal_entity_id=p_legal_entity_id AND cp.legal_entity_id=p_legal_entity_id AND p.customer_profile_id=v_id AND p.profile_kind='COUNTERPARTY' AND p.lifecycle='ACTIVE';
 IF NOT FOUND OR v_revision IS DISTINCT FROM (p_input->'authority'->>'profileRevision')::integer THEN RETURN QUERY SELECT 'PROFILE_NOT_ADMISSIBLE',NULL::jsonb;RETURN;END IF;
 IF EXISTS(SELECT 1 FROM commerce_customer_context.profile_reconciliation_case_members m JOIN commerce_customer_context.profile_reconciliation_cases c USING(tenant_id,legal_entity_id,profile_reconciliation_case_id) WHERE m.tenant_id=p_tenant_id AND m.customer_profile_id=v_id AND c.lifecycle<>'COMPLETED') THEN RETURN QUERY SELECT 'MIGRATION_REQUIRED',jsonb_build_object('_tag','MIGRATION_REQUIRED','profileRef',p_input->'profileRef');RETURN;END IF;
 IF NOT EXISTS(SELECT 1 FROM commerce_customer_context.customer_profile_ico_authority WHERE tenant_id=p_tenant_id AND phase='COMMERCE' AND NOT(coalesce(plan->'migrationRequiredProfileIds','[]'::jsonb)?v_id::text)) THEN RETURN QUERY SELECT 'MIGRATION_REQUIRED',jsonb_build_object('_tag','MIGRATION_REQUIRED','profileRef',p_input->'profileRef');RETURN;END IF;
 IF p_input?'actionInvocationId' THEN
  SELECT commerce_customer_context.project_organization_profile_ico_receipt(a,p_input->'profileRef',a.recorded_at,true) INTO v_current FROM commerce_customer_context.customer_profile_ico_assertions a WHERE a.tenant_id=p_tenant_id AND a.customer_profile_id=v_id AND a.action_invocation_id=(p_input->>'actionInvocationId')::uuid AND (NOT(p_input?'originalPrincipalId') OR (a.actor_principal_id=(p_input->>'originalPrincipalId')::uuid AND a.intent?'organizationCommand'));
  IF NOT FOUND THEN RETURN QUERY SELECT 'EFFECT_NOT_FOUND',NULL::jsonb;RETURN;END IF;
  RETURN QUERY SELECT 'AVAILABLE',jsonb_build_object('_tag','RECEIPT','assertion',v_current);RETURN;
 END IF;
 SELECT coalesce(jsonb_agg(commerce_customer_context.project_organization_profile_ico_receipt(a,p_input->'profileRef',v_as_of,false) ORDER BY a.revision),'[]'::jsonb),coalesce(max(a.revision),0) INTO v_history,v_revision FROM commerce_customer_context.customer_profile_ico_assertions a WHERE a.tenant_id=p_tenant_id AND a.customer_profile_id=v_id;
 SELECT commerce_customer_context.project_organization_profile_ico_receipt(a,p_input->'profileRef',v_as_of,false),a.assertion->>'operation' INTO v_current,v_current_op FROM commerce_customer_context.customer_profile_ico_assertions a WHERE a.tenant_id=p_tenant_id AND a.customer_profile_id=v_id AND a.effective_at<=v_as_of ORDER BY a.revision DESC LIMIT 1;
 IF v_current_op='END' OR v_current->>'isCurrent'='false' THEN v_current:=NULL;END IF;
 IF v_current IS NULL THEN RETURN QUERY SELECT 'AVAILABLE',jsonb_build_object('_tag','ABSENT','history',v_history,'revision',v_revision);ELSE RETURN QUERY SELECT 'AVAILABLE',jsonb_build_object('_tag','PRESENT','current',v_current,'history',v_history,'revision',v_revision);END IF;
END $$;
REVOKE ALL ON FUNCTION commerce_customer_context.organization_profile_ico_state(uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_customer_context.organization_profile_ico_state(uuid,uuid,jsonb) TO ontos_runtime;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION commerce_customer_context.change_organization_profile_ico(p_tenant_id uuid,p_legal_entity_id uuid,p_principal_id uuid,p_invocation_id uuid,p_recorded_at timestamptz,p_input jsonb)
RETURNS TABLE(outcome text,result jsonb) LANGUAGE plpgsql SECURITY DEFINER SET row_security=on SET search_path=pg_catalog,commerce_customer_context,pg_temp AS $$
DECLARE v_command jsonb:=p_input->'command';v_id uuid:=(v_command->'profileRef'->>'resourceId')::uuid;v_state record;v_prior commerce_customer_context.customer_profile_ico_assertions%ROWTYPE;v_latest commerce_customer_context.customer_profile_ico_assertions%ROWTYPE;v_row commerce_customer_context.customer_profile_ico_assertions%ROWTYPE;v_revision integer;v_current boolean;v_effective_at timestamptz:=(v_command->>'effectiveAt')::timestamptz;v_assertion jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('ccc.profile-ico:'||p_tenant_id::text,0));
 SELECT * INTO v_state FROM commerce_customer_context.organization_profile_ico_state(p_tenant_id,p_legal_entity_id,jsonb_build_object('profileRef',v_command->'profileRef','authority',p_input->'authority'));
 IF v_state.outcome<>'AVAILABLE' THEN RETURN QUERY SELECT v_state.outcome,NULL::jsonb;RETURN;END IF;
 PERFORM 1 FROM commerce_customer_context.customer_profiles WHERE tenant_id=p_tenant_id AND customer_profile_id=v_id AND revision=(p_input->'authority'->>'profileRevision')::integer AND lifecycle='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'PROFILE_NOT_ADMISSIBLE',NULL::jsonb;RETURN;END IF;
 SELECT * INTO v_prior FROM commerce_customer_context.customer_profile_ico_assertions WHERE tenant_id=p_tenant_id AND effect_id=v_command->>'effectId';
 IF FOUND THEN
  IF v_prior.intent->'organizationCommand' IS DISTINCT FROM v_command THEN RETURN QUERY SELECT 'EFFECT_CONFLICT',NULL::jsonb;RETURN;END IF;
  RETURN QUERY SELECT 'REPLAY',jsonb_build_object('outcome','REPLAY','assertion',commerce_customer_context.project_organization_profile_ico_receipt(v_prior,v_command->'profileRef',v_prior.recorded_at,true));RETURN;
 END IF;
 SELECT * INTO v_latest FROM commerce_customer_context.customer_profile_ico_assertions WHERE tenant_id=p_tenant_id AND customer_profile_id=v_id ORDER BY revision DESC LIMIT 1;v_revision:=coalesce(v_latest.revision,0);v_current:=coalesce(v_latest.is_current,false);
 IF v_revision<>(v_command->>'expectedRevision')::integer THEN RETURN QUERY SELECT 'REVISION_CONFLICT',NULL::jsonb;RETURN;END IF;
 IF v_effective_at>p_recorded_at OR (v_latest.effective_at IS NOT NULL AND v_effective_at<v_latest.effective_at) OR (v_command->>'operation'='SET' AND v_current) OR (v_command->>'operation' IN('CORRECT','END') AND NOT v_current) THEN RETURN QUERY SELECT 'INVALID_TRANSITION',NULL::jsonb;RETURN;END IF;
 v_assertion:=jsonb_build_object('partyRef',p_input->'authority'->'partyRef','effectiveAt',v_command->>'effectiveAt','normalizedValue',CASE WHEN v_command->>'operation'='END' THEN NULL ELSE p_input->>'normalizedValue' END,'normalizerVersion',CASE WHEN v_command->>'operation'='END' THEN NULL ELSE 'CZ:ICO:party-v1' END,'operation',v_command->>'operation','originalInput',v_command->>'originalInput','recordedAt',to_char(p_recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'revision',v_revision+1);
 UPDATE commerce_customer_context.customer_profile_ico_assertions SET is_current=false,effective_to=v_effective_at WHERE tenant_id=p_tenant_id AND customer_profile_id=v_id AND is_current;
 INSERT INTO commerce_customer_context.customer_profile_ico_assertions(tenant_id,customer_profile_id,revision,effect_id,is_current,effective_at,normalized_value,assertion,intent,action_invocation_id,actor_principal_id,recorded_at) VALUES(p_tenant_id,v_id,v_revision+1,v_command->>'effectId',v_command->>'operation'<>'END',v_effective_at,CASE WHEN v_command->>'operation'='END' THEN NULL ELSE p_input->>'normalizedValue' END,v_assertion,jsonb_build_object('organizationCommand',v_command,'authority',p_input->'authority'),p_invocation_id,p_principal_id,p_recorded_at) RETURNING * INTO v_row;
 RETURN QUERY SELECT 'APPLIED',jsonb_build_object('outcome','APPLIED','assertion',commerce_customer_context.project_organization_profile_ico_receipt(v_row,v_command->'profileRef',v_row.recorded_at,true));
END $$;
REVOKE ALL ON FUNCTION commerce_customer_context.change_organization_profile_ico(uuid,uuid,uuid,uuid,timestamptz,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_customer_context.change_organization_profile_ico(uuid,uuid,uuid,uuid,timestamptz,jsonb) TO ontos_runtime;
