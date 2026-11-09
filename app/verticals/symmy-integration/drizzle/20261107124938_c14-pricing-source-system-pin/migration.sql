-- Pin explicit native Pricing source identity independently of the transport issuer.
-- The native selected Inventory backend is independent of the external EBS source issuer.
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
      IF jsonb_typeof(v_item->'unsupportedBranches') IS DISTINCT FROM 'array' OR jsonb_array_length(v_item->'unsupportedBranches')>3 THEN
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
