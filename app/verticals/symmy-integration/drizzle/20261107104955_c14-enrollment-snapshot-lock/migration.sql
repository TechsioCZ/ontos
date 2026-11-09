-- Runtime enrollment remains read-only. Only this scope-bound definer routine can lock its exact snapshot.
CREATE FUNCTION symmy_integration.lock_symmy_enrollment_snapshot(p_tenant uuid,p_route uuid,p_snapshot jsonb)
RETURNS TABLE(allowed boolean) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, symmy_integration, pg_temp SET row_security = on AS $$
DECLARE v_route symmy_integration.job_routes%ROWTYPE;
BEGIN
  IF p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id',true),'')::uuid THEN
    RAISE EXCEPTION 'tenant scope mismatch' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_route FROM symmy_integration.job_routes r WHERE r.tenant_id=p_tenant AND r.route_id=p_route FOR SHARE;
  IF NOT FOUND THEN RETURN QUERY SELECT false; RETURN; END IF;
  RETURN QUERY SELECT jsonb_build_object(
    'active',v_route.active,'fixtureIds',v_route.fixture_ids,'fixturePlan',v_route.fixture_plan,
    'legalEntityId',v_route.legal_entity_id,'lifecyclePolicy',v_route.lifecycle_policy,'mappingVersion',v_route.mapping_version,
    'principalId',v_route.principal_id,'routeCode',v_route.route_code,'routeId',v_route.route_id,
    'routeKey',v_route.route_key,'routeRevision',v_route.route_revision,'tenantId',v_route.tenant_id)=p_snapshot;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION symmy_integration.lock_symmy_enrollment_snapshot(uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION symmy_integration.lock_symmy_enrollment_snapshot(uuid,uuid,jsonb) TO ontos_runtime;
