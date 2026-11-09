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
    'lifecyclePolicy',v_job.lifecycle_policy,'mappingVersion', v_job.mapping_version, 'originalPrincipalId', v_job.principal_id,
    'plan', v_job.execution_plan, 'routeId', v_job.route_id, 'routeRevision', v_job.route_revision,
    'effects', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'effect', e.effect, 'outcome', e.outcome, 'ownerInvocationId',e.owner_invocation_id, 'ownerExecutorPrincipalId',e.owner_executor_principal_id, 'ownerRequestHash',e.owner_request_hash,'ownerAuthContextRef',e.owner_auth_context_ref, 'ownerReceipt',e.owner_receipt, 'resolvedEffect',e.resolved_effect,
      'state', CASE WHEN e.state = 'attempting' AND e.lease_until <= clock_timestamp() THEN 'indeterminate' ELSE e.state END,
      'version', e.version
    ) ORDER BY e.item_id, e.effect_key) FROM symmy_integration.job_effects e
      WHERE e.tenant_id = p_tenant AND e.job_id = p_job), '[]'::jsonb)
  ), 'FOUND'::text;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION symmy_integration.record_symmy_owner_request(p_tenant uuid,p_job uuid,p_effect uuid,p_token uuid,p_version integer,p_identity jsonb)
RETURNS TABLE(applied boolean) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, symmy_integration, pg_temp SET row_security = on AS $$
DECLARE v_count integer;
BEGIN
 IF p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id',true),'')::uuid THEN
   RAISE EXCEPTION 'tenant scope mismatch' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_identity) IS DISTINCT FROM 'object' OR p_identity->>'requestHash' !~ '^[a-f0-9]{64}$'
   OR char_length(p_identity->>'authContextRef') NOT BETWEEN 1 AND 500 THEN
   RAISE EXCEPTION 'invalid original request identity' USING ERRCODE='22023'; END IF;
 UPDATE symmy_integration.job_effects e SET owner_request_hash=p_identity->>'requestHash',owner_auth_context_ref=p_identity->>'authContextRef'
 WHERE e.tenant_id=p_tenant AND e.job_id=p_job AND e.effect_id=p_effect AND e.state='attempting'
   AND e.claim_token=p_token AND e.version=p_version AND e.lease_until>clock_timestamp() AND e.owner_executor_principal_id IS NOT NULL
   AND ((e.owner_request_hash IS NULL AND e.owner_auth_context_ref IS NULL) OR
     (e.owner_request_hash=p_identity->>'requestHash' AND e.owner_auth_context_ref=p_identity->>'authContextRef'));
 GET DIAGNOSTICS v_count=ROW_COUNT;
 RETURN QUERY SELECT v_count=1;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION symmy_integration.record_symmy_owner_request(uuid,uuid,uuid,uuid,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION symmy_integration.record_symmy_owner_request(uuid,uuid,uuid,uuid,integer,jsonb) TO ontos_runtime;
