CREATE OR REPLACE FUNCTION commerce_customer_context.ensure_source_customer_profile(p_tenant_id uuid,p_legal_entity_id uuid,p_principal_id uuid,p_invocation_id uuid,p_recorded_at timestamptz,p_input jsonb)
RETURNS TABLE(outcome text,payload jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET row_security = on
SET search_path = pg_catalog,commerce_customer_context,pg_temp
AS $$
DECLARE v_source jsonb:=p_input->'payload'->'source';v_intent jsonb:=p_input->'payload';v_kind text:=p_input->>'profileKind';v_route record;v_binding commerce_customer_context.customer_profile_source_bindings%ROWTYPE;v_receipt commerce_customer_context.customer_profile_source_receipts%ROWTYPE;v_result record;v_id uuid;v_subject jsonb:=p_input->'payload'->'subject';v_public_result jsonb;
BEGIN
  PERFORM commerce_customer_context.assert_profile_operation_scope(p_tenant_id,p_legal_entity_id);
  SELECT * INTO v_route FROM commerce_customer_context.customer_profile_source_routes r WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.route_id=v_source->'route'->>'id' AND r.route_revision=v_source->'route'->>'revision' AND r.mapping_revision=v_source->>'mappingRevision' AND r.issuer=v_source->>'issuer' AND r.namespace=v_source->>'namespace' AND r.record_type=v_source->>'recordType' AND r.principal_id=p_principal_id AND r.active FOR SHARE;
  IF NOT FOUND OR v_kind NOT IN('RETAIL','COUNTERPARTY') OR nullif(p_input->'proof'->>'partyResourceId','') IS NULL THEN RETURN QUERY SELECT 'SOURCE_AUTHORITY_DENIED',NULL::jsonb;RETURN;END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ccc.profile-source:'||p_tenant_id::text||':'||(v_source->>'issuer')||':'||(v_source->>'namespace')||':'||(v_source->>'recordType'),0));
  SELECT * INTO v_receipt FROM commerce_customer_context.customer_profile_source_receipts r WHERE r.tenant_id=p_tenant_id AND r.issuer=v_source->>'issuer' AND r.namespace=v_source->>'namespace' AND r.record_type=v_source->>'recordType' AND r.effect_id=v_source->>'effectId';
  IF FOUND THEN
    IF v_receipt.owner_evidence IS NULL THEN RETURN QUERY SELECT 'SOURCE_CONFLICT',NULL::jsonb;RETURN;END IF;
    IF v_receipt.intent IS DISTINCT FROM v_intent OR v_receipt.profile_kind<>v_kind OR (v_kind='RETAIL' AND v_receipt.legal_entity_id<>p_legal_entity_id) THEN RETURN QUERY SELECT 'SOURCE_CONFLICT',NULL::jsonb;RETURN;END IF;
    RETURN QUERY SELECT 'REPLAY',jsonb_set(v_receipt.result,'{sourceEffect,replayed}','true'::jsonb);RETURN;
  END IF;
  SELECT * INTO v_binding FROM commerce_customer_context.customer_profile_source_bindings b WHERE b.tenant_id=p_tenant_id AND b.issuer=v_source->>'issuer' AND b.namespace=v_source->>'namespace' AND b.record_type=v_source->>'recordType' AND b.record_id=v_source->>'recordId' FOR UPDATE;
  IF FOUND THEN
    IF v_binding.profile_kind<>v_kind OR v_binding.party_resource_id IS DISTINCT FROM p_input->'proof'->>'partyResourceId' OR (v_kind='RETAIL' AND (v_binding.legal_entity_id<>p_legal_entity_id OR v_binding.source_intent->'subject' IS DISTINCT FROM v_subject)) OR (v_kind='COUNTERPARTY' AND v_binding.source_intent->'subject'->'counterpartyRef' IS DISTINCT FROM v_subject->'counterpartyRef') THEN RETURN QUERY SELECT 'SOURCE_CONFLICT',NULL::jsonb;RETURN;END IF;
    IF (v_source->>'order')::integer<v_binding.source_order THEN RETURN QUERY SELECT 'SOURCE_STALE',NULL::jsonb;RETURN;END IF;
    IF (v_source->>'order')::integer=v_binding.source_order OR v_source->>'revision'=v_binding.source_revision OR v_source->>'occurrenceId'=v_binding.source_occurrence_id THEN RETURN QUERY SELECT 'SOURCE_CONFLICT',NULL::jsonb;RETURN;END IF;
  END IF;
  IF v_kind='RETAIL' THEN
    SELECT * INTO v_result FROM commerce_customer_context.ensure_retail_profile(p_tenant_id,p_legal_entity_id,v_subject->'partyRef'->>'resourceId',p_input->'proof'->>'partyResourceRevision',CASE WHEN v_intent->>'trigger'='GUEST_RETAIL_ATTRIBUTION' THEN 'GUEST_ACCEPTANCE' ELSE 'AUTHENTICATED' END,(v_intent->>'effectiveAt')::timestamptz,v_intent->>'trigger',p_invocation_id,p_principal_id);
  ELSE
    SELECT * INTO v_result FROM commerce_customer_context.ensure_counterparty_profile(p_tenant_id,p_legal_entity_id,v_subject->'counterpartyRef'->>'resourceId',NULL,p_input->'proof'->>'roleResourceId',p_input->'proof'->>'roleResourceRevision',(v_intent->>'effectiveAt')::timestamptz,v_intent->>'trigger',p_invocation_id,p_principal_id);
  END IF;
  IF v_result.payload IS NULL THEN RETURN QUERY SELECT v_result.outcome,NULL::jsonb;RETURN;END IF;
  v_id:=(v_result.payload->'profileRef'->>'resourceId')::uuid;
  IF v_binding.customer_profile_id IS NOT NULL AND v_binding.customer_profile_id<>v_id THEN RAISE EXCEPTION 'source Profile correlation changed during owner resolution' USING ERRCODE='40001';END IF;
  v_public_result:=(v_result.payload-'scopeLegalEntityId')||jsonb_build_object('sourceEffect',jsonb_build_object('effectId',v_source->>'effectId','replayed',false));
  INSERT INTO commerce_customer_context.customer_profile_source_bindings(tenant_id,legal_entity_id,issuer,namespace,record_type,record_id,customer_profile_id,profile_kind,party_resource_id,party_resource_revision,source_order,source_revision,source_occurrence_id,source_intent,recorded_at)
  VALUES(p_tenant_id,p_legal_entity_id,v_source->>'issuer',v_source->>'namespace',v_source->>'recordType',v_source->>'recordId',v_id,v_kind,p_input->'proof'->>'partyResourceId',p_input->'proof'->>'partyResourceRevision',(v_source->>'order')::integer,v_source->>'revision',v_source->>'occurrenceId',v_intent,p_recorded_at)
  ON CONFLICT(tenant_id,issuer,namespace,record_type,record_id) DO UPDATE SET source_order=EXCLUDED.source_order,source_revision=EXCLUDED.source_revision,source_occurrence_id=EXCLUDED.source_occurrence_id,source_intent=EXCLUDED.source_intent;
  INSERT INTO commerce_customer_context.customer_profile_source_receipts(tenant_id,legal_entity_id,issuer,namespace,record_type,effect_id,record_id,customer_profile_id,profile_kind,intent,result,owner_evidence,action_invocation_id,actor_principal_id,recorded_at)
  VALUES(p_tenant_id,p_legal_entity_id,v_source->>'issuer',v_source->>'namespace',v_source->>'recordType',v_source->>'effectId',v_source->>'recordId',v_id,v_kind,v_intent,v_public_result,p_input->'proof',p_invocation_id,p_principal_id,p_recorded_at);
  RETURN QUERY SELECT v_result.outcome,v_public_result;
END;$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION commerce_customer_context.read_customer_profile_source(p_tenant_id uuid,p_legal_entity_id uuid,p_principal_id uuid,p_input jsonb)
RETURNS TABLE(outcome text,result jsonb) LANGUAGE plpgsql SECURITY DEFINER
SET row_security = on
SET search_path=pg_catalog,commerce_customer_context,pg_temp
AS $$
DECLARE v_route record;v_binding commerce_customer_context.customer_profile_source_bindings%ROWTYPE;v_receipt commerce_customer_context.customer_profile_source_receipts%ROWTYPE;v_item jsonb;v_items jsonb:='[]'::jsonb;v_count integer:=0;v_limit integer;v_cursor text:=NULL;
BEGIN
  PERFORM commerce_customer_context.assert_profile_operation_scope(p_tenant_id,p_legal_entity_id);
  SELECT * INTO v_route FROM commerce_customer_context.customer_profile_source_routes r WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.route_id=p_input->'route'->>'id' AND r.route_revision=p_input->'route'->>'revision' AND r.mapping_revision=p_input->>'mappingRevision' AND r.issuer=p_input->>'issuer' AND r.namespace=p_input->>'namespace' AND r.record_type=p_input->>'recordType' AND r.principal_id=p_principal_id AND r.active FOR SHARE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'SOURCE_AUTHORITY_DENIED',NULL::jsonb;RETURN;END IF;
  IF p_input->>'mode'='RECEIPT' THEN
    SELECT * INTO v_receipt FROM commerce_customer_context.customer_profile_source_receipts r WHERE r.tenant_id=p_tenant_id AND r.issuer=p_input->>'issuer' AND r.namespace=p_input->>'namespace' AND r.record_type=p_input->>'recordType' AND r.effect_id=p_input->>'effectId';
    IF NOT FOUND OR (v_receipt.profile_kind='RETAIL' AND v_receipt.legal_entity_id<>p_legal_entity_id) THEN RETURN QUERY SELECT 'NOT_FOUND',NULL::jsonb;RETURN;END IF;
    IF v_receipt.owner_evidence IS NULL THEN RETURN QUERY SELECT 'UNAVAILABLE',NULL::jsonb;RETURN;END IF;
    SELECT * INTO v_binding FROM commerce_customer_context.customer_profile_source_bindings b WHERE b.tenant_id=p_tenant_id AND b.issuer=v_receipt.issuer AND b.namespace=v_receipt.namespace AND b.record_type=v_receipt.record_type AND b.record_id=v_receipt.record_id AND b.customer_profile_id=v_receipt.customer_profile_id;
    IF NOT FOUND THEN RETURN QUERY SELECT 'UNAVAILABLE',NULL::jsonb;RETURN;END IF;
    v_item:=commerce_customer_context.customer_profile_source_item(p_tenant_id,p_legal_entity_id,to_jsonb(v_binding));
    IF v_item IS NULL THEN RETURN QUERY SELECT 'UNAVAILABLE',NULL::jsonb;RETURN;END IF;
    RETURN QUERY SELECT 'AVAILABLE',jsonb_build_object('_tag','RECEIPT','current',v_item,'receipt',jsonb_build_object('profileKind',v_receipt.profile_kind,'intent',v_receipt.intent,'result',v_receipt.result,'actionInvocationId',v_receipt.action_invocation_id::text,'actorPrincipalId',v_receipt.actor_principal_id::text,'recordedAt',to_char(v_receipt.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));RETURN;
  END IF;
  IF p_input->>'mode'='CURRENT' THEN
    SELECT * INTO v_binding FROM commerce_customer_context.customer_profile_source_bindings b WHERE b.tenant_id=p_tenant_id AND b.issuer=p_input->>'issuer' AND b.namespace=p_input->>'namespace' AND b.record_type=p_input->>'recordType' AND b.record_id=p_input->>'recordId';
    IF NOT FOUND THEN RETURN QUERY SELECT 'AVAILABLE',jsonb_build_object('_tag','ABSENT');RETURN;END IF;
    v_item:=commerce_customer_context.customer_profile_source_item(p_tenant_id,p_legal_entity_id,to_jsonb(v_binding));
    IF v_item IS NULL THEN RETURN QUERY SELECT 'UNAVAILABLE',NULL::jsonb;RETURN;END IF;
    RETURN QUERY SELECT 'AVAILABLE',jsonb_build_object('_tag','CURRENT','item',v_item);RETURN;
  END IF;
  v_limit:=(p_input->>'limit')::integer;
  IF p_input->>'mode'<>'LIST' OR v_limit NOT BETWEEN 1 AND 100 THEN RETURN QUERY SELECT 'UNAVAILABLE',NULL::jsonb;RETURN;END IF;
  FOR v_binding IN SELECT * FROM commerce_customer_context.customer_profile_source_bindings b WHERE b.tenant_id=p_tenant_id AND b.issuer=p_input->>'issuer' AND b.namespace=p_input->>'namespace' AND b.record_type=p_input->>'recordType' AND (b.profile_kind='COUNTERPARTY' OR b.legal_entity_id=p_legal_entity_id) AND (p_input->>'cursor' IS NULL OR b.record_id COLLATE "C">(p_input->>'cursor') COLLATE "C") ORDER BY b.record_id COLLATE "C" LIMIT v_limit+1 LOOP
    IF v_count=v_limit THEN v_cursor:=v_items->-1->'source'->>'recordId';EXIT;END IF;
    v_item:=commerce_customer_context.customer_profile_source_item(p_tenant_id,p_legal_entity_id,to_jsonb(v_binding));
    IF v_item IS NULL THEN RETURN QUERY SELECT 'UNAVAILABLE',NULL::jsonb;RETURN;END IF;
    v_items:=v_items||jsonb_build_array(v_item);v_count:=v_count+1;
  END LOOP;
  RETURN QUERY SELECT 'AVAILABLE',jsonb_build_object('_tag','PAGE','items',v_items,'nextCursor',v_cursor);
END;$$;
