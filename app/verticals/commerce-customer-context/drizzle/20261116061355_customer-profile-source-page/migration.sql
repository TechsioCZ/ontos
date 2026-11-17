CREATE FUNCTION commerce_customer_context.read_customer_profile_source_page(p_tenant_id uuid,p_legal_entity_id uuid,p_principal_id uuid,p_input jsonb)
RETURNS TABLE(outcome text,result jsonb) LANGUAGE plpgsql SECURITY DEFINER
SET row_security = on
SET search_path=pg_catalog,commerce_customer_context,pg_temp
AS $$
DECLARE v_binding commerce_customer_context.customer_profile_source_bindings%ROWTYPE;v_item jsonb;v_items jsonb:='[]'::jsonb;v_limit integer;v_offset integer;v_total integer;
BEGIN
  PERFORM commerce_customer_context.assert_profile_operation_scope(p_tenant_id,p_legal_entity_id);
  PERFORM 1 FROM commerce_customer_context.customer_profile_source_routes r WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.route_id=p_input->'route'->>'id' AND r.route_revision=p_input->'route'->>'revision' AND r.mapping_revision=p_input->>'mappingRevision' AND r.issuer=p_input->>'issuer' AND r.namespace=p_input->>'namespace' AND r.record_type=p_input->>'recordType' AND (r.principal_id=p_principal_id OR p_principal_id=ANY(r.source_reader_principal_ids)) AND r.active FOR SHARE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'SOURCE_AUTHORITY_DENIED',NULL::jsonb;RETURN;END IF;
  v_limit:=(p_input->>'limit')::integer;v_offset:=(p_input->>'offset')::integer;
  IF v_limit IS NULL OR v_limit NOT BETWEEN 1 AND 100 OR v_offset IS NULL OR v_offset<0 THEN RETURN QUERY SELECT 'UNAVAILABLE',NULL::jsonb;RETURN;END IF;
  SELECT count(*) INTO v_total FROM commerce_customer_context.customer_profile_source_bindings b WHERE b.tenant_id=p_tenant_id AND b.issuer=p_input->>'issuer' AND b.namespace=p_input->>'namespace' AND b.record_type=p_input->>'recordType' AND (b.profile_kind='COUNTERPARTY' OR b.legal_entity_id=p_legal_entity_id);
  FOR v_binding IN SELECT * FROM commerce_customer_context.customer_profile_source_bindings b WHERE b.tenant_id=p_tenant_id AND b.issuer=p_input->>'issuer' AND b.namespace=p_input->>'namespace' AND b.record_type=p_input->>'recordType' AND (b.profile_kind='COUNTERPARTY' OR b.legal_entity_id=p_legal_entity_id) ORDER BY b.record_id COLLATE "C" LIMIT v_limit OFFSET v_offset LOOP
    v_item:=commerce_customer_context.customer_profile_source_item(p_tenant_id,p_legal_entity_id,to_jsonb(v_binding));
    IF v_item IS NULL THEN RETURN QUERY SELECT 'UNAVAILABLE',NULL::jsonb;RETURN;END IF;
    v_items:=v_items||jsonb_build_array(v_item);
  END LOOP;
  RETURN QUERY SELECT 'AVAILABLE',jsonb_build_object('count',v_total,'items',v_items);
END;$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.read_customer_profile_source_page(uuid,uuid,uuid,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.read_customer_profile_source_page(uuid,uuid,uuid,jsonb) TO ontos_runtime;
