-- Immutable typed source intents and dependency edges remain part of the admitted pin.
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
BEGIN
  IF p_plan IS NULL THEN RETURN NULL; END IF;
  IF jsonb_typeof(p_plan->'items') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_plan->'items') NOT BETWEEN 1 AND 16 THEN
    RAISE EXCEPTION 'invalid fixture plan' USING ERRCODE = '22023';
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_plan->'items') LOOP
    IF jsonb_typeof(v_item->'effects') IS DISTINCT FROM 'array'
      OR jsonb_array_length(v_item->'effects') NOT BETWEEN 1 AND 8 THEN
      RAISE EXCEPTION 'invalid fixture effects' USING ERRCODE = '22023';
    END IF;
    v_item_id := gen_random_uuid();
    v_occurrence_id := COALESCE(NULLIF(v_item->>'sourceOccurrenceId',''),gen_random_uuid()::text);
    v_effects := '[]'::jsonb;
    FOR v_effect IN SELECT value FROM jsonb_array_elements(v_item->'effects') LOOP
      v_ref := jsonb_build_object(
        'effectId', gen_random_uuid(), 'mappingVersion', p_mapping, 'routeRevision', p_revision,
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
            'route', jsonb_build_object('integrationRouteId', p_route, 'tenantId', p_tenant)
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
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'itemId', v_item_id, 'itemKey', v_item->'itemKey', 'effects', v_effects
    ));
  END LOOP;
  RETURN jsonb_build_object('items', v_items);
END;
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION symmy_integration.read_symmy_job_execution(p_tenant uuid, p_job uuid)
RETURNS TABLE(job jsonb, state text) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, symmy_integration, pg_temp SET row_security = on AS $$
DECLARE v_job symmy_integration.import_jobs%ROWTYPE;
BEGIN
  IF p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'tenant scope mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_job FROM symmy_integration.import_jobs j WHERE j.tenant_id = p_tenant AND j.job_id = p_job;
  IF NOT FOUND THEN RETURN QUERY SELECT NULL::jsonb, 'MISSING'::text; RETURN; END IF;
  IF v_job.execution_plan IS NULL THEN RETURN QUERY SELECT NULL::jsonb, 'UNAVAILABLE'::text; RETURN; END IF;
  RETURN QUERY SELECT jsonb_build_object(
    'jobId', v_job.job_id, 'legalEntityId', v_job.legal_entity_id,
    'mappingVersion', v_job.mapping_version, 'originalPrincipalId', v_job.principal_id,
    'plan', v_job.execution_plan, 'routeId', v_job.route_id, 'routeRevision', v_job.route_revision,
    'effects', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'effect', e.effect, 'outcome', e.outcome, 'ownerInvocationId',e.owner_invocation_id,
      'state', CASE WHEN e.state = 'attempting' AND e.lease_until <= clock_timestamp() THEN 'indeterminate' ELSE e.state END,
      'version', e.version
    ) ORDER BY e.item_id, e.effect_key) FROM symmy_integration.job_effects e
      WHERE e.tenant_id = p_tenant AND e.job_id = p_job), '[]'::jsonb)
  ), 'FOUND'::text;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION symmy_integration.record_symmy_owner_invocation(
  p_tenant uuid,p_job uuid,p_effect uuid,p_token uuid,p_version integer,p_invocation uuid
) RETURNS TABLE(applied boolean) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,symmy_integration,pg_temp SET row_security=on AS $$
DECLARE v_count integer;
BEGIN
  IF p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id',true),'')::uuid OR p_invocation IS NULL THEN
    RAISE EXCEPTION 'invalid invocation scope' USING ERRCODE='42501';
  END IF;
  UPDATE symmy_integration.job_effects e SET owner_invocation_id=p_invocation
  WHERE e.tenant_id=p_tenant AND e.job_id=p_job AND e.effect_id=p_effect
    AND e.state='attempting' AND e.claim_token=p_token AND e.version=p_version
    AND e.lease_until>clock_timestamp()
    AND (e.owner_invocation_id IS NULL OR e.owner_invocation_id=p_invocation);
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN QUERY SELECT v_count=1;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION symmy_integration.record_symmy_owner_invocation(uuid,uuid,uuid,uuid,integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION symmy_integration.record_symmy_owner_invocation(uuid,uuid,uuid,uuid,integer,uuid) TO ontos_runtime;
