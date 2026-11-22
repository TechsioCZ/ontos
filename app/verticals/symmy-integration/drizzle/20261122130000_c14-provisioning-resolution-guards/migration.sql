CREATE OR REPLACE FUNCTION symmy_integration.record_symmy_resolved_effect(p_tenant uuid,p_job uuid,p_effect uuid,p_token uuid,p_version integer,p_resolved jsonb)
RETURNS TABLE(applied boolean) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, symmy_integration, pg_temp SET row_security = on AS $$
DECLARE v_effect symmy_integration.job_effects%ROWTYPE; v_count integer;
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
  IF v_effect.effect#>>'{intent,request,_tag}' = 'ProvisionSourceStockItem' AND (
    p_resolved#>>'{intent,_tag}' IS DISTINCT FROM 'InventoryProvision'
    OR p_resolved#>'{intent,source}' IS DISTINCT FROM v_effect.effect#>'{intent,request,source}'
    OR p_resolved#>'{intent,payload,itemKey}' IS DISTINCT FROM v_effect.effect#>'{intent,request,itemKey}'
    OR p_resolved#>'{intent,payload,policyRef}' IS DISTINCT FROM v_effect.effect#>'{intent,request,source,policyRef}'
    OR p_resolved#>'{ref,originalTarget}' IS DISTINCT FROM v_effect.effect#>'{intent,request,source,policyRef}'
    OR p_resolved#>'{intent,payload,expectedPolicy}' IS DISTINCT FROM (v_effect.effect#>'{intent,request,source}' - 'policyRef')
  ) THEN RAISE EXCEPTION 'provisioning resolution changes admitted source' USING ERRCODE='22023'; END IF;
  IF v_effect.resolved_effect IS NOT NULL THEN RETURN QUERY SELECT v_effect.resolved_effect=p_resolved; RETURN; END IF;
  IF v_effect.owner_executor_principal_id IS NOT NULL THEN RETURN QUERY SELECT false; RETURN; END IF;
  IF NOT ((v_effect.effect#>>'{intent,_tag}'='PriceDefineFromGroupEffect' AND p_resolved#>>'{intent,_tag}'='PriceDefine')
    OR (v_effect.effect#>>'{intent,_tag}'='PriceGroupCreateAtCatalogHead' AND p_resolved#>>'{intent,_tag}'='PriceGroupCreate')
    OR (v_effect.effect#>>'{intent,_tag}'='CatalogCreateVariantFromProductEffect' AND p_resolved#>>'{intent,_tag}'='CatalogCreateVariant')
    OR (v_effect.effect#>>'{intent,_tag}'='CatalogProductDependentEffect' AND (
      (v_effect.effect#>>'{intent,request,_tag}'='UpdateProduct' AND p_resolved#>>'{intent,_tag}'='CatalogUpdateProduct')
      OR (v_effect.effect#>>'{intent,request,_tag}'='SetVariantLocalizedFacts' AND p_resolved#>>'{intent,_tag}'='CatalogSetVariantLocalizedFacts')
      OR (v_effect.effect#>>'{intent,request,_tag}'='ProvisionSourceStockItem' AND p_resolved#>>'{intent,_tag}'='InventoryProvision')
      OR (v_effect.effect#>>'{intent,request,_tag}'='DefinePrice' AND p_resolved#>>'{intent,_tag}'='PriceDefine')))
    OR (v_effect.effect#>>'{intent,_tag}'='EnsureRetailProfileFromParty' AND p_resolved#>>'{intent,_tag}'='EnsureRetailProfile')
    OR (v_effect.effect#>>'{intent,_tag}'='OnboardCounterpartyCustomerFromParty' AND p_resolved#>>'{intent,_tag}'='OnboardCounterpartyCustomer')
    OR (v_effect.effect#>>'{intent,_tag}'='AddPartyContactPointFromParty' AND p_resolved#>>'{intent,_tag}'='AddPartyContactPoint')
    OR (v_effect.effect#>>'{intent,_tag}'='AddSavedRetailAddressFromOwnerReceipts' AND p_resolved#>>'{intent,_tag}'='AddSavedAddress')
    OR (v_effect.effect#>>'{intent,_tag}'='AddSavedCounterpartyAddressFromOwnerReceipts' AND p_resolved#>>'{intent,_tag}'='AddSavedAddress')
    OR (v_effect.effect#>>'{intent,_tag}'='AddSavedRetailAddressFromProfileEffect' AND p_resolved#>>'{intent,_tag}'='AddSavedAddress')
    OR (v_effect.effect#>>'{intent,_tag}'='AddSavedCounterpartyAddressFromProfileEffect' AND p_resolved#>>'{intent,_tag}'='AddSavedAddress')
    OR (v_effect.effect#>>'{intent,_tag}'='OrganizationCustomerProfileIcoFromProfileEffect' AND p_resolved#>>'{intent,_tag}'='OrganizationCustomerProfileIco')
    OR (v_effect.effect#>>'{intent,_tag}'='CreateCounterpartyProfileFromCounterparty' AND p_resolved#>>'{intent,_tag}'='CreateCounterpartyProfile')) THEN
      RAISE EXCEPTION 'unsupported dependent command resolution' USING ERRCODE='22023'; END IF;
  UPDATE symmy_integration.job_effects SET resolved_effect=p_resolved WHERE tenant_id=p_tenant AND effect_id=p_effect;
  RETURN QUERY SELECT true;
END; $$;

--> statement-breakpoint
-- Keep every explicitly unsupported internal structural hint in the pinned receipt.
CREATE OR REPLACE FUNCTION symmy_integration.pin_symmy_fixture_plan(
  p_plan jsonb, p_tenant uuid, p_route uuid, p_revision text, p_mapping text
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, symmy_integration, pg_temp AS $$
DECLARE
  v_item jsonb;
  v_effect jsonb;
  v_items jsonb := '[]'::jsonb;
  v_effects jsonb;
  v_item_id uuid;
  v_occurrence_id text;
  v_ref jsonb;
  v_branch jsonb;
  v_branches jsonb;
BEGIN
  IF p_plan IS NULL THEN RETURN NULL; END IF;
  IF jsonb_typeof(p_plan->'items') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_plan->'items') NOT BETWEEN 1 AND 16 THEN
    RAISE EXCEPTION 'invalid fixture plan' USING ERRCODE = '22023';
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_plan->'items') LOOP
    IF jsonb_typeof(v_item->'effects') IS DISTINCT FROM 'array'
      OR jsonb_array_length(v_item->'effects') NOT BETWEEN 1 AND 32 THEN
      RAISE EXCEPTION 'invalid fixture effects' USING ERRCODE = '22023';
    END IF;
    v_item_id := gen_random_uuid();
    v_occurrence_id := COALESCE(NULLIF(v_item->>'sourceOccurrenceId',''),gen_random_uuid()::text);
    v_effects := '[]'::jsonb;
    FOR v_effect IN SELECT value FROM jsonb_array_elements(v_item->'effects') LOOP
      v_ref := jsonb_build_object(
        'effectId', gen_random_uuid(), 'mappingVersion', COALESCE(p_plan->>'sourceMappingVersion',p_mapping), 'routeRevision', COALESCE(p_plan->>'sourceRouteRevision',p_revision),
        'operation', jsonb_build_object(
          'moduleId', v_effect#>'{operation,moduleId}',
          'entrypointKey', v_effect#>'{operation,entrypointKey}',
          'schemaVersion', v_effect#>'{operation,schemaVersion}'
        ),
        'occurrence', jsonb_build_object(
          'occurrenceId', v_occurrence_id,
          'record', jsonb_build_object(
            'entityKind', v_item#>'{source,entityKind}', 'issuerId', v_item#>'{source,issuerId}',
            'sourceNamespace', v_item#>'{source,sourceNamespace}',
            'sourceRecordId', v_item#>'{source,sourceRecordId}',
            'route', jsonb_build_object('integrationRouteId', COALESCE(p_plan->'sourceRouteId',to_jsonb(p_route)), 'tenantId', p_tenant)
          )
        )
      );
      IF v_effect ? 'originalTarget' THEN
        IF v_effect#>>'{originalTarget,tenantId}' IS DISTINCT FROM p_tenant::text
          OR v_effect#>>'{originalTarget,moduleId}' IS DISTINCT FROM v_effect#>>'{operation,moduleId}' THEN
          RAISE EXCEPTION 'invalid fixture target scope' USING ERRCODE = '22023';
        END IF;
        v_ref := v_ref || jsonb_build_object('originalTarget', jsonb_build_object(
          'tenantId', p_tenant, 'moduleId', v_effect#>'{originalTarget,moduleId}',
          'resourceType', v_effect#>'{originalTarget,resourceType}',
          'resourceId', v_effect#>'{originalTarget,resourceId}'
        ));
      END IF;
      v_effects := v_effects || jsonb_build_array(jsonb_build_object(
        'effectKey', v_effect->'effectKey', 'itemId', v_item_id, 'ref', v_ref
      ) || CASE WHEN v_effect ? 'dependsOn' THEN jsonb_build_object('dependsOn',v_effect->'dependsOn') ELSE '{}'::jsonb END
        || CASE WHEN v_effect ? 'intent' THEN jsonb_build_object('intent',v_effect->'intent') ELSE '{}'::jsonb END);
    END LOOP;
    v_branches:='[]'::jsonb;
    IF v_item ? 'unsupportedBranches' THEN
      IF jsonb_typeof(v_item->'unsupportedBranches') IS DISTINCT FROM 'array' OR jsonb_array_length(v_item->'unsupportedBranches')>8 THEN
        RAISE EXCEPTION 'invalid unsupported branches' USING ERRCODE='22023'; END IF;
      FOR v_branch IN SELECT value FROM jsonb_array_elements(v_item->'unsupportedBranches') LOOP
        v_branches:=v_branches||jsonb_build_array(jsonb_build_object('branchId',gen_random_uuid(),'branchKey',v_branch->'branchKey','kind',v_branch->'kind'));
      END LOOP;
    END IF;
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'itemId', v_item_id, 'itemKey', v_item->'itemKey', 'effects', v_effects
    ) || CASE WHEN jsonb_array_length(v_branches)>0 THEN jsonb_build_object('unsupportedBranches',v_branches) ELSE '{}'::jsonb END);
  END LOOP;
  RETURN jsonb_build_object('items', v_items,'sourceRouteId',COALESCE(p_plan->'sourceRouteId',to_jsonb(p_route)),'sourceRouteRevision',COALESCE(p_plan->>'sourceRouteRevision',p_revision),'sourceMappingVersion',COALESCE(p_plan->>'sourceMappingVersion',p_mapping)) || CASE WHEN p_plan ? 'selector' THEN jsonb_build_object('selector',p_plan->'selector') ELSE '{}'::jsonb END || CASE WHEN p_plan ? 'pricingSourceSystem' THEN jsonb_build_object('pricingSourceSystem',p_plan->'pricingSourceSystem') ELSE '{}'::jsonb END || CASE WHEN p_plan ? 'inventoryBackendId' THEN jsonb_build_object('inventoryBackendId',p_plan->'inventoryBackendId') ELSE '{}'::jsonb END;
END;
$$;
