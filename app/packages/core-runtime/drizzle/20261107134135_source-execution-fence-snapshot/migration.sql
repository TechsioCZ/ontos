-- Custom SQL migration file, put your code below! --
-- Factual snapshot only: nested owner proofs must not queue another SHARE lock behind cancellation.
CREATE FUNCTION trust.read_source_execution_fence(p_tenant_id uuid, p_admission_id uuid)
RETURNS TABLE(admission_invocation_id uuid, action_key text, original_principal_id uuid, legal_entity_id uuid, fence_state text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_tenant_id uuid; v_legal_entity_id uuid;
BEGIN
  v_tenant_id := trust.current_tenant_id();
  v_legal_entity_id := trust.current_legal_entity_id();
  IF v_tenant_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM trust.gateway_audience_roles a WHERE a.role_name = SESSION_USER) THEN
      RAISE EXCEPTION 'source execution snapshot requires established gateway scope' USING ERRCODE = '42501';
    END IF;
    v_tenant_id := nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid;
    v_legal_entity_id := nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid;
  END IF;
  IF v_tenant_id IS NULL OR v_tenant_id IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'source execution snapshot is outside current tenant scope' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT i.action_invocation_id, i.action_key, i.principal_id, i.legal_entity_id, f.state
    FROM core.action_invocations i
    JOIN core.source_execution_fences f ON f.tenant_id=i.tenant_id AND f.admission_invocation_id=i.action_invocation_id
    WHERE i.tenant_id=p_tenant_id AND i.action_invocation_id=p_admission_id AND i.status='succeeded'
      AND i.principal_id IS NOT NULL AND i.legal_entity_id IS NOT DISTINCT FROM v_legal_entity_id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION trust.read_source_execution_fence(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION trust.read_source_execution_fence(uuid,uuid) TO ontos_runtime, party_registry_runtime;
