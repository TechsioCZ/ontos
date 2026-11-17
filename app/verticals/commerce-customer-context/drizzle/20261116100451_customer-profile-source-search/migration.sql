CREATE FUNCTION commerce_customer_context.customer_profile_source_search_match(p_record_id text,p_party_id text,p_search jsonb)
RETURNS boolean LANGUAGE sql STABLE
SET search_path=pg_catalog,pg_temp
AS $$
  SELECT p_search IS NULL OR NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_search->'terms') AS t(entry)
    WHERE NOT (
      position(lower(t.entry->>'term') in lower(p_record_id))>0
      OR p_party_id IN (SELECT jsonb_array_elements_text(t.entry->'partyIds'))
    )
  );
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.customer_profile_source_search_match(text,text,jsonb) FROM PUBLIC,ontos_runtime;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION commerce_customer_context.read_customer_profile_source_page(p_tenant_id uuid,p_legal_entity_id uuid,p_principal_id uuid,p_input jsonb)
RETURNS TABLE(outcome text,result jsonb) LANGUAGE plpgsql SECURITY DEFINER
SET row_security = on
SET search_path=pg_catalog,commerce_customer_context,pg_temp
AS $$
DECLARE v_binding commerce_customer_context.customer_profile_source_bindings%ROWTYPE;v_item jsonb;v_items jsonb:='[]'::jsonb;v_limit integer;v_offset integer;v_total integer;v_search jsonb:=p_input->'search';
BEGIN
  PERFORM commerce_customer_context.assert_profile_operation_scope(p_tenant_id,p_legal_entity_id);
  PERFORM 1 FROM commerce_customer_context.customer_profile_source_routes r WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.route_id=p_input->'route'->>'id' AND r.route_revision=p_input->'route'->>'revision' AND r.mapping_revision=p_input->>'mappingRevision' AND r.issuer=p_input->>'issuer' AND r.namespace=p_input->>'namespace' AND r.record_type=p_input->>'recordType' AND (r.principal_id=p_principal_id OR p_principal_id=ANY(r.source_reader_principal_ids)) AND r.active FOR SHARE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'SOURCE_AUTHORITY_DENIED',NULL::jsonb;RETURN;END IF;
  v_limit:=(p_input->>'limit')::integer;v_offset:=(p_input->>'offset')::integer;
  IF v_limit IS NULL OR v_limit NOT BETWEEN 1 AND 100 OR v_offset IS NULL OR v_offset<0 THEN RETURN QUERY SELECT 'UNAVAILABLE',NULL::jsonb;RETURN;END IF;
  IF v_search IS NOT NULL AND (jsonb_typeof(v_search->'terms')<>'array' OR jsonb_array_length(v_search->'terms') NOT BETWEEN 1 AND 10 OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_search->'terms') AS t(entry) WHERE jsonb_typeof(t.entry->'partyIds')<>'array' OR jsonb_array_length(t.entry->'partyIds')>500 OR length(coalesce(t.entry->>'term',''))=0)) THEN RETURN QUERY SELECT 'UNAVAILABLE',NULL::jsonb;RETURN;END IF;
  SELECT count(*) INTO v_total FROM commerce_customer_context.customer_profile_source_bindings b WHERE b.tenant_id=p_tenant_id AND b.issuer=p_input->>'issuer' AND b.namespace=p_input->>'namespace' AND b.record_type=p_input->>'recordType' AND (b.profile_kind='COUNTERPARTY' OR b.legal_entity_id=p_legal_entity_id) AND commerce_customer_context.customer_profile_source_search_match(b.record_id,b.party_resource_id,v_search);
  FOR v_binding IN SELECT * FROM commerce_customer_context.customer_profile_source_bindings b WHERE b.tenant_id=p_tenant_id AND b.issuer=p_input->>'issuer' AND b.namespace=p_input->>'namespace' AND b.record_type=p_input->>'recordType' AND (b.profile_kind='COUNTERPARTY' OR b.legal_entity_id=p_legal_entity_id) AND commerce_customer_context.customer_profile_source_search_match(b.record_id,b.party_resource_id,v_search) ORDER BY b.record_id COLLATE "C" LIMIT v_limit OFFSET v_offset LOOP
    v_item:=commerce_customer_context.customer_profile_source_item(p_tenant_id,p_legal_entity_id,to_jsonb(v_binding));
    IF v_item IS NULL THEN RETURN QUERY SELECT 'UNAVAILABLE',NULL::jsonb;RETURN;END IF;
    v_items:=v_items||jsonb_build_array(v_item);
  END LOOP;
  RETURN QUERY SELECT 'AVAILABLE',jsonb_build_object('count',v_total,'items',v_items);
END;$$;
--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.read_customer_profile_source_parties(p_tenant_id uuid,p_legal_entity_id uuid,p_principal_id uuid,p_input jsonb)
RETURNS TABLE(outcome text,result jsonb) LANGUAGE plpgsql SECURITY DEFINER
SET row_security = on
SET search_path=pg_catalog,commerce_customer_context,pg_temp
AS $$
DECLARE v_limit integer;v_total integer;v_items jsonb;
BEGIN
  PERFORM commerce_customer_context.assert_profile_operation_scope(p_tenant_id,p_legal_entity_id);
  PERFORM 1 FROM commerce_customer_context.customer_profile_source_routes r WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.route_id=p_input->'route'->>'id' AND r.route_revision=p_input->'route'->>'revision' AND r.mapping_revision=p_input->>'mappingRevision' AND r.issuer=p_input->>'issuer' AND r.namespace=p_input->>'namespace' AND r.record_type=p_input->>'recordType' AND (r.principal_id=p_principal_id OR p_principal_id=ANY(r.source_reader_principal_ids)) AND r.active FOR SHARE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'SOURCE_AUTHORITY_DENIED',NULL::jsonb;RETURN;END IF;
  v_limit:=(p_input->>'limit')::integer;
  IF v_limit IS NULL OR v_limit NOT BETWEEN 1 AND 500 THEN RETURN QUERY SELECT 'UNAVAILABLE',NULL::jsonb;RETURN;END IF;
  SELECT count(*) INTO v_total FROM commerce_customer_context.customer_profile_source_bindings b WHERE b.tenant_id=p_tenant_id AND b.issuer=p_input->>'issuer' AND b.namespace=p_input->>'namespace' AND b.record_type=p_input->>'recordType' AND (b.profile_kind='COUNTERPARTY' OR b.legal_entity_id=p_legal_entity_id);
  SELECT coalesce(jsonb_agg(jsonb_build_object('recordId',c.record_id,'partyRef',jsonb_build_object('moduleId','party.registry','resourceType','party.registry.party','resourceId',c.party_resource_id,'tenantId',p_tenant_id::text),'partySourceReference',c.source_intent->'partySourceReference') ORDER BY c.record_id COLLATE "C"),'[]'::jsonb) INTO v_items FROM (SELECT b.record_id,b.party_resource_id,b.source_intent FROM commerce_customer_context.customer_profile_source_bindings b WHERE b.tenant_id=p_tenant_id AND b.issuer=p_input->>'issuer' AND b.namespace=p_input->>'namespace' AND b.record_type=p_input->>'recordType' AND (b.profile_kind='COUNTERPARTY' OR b.legal_entity_id=p_legal_entity_id) ORDER BY b.record_id COLLATE "C" LIMIT v_limit) c;
  RETURN QUERY SELECT 'AVAILABLE',jsonb_build_object('count',v_total,'items',v_items);
END;$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.read_customer_profile_source_parties(uuid,uuid,uuid,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.read_customer_profile_source_parties(uuid,uuid,uuid,jsonb) TO ontos_runtime;
