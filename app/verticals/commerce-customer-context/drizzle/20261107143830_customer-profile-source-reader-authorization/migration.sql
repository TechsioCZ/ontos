CREATE OR REPLACE FUNCTION commerce_customer_context.read_customer_profile_source(p_tenant_id uuid,p_legal_entity_id uuid,p_principal_id uuid,p_input jsonb)
RETURNS TABLE(outcome text,result jsonb) LANGUAGE plpgsql SECURITY DEFINER
SET row_security = on
SET search_path=pg_catalog,commerce_customer_context,pg_temp
AS $$
DECLARE v_route record;v_binding commerce_customer_context.customer_profile_source_bindings%ROWTYPE;v_receipt commerce_customer_context.customer_profile_source_receipts%ROWTYPE;v_item jsonb;v_items jsonb:='[]'::jsonb;v_count integer:=0;v_limit integer;v_cursor text:=NULL;
BEGIN
  PERFORM commerce_customer_context.assert_profile_operation_scope(p_tenant_id,p_legal_entity_id);
  SELECT * INTO v_route FROM commerce_customer_context.customer_profile_source_routes r WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.route_id=p_input->'route'->>'id' AND r.route_revision=p_input->'route'->>'revision' AND r.mapping_revision=p_input->>'mappingRevision' AND r.issuer=p_input->>'issuer' AND r.namespace=p_input->>'namespace' AND r.record_type=p_input->>'recordType' AND (r.principal_id=p_principal_id OR p_principal_id=ANY(r.source_reader_principal_ids)) AND r.active FOR SHARE;
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
