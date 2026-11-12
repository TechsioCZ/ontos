-- Load the original admitted route, never a body-derived selector or current route substitution.
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
    'plan', v_job.execution_plan, 'routeId', v_job.route_id, 'routeKey', v_job.route_key, 'routeRevision', v_job.route_revision,
    'effects', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'effect', e.effect, 'outcome', e.outcome, 'ownerInvocationId',e.owner_invocation_id, 'ownerExecutorPrincipalId',e.owner_executor_principal_id, 'ownerRequestHash',e.owner_request_hash,'ownerAuthContextRef',e.owner_auth_context_ref, 'ownerReceipt',e.owner_receipt, 'resolvedEffect',e.resolved_effect,
      'state', CASE WHEN e.state = 'attempting' AND e.lease_until <= clock_timestamp() THEN 'indeterminate' ELSE e.state END,
      'version', e.version
    ) ORDER BY e.item_id, e.effect_key) FROM symmy_integration.job_effects e
      WHERE e.tenant_id = p_tenant AND e.job_id = p_job), '[]'::jsonb)
  ), 'FOUND'::text;
END;
$$;
