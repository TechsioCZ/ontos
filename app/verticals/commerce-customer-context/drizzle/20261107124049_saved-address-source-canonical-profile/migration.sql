CREATE OR REPLACE FUNCTION commerce_customer_context.read_saved_address_source_receipt(
 p_tenant_id uuid,p_legal_entity_id uuid,p_actor_id uuid,p_original_actor_id uuid,p_expected_auth_context_ref text,p_input jsonb
) RETURNS TABLE(outcome text,result jsonb,recorded_principal_id uuid,recorded_action_key text,recorded_auth_context_ref text) LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path=pg_catalog,commerce_customer_context,pg_temp SET row_security=on AS $$
DECLARE v_source jsonb:=p_input->'source'; v_receipt commerce_customer_context.saved_address_source_receipts%ROWTYPE; v_binding commerce_customer_context.saved_address_source_bindings%ROWTYPE; v_address commerce_customer_context.saved_addresses%ROWTYPE; v_profile jsonb;
BEGIN
 IF p_tenant_id IS NULL OR p_legal_entity_id IS NULL OR p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id',true),'')::uuid OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id',true),'')::uuid THEN RAISE EXCEPTION 'Commerce scope mismatch' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM commerce_customer_context.saved_address_source_routes r WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.active AND r.principal_id=(CASE WHEN p_input->>'mode'='RECEIPT' THEN p_original_actor_id ELSE p_actor_id END) AND r.route_ref=v_source->'identity'->>'routeRef' AND r.route_revision=v_source->>'routeRevision' AND r.mapping_revision=v_source->>'mappingRevision' AND r.issuer=v_source->'identity'->>'issuer' AND r.namespace=v_source->'identity'->>'namespace' AND r.record_type=v_source->'identity'->>'recordType') THEN RETURN QUERY SELECT 'SOURCE_AUTHORITY_DENIED'::text,NULL::jsonb,NULL::uuid,NULL::text,NULL::text; RETURN; END IF;
 IF p_input->'profile'->'profileRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text THEN RETURN QUERY SELECT 'NOT_FOUND'::text,NULL::jsonb,NULL::uuid,NULL::text,NULL::text; RETURN; END IF;
 IF p_input->>'mode'='CURRENT' THEN
  SELECT CASE profile.profile_kind
    WHEN 'RETAIL' THEN jsonb_build_object(
      'kind','RETAIL','profileRef',jsonb_build_object(
        'moduleId','commerce.customer-context','resourceType','commerce.customer-context.retail-customer-profile',
        'resourceId',profile.customer_profile_id,'tenantId',p_tenant_id))
    WHEN 'COUNTERPARTY' THEN jsonb_build_object(
      'kind','COUNTERPARTY','profileRef',jsonb_build_object(
        'moduleId','commerce.customer-context','resourceType','commerce.customer-context.counterparty-purchasing-profile',
        'resourceId',profile.customer_profile_id,'tenantId',p_tenant_id),
      'counterpartyRef',jsonb_build_object(
        'moduleId','party.registry','resourceType','party.registry.counterparty',
        'resourceId',counterparty.counterparty_resource_id,'tenantId',p_tenant_id))
    END INTO v_profile
  FROM commerce_customer_context.customer_profiles profile
  LEFT JOIN commerce_customer_context.retail_customer_profiles retail
    ON retail.tenant_id=profile.tenant_id AND retail.legal_entity_id=profile.legal_entity_id
      AND retail.retail_customer_profile_id=profile.customer_profile_id
  LEFT JOIN commerce_customer_context.counterparty_purchasing_profiles counterparty
    ON counterparty.tenant_id=profile.tenant_id AND counterparty.legal_entity_id=profile.legal_entity_id
      AND counterparty.counterparty_purchasing_profile_id=profile.customer_profile_id
  WHERE profile.tenant_id=p_tenant_id AND profile.legal_entity_id=p_legal_entity_id
    AND profile.customer_profile_id=(p_input->'profile'->'profileRef'->>'resourceId')::uuid
    AND ((profile.profile_kind='RETAIL' AND retail.retail_customer_profile_id IS NOT NULL)
      OR (profile.profile_kind='COUNTERPARTY' AND counterparty.counterparty_purchasing_profile_id IS NOT NULL));
  IF NOT FOUND OR v_profile IS DISTINCT FROM p_input->'profile' THEN
    RETURN QUERY SELECT 'NOT_FOUND'::text,NULL::jsonb,NULL::uuid,NULL::text,NULL::text; RETURN;
  END IF;
  SELECT * INTO v_binding FROM commerce_customer_context.saved_address_source_bindings b WHERE b.tenant_id=p_tenant_id AND b.legal_entity_id=p_legal_entity_id AND b.customer_profile_id=(p_input->'profile'->'profileRef'->>'resourceId')::uuid AND b.issuer=v_source->'identity'->>'issuer' AND b.namespace=v_source->'identity'->>'namespace' AND b.record_type=v_source->'identity'->>'recordType' AND b.record_id=v_source->'identity'->>'recordId';
  IF NOT FOUND THEN RETURN QUERY SELECT 'AVAILABLE'::text,jsonb_build_object('_tag','ABSENT'),NULL::uuid,NULL::text,NULL::text; RETURN; END IF;
  SELECT * INTO v_address FROM commerce_customer_context.saved_addresses a WHERE a.tenant_id=p_tenant_id AND a.legal_entity_id=p_legal_entity_id AND a.saved_address_id=v_binding.saved_address_id AND a.customer_profile_id=v_binding.customer_profile_id;
  IF NOT FOUND THEN RETURN QUERY SELECT 'NOT_FOUND'::text,NULL::jsonb,NULL::uuid,NULL::text,NULL::text; RETURN; END IF;
  RETURN QUERY SELECT 'AVAILABLE'::text,jsonb_build_object('_tag','CURRENT','profile',v_profile,'savedAddressRef',jsonb_build_object('moduleId','commerce.customer-context','resourceType','commerce.customer-context.saved-address','resourceId',v_address.saved_address_id,'tenantId',p_tenant_id),'revision',v_address.revision,'lifecycle',v_address.lifecycle,'purposes',v_address.purposes),NULL::uuid,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO v_receipt FROM commerce_customer_context.saved_address_source_receipts r WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.action_invocation_id=(p_input->>'actionInvocationId')::uuid AND r.actor_principal_id=p_original_actor_id AND r.action_key=p_input->>'actionKey' AND r.request_hash=p_input->>'requestHash' AND r.issuer=v_source->'identity'->>'issuer' AND r.namespace=v_source->'identity'->>'namespace' AND r.effect_id=v_source->>'effectId' AND r.source=v_source AND r.result->'profile'=p_input->'profile' AND (p_expected_auth_context_ref IS NULL OR r.recorded_auth_context_ref=p_expected_auth_context_ref);
 IF NOT FOUND THEN RETURN QUERY SELECT 'NOT_FOUND'::text,NULL::jsonb,NULL::uuid,NULL::text,NULL::text; RETURN; END IF;
 RETURN QUERY SELECT 'AVAILABLE'::text,jsonb_build_object('_tag','RECEIPT','receipt',v_receipt.result),v_receipt.actor_principal_id,v_receipt.action_key,v_receipt.recorded_auth_context_ref;
END; $$;
