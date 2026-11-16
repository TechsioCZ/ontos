CREATE OR REPLACE FUNCTION commerce_customer_context.customer_profile_source_item(p_tenant_id uuid,p_legal_entity_id uuid,p_binding jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET row_security = on
SET search_path=pg_catalog,commerce_customer_context,pg_temp
AS $$
DECLARE v_profile record;v_ref jsonb;v_subject jsonb;
BEGIN
  IF p_binding->>'profile_kind'='RETAIL' AND p_binding->>'legal_entity_id'<>p_legal_entity_id::text THEN RETURN NULL;END IF;
  SELECT * INTO v_profile FROM commerce_customer_context.read_customer_profile(p_tenant_id,p_legal_entity_id,(p_binding->>'customer_profile_id')::uuid,p_binding->>'profile_kind');
  IF v_profile.outcome<>'PROFILE_AVAILABLE' THEN RETURN NULL;END IF;
  v_ref:=jsonb_build_object('moduleId','commerce.customer-context','resourceId',p_binding->>'customer_profile_id','resourceType',CASE WHEN p_binding->>'profile_kind'='RETAIL' THEN 'commerce.customer-context.retail-customer-profile' ELSE 'commerce.customer-context.counterparty-purchasing-profile' END,'tenantId',p_tenant_id::text,'kind',p_binding->>'profile_kind');
  IF p_binding->>'profile_kind'='RETAIL' THEN
    IF v_profile.payload->'subject'->>'partyResourceId' IS DISTINCT FROM p_binding->>'party_resource_id' THEN RETURN NULL;END IF;
    v_subject:=jsonb_build_object('kind','RETAIL','partyRef',jsonb_build_object('moduleId','party.registry','resourceType','party.registry.party','resourceId',p_binding->>'party_resource_id','tenantId',p_tenant_id::text),'sellingLegalEntityRef',jsonb_build_object('moduleId','core.identity','resourceType','core.identity.legal-entity','resourceId',p_legal_entity_id::text,'tenantId',p_tenant_id::text));
  ELSE
    IF v_profile.payload->'subject'->>'counterpartyResourceId' IS DISTINCT FROM p_binding->'source_intent'->'subject'->'counterpartyRef'->>'resourceId' THEN RETURN NULL;END IF;
    v_subject:=jsonb_build_object('kind','COUNTERPARTY','counterpartyRef',p_binding->'source_intent'->'subject'->'counterpartyRef');
  END IF;
  RETURN jsonb_build_object('partySourceReference',p_binding->'source_intent'->'partySourceReference','source',p_binding->'source_intent'->'source','partyRef',jsonb_build_object('moduleId','party.registry','resourceType','party.registry.party','resourceId',p_binding->>'party_resource_id','tenantId',p_tenant_id::text),'profile',jsonb_build_object('profileRef',v_ref,'subject',v_subject,'revision',v_profile.payload->'revision','state',v_profile.payload->'state'));
END;$$;
