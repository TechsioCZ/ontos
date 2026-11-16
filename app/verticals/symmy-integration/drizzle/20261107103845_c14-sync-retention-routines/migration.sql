-- Sync receipts remain separate from import jobs; erasure never inserts a synthetic job.
CREATE FUNCTION symmy_integration.read_symmy_sync_lifecycle(p_tenant uuid,p_admission uuid)
RETURNS TABLE(metadata jsonb) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,symmy_integration,pg_temp SET row_security=on AS $$
BEGIN
 IF p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id',true),'')::uuid THEN
  RAISE EXCEPTION 'invalid sync lifecycle scope' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT jsonb_build_object('jobId',s.admission_id,'routeId',s.route_id,'admittedAt',s.admitted_at,
  'legalEntityId',s.legal_entity_id,'policy',s.lifecycle_policy,'purged',s.retention_receipt IS NOT NULL)
 FROM symmy_integration.sync_admissions s WHERE s.tenant_id=p_tenant AND s.admission_id=p_admission;
END; $$;
--> statement-breakpoint
CREATE FUNCTION symmy_integration.purge_symmy_sync_intents(p_tenant uuid,p_admission uuid,p_policy jsonb,p_authority jsonb)
RETURNS TABLE(status text) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,symmy_integration,pg_temp SET row_security=on AS $$
DECLARE v_admission symmy_integration.sync_admissions%ROWTYPE; v_plan jsonb;
BEGIN
 IF p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id',true),'')::uuid THEN
  RAISE EXCEPTION 'invalid sync retention scope' USING ERRCODE='42501'; END IF;
 SELECT s.* INTO v_admission FROM symmy_integration.sync_admissions s WHERE s.tenant_id=p_tenant AND s.admission_id=p_admission FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'BLOCKED'::text; RETURN; END IF;
 IF v_admission.retention_receipt IS NOT NULL THEN RETURN QUERY SELECT 'ALREADY_PURGED'::text; RETURN; END IF;
 IF v_admission.lifecycle_policy IS NULL OR v_admission.lifecycle_policy->>'policyId' IS DISTINCT FROM p_policy->>'policyId'
  OR v_admission.lifecycle_policy->>'revision' IS DISTINCT FROM p_policy->>'revision'
  OR jsonb_typeof(p_policy->'retentionMs') IS DISTINCT FROM 'number' OR (p_policy->>'retentionMs')::bigint<=0
  OR v_admission.admitted_at+make_interval(secs=>(p_policy->>'retentionMs')::double precision/1000)>clock_timestamp()
  OR p_authority->>'status' IS DISTINCT FROM 'CURRENT_APPROVED'
  OR p_authority->>'resourceRef' IS DISTINCT FROM 'integration.symmy.sync-admission:'||p_admission::text
  OR p_authority->>'contentScopeRef' IS DISTINCT FROM 'integration.symmy.sync-admission:'||p_admission::text||'#integration.symmy.job-intent'
  OR nullif(p_authority->>'authorityReceiptRef','') IS NULL OR nullif(p_authority->>'authorityRevision','') IS NULL THEN
  RETURN QUERY SELECT 'BLOCKED'::text; RETURN; END IF;
 SELECT jsonb_build_object('items',jsonb_agg(jsonb_set(item.value,'{effects}',(
  SELECT jsonb_agg(effect.value-'intent' ORDER BY effect.ordinality)
  FROM jsonb_array_elements(item.value->'effects') WITH ORDINALITY effect(value,ordinality)
 )) ORDER BY item.ordinality)) INTO v_plan
 FROM jsonb_array_elements(v_admission.execution_plan->'items') WITH ORDINALITY item(value,ordinality);
 IF v_plan IS NULL THEN RETURN QUERY SELECT 'BLOCKED'::text; RETURN; END IF;
 UPDATE symmy_integration.sync_admissions s SET execution_plan=v_plan,
  retention_receipt=jsonb_build_object('policyId',p_policy->>'policyId','revision',p_policy->>'revision',
    'authorityReceiptRef',p_authority->>'authorityReceiptRef','authorityRevision',p_authority->>'authorityRevision','purgedAt',clock_timestamp())
 WHERE s.tenant_id=p_tenant AND s.admission_id=p_admission;
 RETURN QUERY SELECT 'PURGED'::text;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION symmy_integration.read_symmy_sync_lifecycle(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION symmy_integration.purge_symmy_sync_intents(uuid,uuid,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION symmy_integration.read_symmy_sync_lifecycle(uuid,uuid) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION symmy_integration.purge_symmy_sync_intents(uuid,uuid,jsonb,jsonb) TO ontos_runtime;
