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
      'effect', e.effect, 'outcome', e.outcome, 'ownerInvocationId',e.owner_invocation_id, 'ownerExecutorPrincipalId',e.owner_executor_principal_id, 'ownerReceipt',e.owner_receipt, 'resolvedEffect',e.resolved_effect,
      'state', CASE WHEN e.state = 'attempting' AND e.lease_until <= clock_timestamp() THEN 'indeterminate' ELSE e.state END,
      'version', e.version
    ) ORDER BY e.item_id, e.effect_key) FROM symmy_integration.job_effects e
      WHERE e.tenant_id = p_tenant AND e.job_id = p_job), '[]'::jsonb)
  ), 'FOUND'::text;
END;
$$;
--> statement-breakpoint
-- A source-relative dependent command resolves once, before any native write attempt.
CREATE FUNCTION symmy_integration.record_symmy_resolved_effect(p_tenant uuid,p_job uuid,p_effect uuid,p_token uuid,p_version integer,p_resolved jsonb)
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
  IF v_effect.resolved_effect IS NOT NULL THEN RETURN QUERY SELECT v_effect.resolved_effect=p_resolved; RETURN; END IF;
  IF v_effect.owner_executor_principal_id IS NOT NULL THEN RETURN QUERY SELECT false; RETURN; END IF;
  IF NOT ((v_effect.effect#>>'{intent,_tag}'='CatalogCreateVariantFromProductEffect' AND p_resolved#>>'{intent,_tag}'='CatalogCreateVariant')
    OR (v_effect.effect#>>'{intent,_tag}'='EnsureRetailProfileFromParty' AND p_resolved#>>'{intent,_tag}'='EnsureRetailProfile')
    OR (v_effect.effect#>>'{intent,_tag}'='OnboardCounterpartyFromParty' AND p_resolved#>>'{intent,_tag}'='OnboardCounterparty')
    OR (v_effect.effect#>>'{intent,_tag}'='CreateCounterpartyProfileFromCounterparty' AND p_resolved#>>'{intent,_tag}'='CreateCounterpartyProfile')) THEN
      RAISE EXCEPTION 'unsupported dependent command resolution' USING ERRCODE='22023'; END IF;
  UPDATE symmy_integration.job_effects SET resolved_effect=p_resolved WHERE tenant_id=p_tenant AND effect_id=p_effect;
  RETURN QUERY SELECT true;
END; $$;
--> statement-breakpoint
CREATE FUNCTION symmy_integration.record_symmy_owner_receipt(p_tenant uuid,p_job uuid,p_effect uuid,p_token uuid,p_version integer,p_receipt jsonb)
RETURNS TABLE(applied boolean) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, symmy_integration, pg_temp SET row_security = on AS $$
DECLARE v_effect symmy_integration.job_effects%ROWTYPE;
BEGIN
  IF p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id',true),'')::uuid THEN
    RAISE EXCEPTION 'tenant scope mismatch' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_effect FROM symmy_integration.job_effects e WHERE e.tenant_id=p_tenant AND e.job_id=p_job AND e.effect_id=p_effect FOR UPDATE;
  IF NOT FOUND OR v_effect.state<>'attempting' OR v_effect.claim_token IS DISTINCT FROM p_token OR v_effect.version<>p_version OR v_effect.lease_until<=clock_timestamp() THEN
    RETURN QUERY SELECT false; RETURN; END IF;
  IF jsonb_typeof(p_receipt) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_each(p_receipt) r WHERE jsonb_typeof(r.value)='object' AND r.value ? 'tenantId' AND r.value->>'tenantId' IS DISTINCT FROM p_tenant::text) THEN
    RAISE EXCEPTION 'invalid canonical receipt scope' USING ERRCODE='22023'; END IF;
  IF v_effect.owner_receipt IS NOT NULL THEN RETURN QUERY SELECT v_effect.owner_receipt=p_receipt; RETURN; END IF;
  IF v_effect.owner_executor_principal_id IS NULL THEN RETURN QUERY SELECT false; RETURN; END IF;
  UPDATE symmy_integration.job_effects SET owner_receipt=p_receipt WHERE tenant_id=p_tenant AND effect_id=p_effect;
  RETURN QUERY SELECT true;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION symmy_integration.record_symmy_resolved_effect(uuid,uuid,uuid,uuid,integer,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION symmy_integration.record_symmy_owner_receipt(uuid,uuid,uuid,uuid,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION symmy_integration.record_symmy_resolved_effect(uuid,uuid,uuid,uuid,integer,jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION symmy_integration.record_symmy_owner_receipt(uuid,uuid,uuid,uuid,integer,jsonb) TO ontos_runtime;
