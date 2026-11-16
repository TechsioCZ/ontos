CREATE FUNCTION commerce_customer_context.read_customer_group_definition_source(
  p_tenant_id uuid, p_legal_entity_id uuid, p_actor_principal_id uuid, p_input jsonb
) RETURNS TABLE (outcome text, result jsonb)
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = pg_catalog, commerce_customer_context, pg_temp SET row_security = on AS $$
DECLARE
  v_binding commerce_customer_context.customer_group_definition_source_bindings%ROWTYPE;
  v_receipt commerce_customer_context.customer_group_definition_source_receipts%ROWTYPE;
BEGIN
  IF p_tenant_id IS NULL OR p_legal_entity_id IS NULL
    OR p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id',true),'')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id',true),'')::uuid
  THEN RAISE EXCEPTION 'Commerce scope mismatch' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM commerce_customer_context.customer_group_definition_source_routes r
    WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.active
      AND r.route_id=p_input->'route'->>'id' AND r.route_revision=p_input->'route'->>'revision'
      AND r.principal_id=p_actor_principal_id AND r.issuer=p_input->>'issuer' AND r.namespace=p_input->>'namespace')
  THEN RETURN QUERY SELECT 'SOURCE_AUTHORITY_DENIED'::text,NULL::jsonb; RETURN; END IF;
  IF p_input->>'mode'='CURRENT' THEN
    SELECT * INTO v_binding FROM commerce_customer_context.customer_group_definition_source_bindings b
      WHERE b.tenant_id=p_tenant_id AND b.legal_entity_id=p_legal_entity_id AND b.issuer=p_input->>'issuer'
        AND b.namespace=p_input->>'namespace' AND b.record_id=p_input->>'recordId';
    IF NOT FOUND THEN RETURN QUERY SELECT 'FOUND'::text,jsonb_build_object('_tag','ABSENT'); RETURN; END IF;
    RETURN QUERY SELECT 'FOUND'::text,jsonb_build_object('_tag','CURRENT',
      'group',commerce_customer_context.customer_group_document(p_tenant_id,p_legal_entity_id,v_binding.customer_group_id),
      'source',v_binding.source_intent->'payload'->'source'); RETURN;
  ELSIF p_input->>'mode'='RECEIPT' THEN
    SELECT * INTO v_receipt FROM commerce_customer_context.customer_group_definition_source_receipts r
      WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.issuer=p_input->>'issuer'
        AND r.namespace=p_input->>'namespace' AND r.effect_id=p_input->>'effectId';
    IF NOT FOUND THEN RETURN QUERY SELECT 'NOT_FOUND'::text,NULL::jsonb; RETURN; END IF;
    RETURN QUERY SELECT 'FOUND'::text,jsonb_build_object('_tag','RECEIPT','group',v_receipt.result->'group',
      'operation',v_receipt.intent->>'operation','source',v_receipt.intent->'payload'->'source'); RETURN;
  END IF;
  RETURN QUERY SELECT 'NOT_FOUND'::text,NULL::jsonb;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.read_customer_group_definition_source(uuid,uuid,uuid,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.read_customer_group_definition_source(uuid,uuid,uuid,jsonb) TO ontos_runtime;
