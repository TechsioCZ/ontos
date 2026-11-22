CREATE OR REPLACE FUNCTION symmy_integration.record_symmy_resolved_effect(p_tenant uuid,p_job uuid,p_effect uuid,p_token uuid,p_version integer,p_resolved jsonb)
RETURNS TABLE(applied boolean) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, symmy_integration, pg_temp SET row_security = on AS $$
DECLARE v_effect symmy_integration.job_effects%ROWTYPE; v_count integer; v_expected_policy jsonb; v_admitted_policy jsonb;
BEGIN
  IF p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id',true),'')::uuid THEN
    RAISE EXCEPTION 'tenant scope mismatch' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_effect FROM symmy_integration.job_effects e WHERE e.tenant_id=p_tenant AND e.job_id=p_job AND e.effect_id=p_effect FOR UPDATE;
  IF NOT FOUND OR v_effect.state<>'attempting' OR v_effect.claim_token IS DISTINCT FROM p_token OR v_effect.version<>p_version OR v_effect.lease_until<=clock_timestamp() THEN
    RETURN QUERY SELECT false; RETURN; END IF;
  IF jsonb_typeof(p_resolved) IS DISTINCT FROM 'object'
    OR (p_resolved-'intent'-'ref') IS DISTINCT FROM (v_effect.effect-'intent'-'ref')
    OR ((p_resolved->'ref')-'originalTarget') IS DISTINCT FROM ((v_effect.effect->'ref')-'originalTarget')
    OR (v_effect.effect#>'{ref,originalTarget}' IS NOT NULL AND p_resolved#>'{ref,originalTarget}' IS DISTINCT FROM v_effect.effect#>'{ref,originalTarget}')
    OR (p_resolved#>'{ref,originalTarget}' IS NOT NULL AND
      (p_resolved#>>'{ref,originalTarget,tenantId}' IS DISTINCT FROM p_tenant::text OR p_resolved#>>'{ref,originalTarget,moduleId}' IS DISTINCT FROM v_effect.effect#>>'{ref,operation,moduleId}')) THEN
      RAISE EXCEPTION 'resolved effect changes original identity' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(v_effect.effect->'intent') IS DISTINCT FROM 'object'
    OR jsonb_typeof(v_effect.effect#>'{intent,_tag}') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_resolved->'intent') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_resolved#>'{intent,_tag}') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'invalid dependent command intent' USING ERRCODE='22023'; END IF;
  IF v_effect.effect#>>'{intent,request,_tag}' = 'ProvisionSourceStockItem' THEN
    v_expected_policy := p_resolved#>'{intent,payload,expectedPolicy}';
    v_admitted_policy := (v_effect.effect#>'{intent,request,source}') - 'policyRef';
    IF p_resolved#>>'{intent,_tag}' IS DISTINCT FROM 'InventoryProvision'
      OR p_resolved#>'{intent,source}' IS DISTINCT FROM v_effect.effect#>'{intent,request,source}'
      OR p_resolved#>'{intent,payload,itemKey}' IS DISTINCT FROM v_effect.effect#>'{intent,request,itemKey}'
      OR p_resolved#>'{intent,payload,policyRef}' IS DISTINCT FROM v_effect.effect#>'{intent,request,source,policyRef}'
      OR p_resolved#>'{ref,originalTarget}' IS DISTINCT FROM v_effect.effect#>'{intent,request,source,policyRef}'
      OR jsonb_typeof(v_expected_policy) IS DISTINCT FROM 'object'
      OR (v_expected_policy-'locations') IS DISTINCT FROM (v_admitted_policy-'locations')
      OR jsonb_typeof(v_expected_policy->'locations') IS DISTINCT FROM 'array'
      OR jsonb_typeof(v_admitted_policy->'locations') IS DISTINCT FROM 'array'
      OR (SELECT jsonb_agg(location ORDER BY location) FROM jsonb_array_elements(v_expected_policy->'locations') AS location)
        IS DISTINCT FROM
        (SELECT jsonb_agg(location ORDER BY location) FROM jsonb_array_elements(v_admitted_policy->'locations') AS location)
    THEN RAISE EXCEPTION 'provisioning resolution changes admitted source' USING ERRCODE='22023'; END IF;
  END IF;
  IF v_effect.resolved_effect IS NOT NULL THEN RETURN QUERY SELECT v_effect.resolved_effect=p_resolved; RETURN; END IF;
  IF v_effect.owner_executor_principal_id IS NOT NULL THEN RETURN QUERY SELECT false; RETURN; END IF;
  IF NOT COALESCE(((v_effect.effect#>>'{intent,_tag}'='PriceDefineFromGroupEffect' AND p_resolved#>>'{intent,_tag}'='PriceDefine')
    OR (v_effect.effect#>>'{intent,_tag}'='PriceGroupCreateAtCatalogHead' AND p_resolved#>>'{intent,_tag}'='PriceGroupCreate')
    OR (v_effect.effect#>>'{intent,_tag}'='CatalogCreateVariantFromProductEffect' AND p_resolved#>>'{intent,_tag}'='CatalogCreateVariant')
    OR (v_effect.effect#>>'{intent,_tag}'='CatalogProductDependentEffect' AND (
      (v_effect.effect#>>'{intent,request,_tag}'='AddProductCategoryAssignment'
        AND p_resolved#>>'{intent,_tag}'='CatalogAddProductCategoryAssignment'
        AND p_resolved#>>'{intent,payload,categoryRef,tenantId}'=p_tenant::text
        AND p_resolved#>>'{ref,originalTarget,tenantId}'=p_tenant::text
        AND p_resolved#>>'{ref,originalTarget,moduleId}'='commerce.catalog'
        AND p_resolved#>>'{ref,originalTarget,resourceType}'='commerce.catalog.product'
        AND p_resolved#>'{intent,payload}' = ((v_effect.effect#>'{intent,request,payload}') ||
          jsonb_build_object('productRef',p_resolved#>'{ref,originalTarget}')))
      OR (v_effect.effect#>>'{intent,request,_tag}'='UpdateProduct' AND p_resolved#>>'{intent,_tag}'='CatalogUpdateProduct')
      OR (v_effect.effect#>>'{intent,request,_tag}'='SetVariantLocalizedFacts' AND p_resolved#>>'{intent,_tag}'='CatalogSetVariantLocalizedFacts')
      OR (v_effect.effect#>>'{intent,request,_tag}'='ProvisionSourceStockItem' AND p_resolved#>>'{intent,_tag}'='InventoryProvision')
      OR (v_effect.effect#>>'{intent,request,_tag}'='CatalogReadiness' AND (
        (v_effect.effect#>>'{intent,request,step}'='AXES' AND p_resolved#>>'{intent,_tag}'='CatalogReadinessAxes') OR
        (v_effect.effect#>>'{intent,request,step}'='CONFIRM' AND p_resolved#>>'{intent,_tag}'='CatalogReadinessConfirm') OR
        (v_effect.effect#>>'{intent,request,step}'='NAME' AND p_resolved#>>'{intent,_tag}'='CatalogReadinessName') OR
        (v_effect.effect#>>'{intent,request,step}'='ACTIVATE' AND p_resolved#>>'{intent,_tag}'='CatalogUpdateProduct') OR
        (v_effect.effect#>>'{intent,request,step}'='UNIT' AND p_resolved#>>'{intent,_tag}'='CatalogReadinessUnit') OR
        (v_effect.effect#>>'{intent,request,step}'='UNTYPED' AND p_resolved#>>'{intent,_tag}'='CatalogReadinessUntyped')))
      OR (v_effect.effect#>>'{intent,request,_tag}'='DefinePrice' AND p_resolved#>>'{intent,_tag}'='PriceDefine')))
    OR (v_effect.effect#>>'{intent,_tag}'='EnsureRetailProfileFromParty' AND p_resolved#>>'{intent,_tag}'='EnsureRetailProfile')
    OR (v_effect.effect#>>'{intent,_tag}'='OnboardCounterpartyCustomerFromParty' AND p_resolved#>>'{intent,_tag}'='OnboardCounterpartyCustomer')
    OR (v_effect.effect#>>'{intent,_tag}'='AddPartyContactPointFromParty' AND p_resolved#>>'{intent,_tag}'='AddPartyContactPoint')
    OR (v_effect.effect#>>'{intent,_tag}'='AddSavedRetailAddressFromOwnerReceipts' AND p_resolved#>>'{intent,_tag}'='AddSavedAddress')
    OR (v_effect.effect#>>'{intent,_tag}'='AddSavedCounterpartyAddressFromOwnerReceipts' AND p_resolved#>>'{intent,_tag}'='AddSavedAddress')
    OR (v_effect.effect#>>'{intent,_tag}'='AddSavedRetailAddressFromProfileEffect' AND p_resolved#>>'{intent,_tag}'='AddSavedAddress')
    OR (v_effect.effect#>>'{intent,_tag}'='AddSavedCounterpartyAddressFromProfileEffect' AND p_resolved#>>'{intent,_tag}'='AddSavedAddress')
    OR (v_effect.effect#>>'{intent,_tag}'='OrganizationCustomerProfileIcoFromProfileEffect' AND p_resolved#>>'{intent,_tag}'='OrganizationCustomerProfileIco')
    OR (v_effect.effect#>>'{intent,_tag}'='CreateCounterpartyProfileFromCounterparty' AND p_resolved#>>'{intent,_tag}'='CreateCounterpartyProfile')), false) THEN
      RAISE EXCEPTION 'unsupported dependent command resolution' USING ERRCODE='22023'; END IF;
  UPDATE symmy_integration.job_effects SET resolved_effect=p_resolved WHERE tenant_id=p_tenant AND effect_id=p_effect;
  RETURN QUERY SELECT true;
END; $$;


