-- Target scope stays immutable. The selected verified company supplies only the explicitly configured Privacy governance scope.
-- Core optional-scope Action authorization still requires the Tenant grant; these routines do not grant authority.
CREATE OR REPLACE FUNCTION symmy_integration.purge_symmy_job_intents(p_tenant uuid,p_job uuid,p_policy jsonb,p_authority jsonb)
RETURNS TABLE(status text) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,symmy_integration,pg_temp SET row_security=on AS $$
DECLARE v_job symmy_integration.import_jobs%ROWTYPE; v_plan jsonb; v_tombstone symmy_integration.job_retention_tombstones%ROWTYPE;
BEGIN
 IF p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id',true),'')::uuid THEN
  RAISE EXCEPTION 'invalid retention scope' USING ERRCODE='42501'; END IF;
 SELECT j.* INTO v_job FROM symmy_integration.import_jobs j WHERE j.tenant_id=p_tenant AND j.job_id=p_job FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'BLOCKED'::text; RETURN; END IF;
 SELECT t.* INTO v_tombstone FROM symmy_integration.job_retention_tombstones t WHERE t.tenant_id=p_tenant AND t.job_id=p_job;
 IF FOUND THEN RETURN QUERY SELECT 'ALREADY_PURGED'::text; RETURN; END IF;
 IF (v_job.lifecycle_policy IS NOT NULL AND (v_job.lifecycle_policy->>'policyId' IS DISTINCT FROM p_policy->>'policyId'
  OR v_job.lifecycle_policy->>'revision' IS DISTINCT FROM p_policy->>'revision'))
  OR p_policy->>'routeId' IS DISTINCT FROM v_job.route_id::text
  OR p_policy->'targetLegalEntityId' IS DISTINCT FROM coalesce(to_jsonb(v_job.legal_entity_id),'null'::jsonb)
  OR nullif(p_policy->>'governanceLegalEntityId','') IS NULL
  OR p_policy->>'governanceLegalEntityId' IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id',true),'')
  OR (v_job.legal_entity_id IS NOT NULL AND p_policy->>'governanceLegalEntityId' IS DISTINCT FROM v_job.legal_entity_id::text)
  OR nullif(p_policy->>'policyId','') IS NULL OR nullif(p_policy->>'revision','') IS NULL
  OR jsonb_typeof(p_policy->'retentionMs') IS DISTINCT FROM 'number'
  OR (p_policy->>'retentionMs')::bigint<=0
  OR v_job.admitted_at+make_interval(secs=>(p_policy->>'retentionMs')::double precision/1000)>clock_timestamp()
  OR p_authority->>'status' IS DISTINCT FROM 'CURRENT_APPROVED'
  OR p_authority->>'resourceRef' IS DISTINCT FROM 'integration.symmy.job:'||p_job::text
  OR p_authority->>'contentScopeRef' IS DISTINCT FROM 'integration.symmy.job:'||p_job::text||'#integration.symmy.job-intent'
  OR nullif(p_authority->>'authorityReceiptRef','') IS NULL OR nullif(p_authority->>'authorityRevision','') IS NULL
  OR NOT EXISTS(SELECT 1 FROM symmy_integration.job_effects e WHERE e.tenant_id=p_tenant AND e.job_id=p_job) THEN
  RETURN QUERY SELECT 'BLOCKED'::text; RETURN; END IF;
 -- Claimers lock an effect before publishing its lease. Acquire the same row locks before deciding.
 PERFORM 1 FROM symmy_integration.job_effects e WHERE e.tenant_id=p_tenant AND e.job_id=p_job ORDER BY e.effect_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM symmy_integration.job_effects e WHERE e.tenant_id=p_tenant AND e.job_id=p_job
   AND e.state='attempting' AND e.lease_until>clock_timestamp()) THEN
  RETURN QUERY SELECT 'BLOCKED'::text; RETURN; END IF;
 v_plan:=symmy_integration.erase_symmy_plan_payload(v_job.execution_plan);
 IF v_plan IS NULL THEN RETURN QUERY SELECT 'BLOCKED'::text; RETURN; END IF;
 UPDATE symmy_integration.job_effects e SET effect=symmy_integration.erase_symmy_effect_payload(e.effect), resolved_effect=symmy_integration.erase_symmy_effect_payload(e.resolved_effect), effect_key='erased.'||e.effect_id::text WHERE e.tenant_id=p_tenant AND e.job_id=p_job;
 UPDATE symmy_integration.import_jobs j SET execution_plan=v_plan, fixture_id='ERASED', route_code=NULL,
  lifecycle_policy=coalesce(j.lifecycle_policy,jsonb_build_object('policyId',p_policy->>'policyId','revision',p_policy->>'revision')) WHERE j.tenant_id=p_tenant AND j.job_id=p_job;
 INSERT INTO symmy_integration.job_retention_tombstones(tenant_id,job_id,policy_id,policy_revision,authority_receipt_ref,authority_revision,retained_effect_ids)
 SELECT p_tenant,p_job,p_policy->>'policyId',p_policy->>'revision',p_authority->>'authorityReceiptRef',p_authority->>'authorityRevision',
  jsonb_agg(e.effect_id ORDER BY e.effect_id) FROM symmy_integration.job_effects e WHERE e.tenant_id=p_tenant AND e.job_id=p_job;
 RETURN QUERY SELECT 'PURGED'::text;
END; $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION symmy_integration.purge_symmy_sync_intents(p_tenant uuid,p_admission uuid,p_policy jsonb,p_authority jsonb)
RETURNS TABLE(status text) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,symmy_integration,pg_temp SET row_security=on AS $$
DECLARE v_admission symmy_integration.sync_admissions%ROWTYPE; v_plan jsonb;
BEGIN
 IF p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id',true),'')::uuid THEN
  RAISE EXCEPTION 'invalid sync retention scope' USING ERRCODE='42501'; END IF;
 SELECT s.* INTO v_admission FROM symmy_integration.sync_admissions s WHERE s.tenant_id=p_tenant AND s.admission_id=p_admission FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'BLOCKED'::text; RETURN; END IF;
 IF v_admission.retention_receipt IS NOT NULL THEN RETURN QUERY SELECT 'ALREADY_PURGED'::text; RETURN; END IF;
 IF (v_admission.lifecycle_policy IS NOT NULL AND (v_admission.lifecycle_policy->>'policyId' IS DISTINCT FROM p_policy->>'policyId'
  OR v_admission.lifecycle_policy->>'revision' IS DISTINCT FROM p_policy->>'revision'))
  OR p_policy->>'routeId' IS DISTINCT FROM v_admission.route_id::text
  OR p_policy->'targetLegalEntityId' IS DISTINCT FROM coalesce(to_jsonb(v_admission.legal_entity_id),'null'::jsonb)
  OR nullif(p_policy->>'governanceLegalEntityId','') IS NULL
  OR p_policy->>'governanceLegalEntityId' IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id',true),'')
  OR (v_admission.legal_entity_id IS NOT NULL AND p_policy->>'governanceLegalEntityId' IS DISTINCT FROM v_admission.legal_entity_id::text)
  OR nullif(p_policy->>'policyId','') IS NULL OR nullif(p_policy->>'revision','') IS NULL
  OR jsonb_typeof(p_policy->'retentionMs') IS DISTINCT FROM 'number' OR (p_policy->>'retentionMs')::bigint<=0
  OR v_admission.admitted_at+make_interval(secs=>(p_policy->>'retentionMs')::double precision/1000)>clock_timestamp()
  OR p_authority->>'status' IS DISTINCT FROM 'CURRENT_APPROVED'
  OR p_authority->>'resourceRef' IS DISTINCT FROM 'integration.symmy.sync-admission:'||p_admission::text
  OR p_authority->>'contentScopeRef' IS DISTINCT FROM 'integration.symmy.sync-admission:'||p_admission::text||'#integration.symmy.job-intent'
  OR nullif(p_authority->>'authorityReceiptRef','') IS NULL OR nullif(p_authority->>'authorityRevision','') IS NULL THEN
  RETURN QUERY SELECT 'BLOCKED'::text; RETURN; END IF;
 v_plan:=symmy_integration.erase_symmy_plan_payload(v_admission.execution_plan);
 IF v_plan IS NULL THEN RETURN QUERY SELECT 'BLOCKED'::text; RETURN; END IF;
 UPDATE symmy_integration.sync_admissions s SET execution_plan=v_plan,
  lifecycle_policy=coalesce(s.lifecycle_policy,jsonb_build_object('policyId',p_policy->>'policyId','revision',p_policy->>'revision')),
  retention_receipt=jsonb_build_object('policyId',p_policy->>'policyId','revision',p_policy->>'revision',
    'authorityReceiptRef',p_authority->>'authorityReceiptRef','authorityRevision',p_authority->>'authorityRevision','purgedAt',clock_timestamp())
 WHERE s.tenant_id=p_tenant AND s.admission_id=p_admission;
 RETURN QUERY SELECT 'PURGED'::text;
END; $$;
