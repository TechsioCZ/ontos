-- Erased source tuples are explicit tombstones, never new source authority or hashes of low-entropy identifiers.
CREATE FUNCTION symmy_integration.erase_symmy_effect_payload(p_effect jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,symmy_integration,pg_temp AS $$
DECLARE v_ref jsonb; v_id text; v_item text;
BEGIN
 IF p_effect IS NULL THEN RETURN NULL; END IF;
 v_id:=p_effect#>>'{ref,effectId}'; v_item:=p_effect->>'itemId';
 v_ref:=jsonb_set(p_effect->'ref','{occurrence}',jsonb_build_object(
  'occurrenceId','ERASED.'||v_item,'record',jsonb_build_object(
   'entityKind','ERASED','issuerId','ERASED','sourceNamespace','ERASED','sourceRecordId','ERASED.'||v_id,
   'route',p_effect#>'{ref,occurrence,record,route}'
  )));
 IF v_ref ? 'originalTarget' AND NOT coalesce(v_ref#>>'{originalTarget,resourceId}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false) THEN
  v_ref:=v_ref-'originalTarget'; END IF;
 RETURN jsonb_build_object('effectKey','erased.'||v_id,'itemId',v_item,'ref',v_ref);
END; $$;
--> statement-breakpoint
CREATE FUNCTION symmy_integration.erase_symmy_plan_payload(p_plan jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,symmy_integration,pg_temp AS $$
 SELECT jsonb_build_object('items',jsonb_agg(jsonb_build_object(
  'itemId',item.value->'itemId','itemKey','erased.'||(item.value->>'itemId'),
  'effects',(SELECT jsonb_agg(symmy_integration.erase_symmy_effect_payload(effect.value) ORDER BY effect.ordinality)
   FROM jsonb_array_elements(item.value->'effects') WITH ORDINALITY effect(value,ordinality))
 ) ORDER BY item.ordinality))
 FROM jsonb_array_elements(p_plan->'items') WITH ORDINALITY item(value,ordinality);
$$;
--> statement-breakpoint
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
 IF v_job.lifecycle_policy IS NULL OR v_job.lifecycle_policy->>'policyId' IS DISTINCT FROM p_policy->>'policyId'
  OR v_job.lifecycle_policy->>'revision' IS DISTINCT FROM p_policy->>'revision'
  OR jsonb_typeof(p_policy->'retentionMs') IS DISTINCT FROM 'number'
  OR (p_policy->>'retentionMs')::bigint<=0
  OR v_job.admitted_at+make_interval(secs=>(p_policy->>'retentionMs')::double precision/1000)>clock_timestamp()
  OR p_authority->>'status' IS DISTINCT FROM 'CURRENT_APPROVED'
  OR p_authority->>'resourceRef' IS DISTINCT FROM 'integration.symmy.job:'||p_job::text
  OR p_authority->>'contentScopeRef' IS DISTINCT FROM 'integration.symmy.job:'||p_job::text||'#integration.symmy.job-intent'
  OR nullif(p_authority->>'authorityReceiptRef','') IS NULL OR nullif(p_authority->>'authorityRevision','') IS NULL
  OR NOT EXISTS(SELECT 1 FROM symmy_integration.job_effects e WHERE e.tenant_id=p_tenant AND e.job_id=p_job)
  OR EXISTS(SELECT 1 FROM symmy_integration.job_effects e WHERE e.tenant_id=p_tenant AND e.job_id=p_job AND e.state='attempting' AND e.lease_until>clock_timestamp()) THEN
  RETURN QUERY SELECT 'BLOCKED'::text; RETURN; END IF;
 PERFORM 1 FROM symmy_integration.job_effects e WHERE e.tenant_id=p_tenant AND e.job_id=p_job FOR UPDATE;
 v_plan:=symmy_integration.erase_symmy_plan_payload(v_job.execution_plan);
 IF v_plan IS NULL THEN RETURN QUERY SELECT 'BLOCKED'::text; RETURN; END IF;
 UPDATE symmy_integration.job_effects e SET effect=symmy_integration.erase_symmy_effect_payload(e.effect), resolved_effect=symmy_integration.erase_symmy_effect_payload(e.resolved_effect), effect_key='erased.'||e.effect_id::text WHERE e.tenant_id=p_tenant AND e.job_id=p_job;
 UPDATE symmy_integration.import_jobs j SET execution_plan=v_plan, fixture_id='ERASED', route_code=NULL WHERE j.tenant_id=p_tenant AND j.job_id=p_job;
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
 IF v_admission.lifecycle_policy IS NULL OR v_admission.lifecycle_policy->>'policyId' IS DISTINCT FROM p_policy->>'policyId'
  OR v_admission.lifecycle_policy->>'revision' IS DISTINCT FROM p_policy->>'revision'
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
  retention_receipt=jsonb_build_object('policyId',p_policy->>'policyId','revision',p_policy->>'revision',
    'authorityReceiptRef',p_authority->>'authorityReceiptRef','authorityRevision',p_authority->>'authorityRevision','purgedAt',clock_timestamp())
 WHERE s.tenant_id=p_tenant AND s.admission_id=p_admission;
 RETURN QUERY SELECT 'PURGED'::text;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION symmy_integration.erase_symmy_effect_payload(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION symmy_integration.erase_symmy_plan_payload(jsonb) FROM PUBLIC;
