-- Nested plan construction and compare-and-set transitions cannot be expressed by typed Drizzle DDL.
-- Only bounded, operator-managed fixture data is copied; arbitrary source/owner payload is never persisted.
CREATE FUNCTION symmy_integration.pin_symmy_fixture_plan(
  p_plan jsonb, p_tenant uuid, p_route uuid, p_revision text, p_mapping text
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, symmy_integration, pg_temp AS $$
DECLARE
  v_item jsonb;
  v_effect jsonb;
  v_items jsonb := '[]'::jsonb;
  v_effects jsonb;
  v_item_id uuid;
  v_occurrence_id uuid;
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
    v_occurrence_id := gen_random_uuid();
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
      ));
    END LOOP;
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'itemId', v_item_id, 'itemKey', v_item->'itemKey', 'effects', v_effects
    ));
  END LOOP;
  RETURN jsonb_build_object('items', v_items);
END;
$$;
--> statement-breakpoint
-- Private helper locks the originally admitted route until the owner call's transaction ends.
-- It never compares against, or copies targets from, a replacement plan.
CREATE FUNCTION symmy_integration.symmy_original_route_active(p_tenant uuid, p_job uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, symmy_integration, pg_temp AS $$
BEGIN
  PERFORM r.route_id FROM symmy_integration.job_routes r
    JOIN symmy_integration.import_jobs j ON j.tenant_id = r.tenant_id AND j.route_id = r.route_id
    WHERE j.tenant_id = p_tenant AND j.job_id = p_job AND j.execution_plan IS NOT NULL
      AND r.active AND r.principal_id = j.principal_id
      AND r.legal_entity_id IS NOT DISTINCT FROM j.legal_entity_id
      AND r.route_revision = j.route_revision AND r.mapping_version = j.mapping_version
      AND r.route_key = j.route_key AND r.route_code IS NOT DISTINCT FROM j.route_code
      AND j.fixture_id = ANY(r.fixture_ids)
    FOR SHARE OF r;
  RETURN FOUND;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION symmy_integration.read_symmy_job_execution(p_tenant uuid, p_job uuid)
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
      'effect', e.effect, 'outcome', e.outcome,
      'state', CASE WHEN e.state = 'attempting' AND e.lease_until <= clock_timestamp() THEN 'indeterminate' ELSE e.state END,
      'version', e.version
    ) ORDER BY e.item_id, e.effect_key) FROM symmy_integration.job_effects e
      WHERE e.tenant_id = p_tenant AND e.job_id = p_job), '[]'::jsonb)
  ), 'FOUND'::text;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION symmy_integration.claim_symmy_job_effect(p_tenant uuid, p_job uuid, p_effect uuid, p_token uuid)
RETURNS TABLE(effect jsonb, mode text, version integer) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, symmy_integration, pg_temp SET row_security = on AS $$
DECLARE v_effect symmy_integration.job_effects%ROWTYPE; v_mode text;
BEGIN
  IF p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid OR p_token IS NULL THEN
    RAISE EXCEPTION 'invalid execution scope' USING ERRCODE = '42501';
  END IF;
  SELECT e.* INTO v_effect FROM symmy_integration.job_effects e
    JOIN symmy_integration.import_jobs j ON j.tenant_id = e.tenant_id AND j.job_id = e.job_id
    WHERE e.tenant_id = p_tenant AND e.job_id = p_job AND e.effect_id = p_effect
      AND j.execution_plan IS NOT NULL
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(j.execution_plan->'items') i,
        jsonb_array_elements(i->'effects') pinned WHERE pinned = e.effect)
    FOR UPDATE OF e;
  IF NOT FOUND THEN RETURN QUERY SELECT NULL::jsonb, 'blocked'::text, 0; RETURN; END IF;
  IF v_effect.state = 'settled' THEN
    RETURN QUERY SELECT v_effect.effect, 'settled'::text, v_effect.version; RETURN;
  END IF;
  IF v_effect.state = 'attempting' AND v_effect.lease_until > clock_timestamp() THEN
    RETURN QUERY SELECT v_effect.effect, 'busy'::text, v_effect.version; RETURN;
  END IF;
  IF v_effect.state = 'planned' THEN
    IF NOT symmy_integration.symmy_original_route_active(p_tenant, p_job) THEN
      RETURN QUERY SELECT v_effect.effect, 'blocked'::text, v_effect.version; RETURN;
    END IF;
    v_mode := 'execute';
  ELSE
    v_mode := 'recover';
  END IF;
  UPDATE symmy_integration.job_effects e SET state = 'attempting', claim_token = p_token,
    lease_until = clock_timestamp() + interval '30 seconds', version = e.version + 1
    WHERE e.tenant_id = p_tenant AND e.effect_id = p_effect RETURNING e.version INTO v_effect.version;
  RETURN QUERY SELECT v_effect.effect, v_mode, v_effect.version;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION symmy_integration.can_execute_symmy_job_effect(
  p_tenant uuid, p_job uuid, p_effect uuid, p_token uuid, p_version integer
) RETURNS TABLE(allowed boolean) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, symmy_integration, pg_temp SET row_security = on AS $$
BEGIN
  IF p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'tenant scope mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT EXISTS(SELECT 1 FROM symmy_integration.job_effects e
    WHERE e.tenant_id = p_tenant AND e.job_id = p_job AND e.effect_id = p_effect
      AND e.claim_token = p_token AND e.version = p_version AND e.state = 'attempting'
      AND e.lease_until > clock_timestamp())
    AND symmy_integration.symmy_original_route_active(p_tenant, p_job);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION symmy_integration.settle_symmy_job_effect(
  p_tenant uuid, p_job uuid, p_effect uuid, p_token uuid, p_version integer, p_outcome jsonb
) RETURNS TABLE(applied boolean) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, symmy_integration, pg_temp SET row_security = on AS $$
DECLARE v_effect symmy_integration.job_effects%ROWTYPE; v_status text;
BEGIN
  IF p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'tenant scope mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_effect FROM symmy_integration.job_effects e
    WHERE e.tenant_id = p_tenant AND e.job_id = p_job AND e.effect_id = p_effect FOR UPDATE;
  IF NOT FOUND OR v_effect.state <> 'attempting' OR v_effect.claim_token IS DISTINCT FROM p_token
    OR v_effect.version <> p_version OR v_effect.lease_until <= clock_timestamp() THEN
    RETURN QUERY SELECT false; RETURN;
  END IF;
  v_status := p_outcome->>'status';
  IF v_status IS NULL OR v_status NOT IN (
    'accepted_change', 'accepted_no_change', 'duplicate', 'stale', 'unresolved', 'ambiguous', 'denied', 'conflict', 'unsupported'
  ) OR p_outcome->>'owner' IS DISTINCT FROM v_effect.effect#>>'{ref,operation,moduleId}'
    OR (p_outcome ? 'effectId' AND p_outcome->>'effectId' IS DISTINCT FROM p_effect::text)
    OR (v_status IN ('accepted_change', 'accepted_no_change', 'duplicate') AND NOT p_outcome ? 'effectId')
    OR (v_status = 'duplicate' AND (p_outcome->>'originalStatus' IS NULL
      OR p_outcome->>'originalStatus' NOT IN ('accepted_change', 'accepted_no_change')))
    OR (v_status = 'unsupported' AND (p_outcome->>'reason' IS NULL
      OR p_outcome->>'reason' NOT IN ('missing_context', 'unsupported_meaning', 'owner_not_activated')))
    OR (p_outcome ? 'originalStatus' AND v_status <> 'duplicate')
    OR (p_outcome ? 'reason' AND v_status <> 'unsupported')
    OR (v_status = 'unsupported' AND p_outcome ? 'effectId')
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_outcome) k WHERE k NOT IN (
      'owner', 'status', 'effectId', 'originalStatus', 'reason'
    )) THEN
    RAISE EXCEPTION 'invalid effect outcome' USING ERRCODE = '22023';
  END IF;
  UPDATE symmy_integration.job_effects e SET state = 'settled', outcome = p_outcome,
    claim_token = NULL, lease_until = NULL, version = e.version + 1
    WHERE e.tenant_id = p_tenant AND e.effect_id = p_effect;
  RETURN QUERY SELECT true;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION symmy_integration.mark_symmy_job_effect_indeterminate(
  p_tenant uuid, p_job uuid, p_effect uuid, p_token uuid, p_version integer
) RETURNS TABLE(applied boolean) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, symmy_integration, pg_temp SET row_security = on AS $$
BEGIN
  IF p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'tenant scope mismatch' USING ERRCODE = '42501';
  END IF;
  UPDATE symmy_integration.job_effects e SET state = 'indeterminate', claim_token = NULL,
    lease_until = NULL, version = e.version + 1
    WHERE e.tenant_id = p_tenant AND e.job_id = p_job AND e.effect_id = p_effect
      AND e.state = 'attempting' AND e.claim_token = p_token AND e.version = p_version
      AND e.lease_until > clock_timestamp();
  RETURN QUERY SELECT FOUND;
END;
$$;
--> statement-breakpoint
ALTER TABLE symmy_integration.job_effects FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE symmy_integration.job_effects TO ontos_runtime;
--> statement-breakpoint
REVOKE ALL ON FUNCTION symmy_integration.pin_symmy_fixture_plan(jsonb, uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION symmy_integration.symmy_original_route_active(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION symmy_integration.read_symmy_job_execution(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION symmy_integration.claim_symmy_job_effect(uuid, uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION symmy_integration.can_execute_symmy_job_effect(uuid, uuid, uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION symmy_integration.settle_symmy_job_effect(uuid, uuid, uuid, uuid, integer, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION symmy_integration.mark_symmy_job_effect_indeterminate(uuid, uuid, uuid, uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION symmy_integration.pin_symmy_fixture_plan(jsonb, uuid, uuid, text, text) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION symmy_integration.read_symmy_job_execution(uuid, uuid) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION symmy_integration.claim_symmy_job_effect(uuid, uuid, uuid, uuid) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION symmy_integration.can_execute_symmy_job_effect(uuid, uuid, uuid, uuid, integer) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION symmy_integration.settle_symmy_job_effect(uuid, uuid, uuid, uuid, integer, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION symmy_integration.mark_symmy_job_effect_indeterminate(uuid, uuid, uuid, uuid, integer) TO ontos_runtime;
