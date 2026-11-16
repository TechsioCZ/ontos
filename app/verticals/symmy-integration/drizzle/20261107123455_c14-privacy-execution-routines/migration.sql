ALTER TABLE symmy_integration.privacy_measure_executions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION symmy_integration.read_symmy_privacy_execution(p_tenant uuid,p_digest text,p_attempt integer)
RETURNS TABLE(receipt jsonb) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,symmy_integration,pg_temp SET row_security=on AS $$
DECLARE v_row symmy_integration.privacy_measure_executions%ROWTYPE; v_governance uuid;
BEGIN
 v_governance:=nullif(current_setting('ontos.legal_entity_id',true),'')::uuid;
 IF p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id',true),'')::uuid OR v_governance IS NULL
  OR (p_digest ~ '^[a-f0-9]{64}$') IS DISTINCT FROM true OR p_attempt IS NULL OR p_attempt<0 THEN
  RAISE EXCEPTION 'invalid privacy receipt scope' USING ERRCODE='42501'; END IF;
 SELECT e.* INTO v_row FROM symmy_integration.privacy_measure_executions e
 WHERE e.tenant_id=p_tenant AND e.governance_legal_entity_id=v_governance AND e.idempotency_digest=p_digest
  AND (p_attempt=0 OR e.attempt=p_attempt) ORDER BY e.attempt DESC LIMIT 1;
 IF NOT FOUND THEN RETURN QUERY SELECT NULL::jsonb; RETURN; END IF;
 RETURN QUERY SELECT jsonb_build_object('actionInvocationId',v_row.action_invocation_id,'handoffFingerprint',v_row.handoff_fingerprint,
  'outcome',v_row.outcome,'governanceLegalEntityId',v_row.governance_legal_entity_id,
  'targetLegalEntityId',v_row.target_legal_entity_id,'retentionStatus',v_row.retention_status);
END; $$;
--> statement-breakpoint
CREATE FUNCTION symmy_integration.lock_symmy_privacy_execution(p_tenant uuid,p_digest text)
RETURNS TABLE(receipt jsonb) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,symmy_integration,pg_temp SET row_security=on AS $$
DECLARE v_governance uuid;
BEGIN
 v_governance:=nullif(current_setting('ontos.legal_entity_id',true),'')::uuid;
 IF p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id',true),'')::uuid OR v_governance IS NULL
  OR (p_digest ~ '^[a-f0-9]{64}$') IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'invalid privacy execution scope' USING ERRCODE='42501'; END IF;
 -- The lock also serializes an absent first receipt. It grants no business or cross-owner authority.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text||':'||v_governance::text||':'||p_digest,0));
 RETURN QUERY SELECT r.receipt FROM symmy_integration.read_symmy_privacy_execution(p_tenant,p_digest,0) r;
END; $$;
--> statement-breakpoint
CREATE FUNCTION symmy_integration.record_symmy_privacy_execution(p_tenant uuid,p_digest text,p_receipt jsonb)
RETURNS TABLE(recorded boolean) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,symmy_integration,pg_temp SET row_security=on AS $$
DECLARE v_governance uuid; v_prior symmy_integration.privacy_measure_executions%ROWTYPE;
 v_target uuid; v_erased boolean; v_found boolean; v_resource text; v_outcome jsonb; v_attempt integer;
BEGIN
 v_governance:=nullif(current_setting('ontos.legal_entity_id',true),'')::uuid;
 IF p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id',true),'')::uuid OR v_governance IS NULL
  OR p_receipt->>'governanceLegalEntityId' IS DISTINCT FROM v_governance::text
  OR (p_digest ~ '^[a-f0-9]{64}$') IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'invalid privacy execution record scope' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text||':'||v_governance::text||':'||p_digest,0));
 SELECT e.* INTO v_prior FROM symmy_integration.privacy_measure_executions e
 WHERE e.tenant_id=p_tenant AND e.governance_legal_entity_id=v_governance AND e.idempotency_digest=p_digest
 ORDER BY e.attempt DESC LIMIT 1;
 v_outcome:=p_receipt->'outcome'; v_attempt:=(v_outcome->>'attempt')::integer;
 IF (v_prior.receipt_id IS NOT NULL AND (v_prior.handoff_fingerprint IS DISTINCT FROM p_receipt->>'handoffFingerprint'
   OR v_prior.resource_id::text IS DISTINCT FROM p_receipt->>'resourceId'
   OR v_prior.resource_kind IS DISTINCT FROM p_receipt->>'resourceKind'
   OR v_prior.outcome->>'status'='SUCCEEDED'))
  OR v_attempt IS DISTINCT FROM coalesce(v_prior.attempt,0)+1 THEN
  RETURN QUERY SELECT false; RETURN; END IF;
 IF p_receipt->>'resourceKind'='JOB' THEN
  SELECT j.legal_entity_id,EXISTS(SELECT 1 FROM symmy_integration.job_retention_tombstones t WHERE t.tenant_id=p_tenant AND t.job_id=j.job_id)
   INTO v_target,v_erased FROM symmy_integration.import_jobs j WHERE j.tenant_id=p_tenant AND j.job_id=(p_receipt->>'resourceId')::uuid;
  v_found:=FOUND; v_resource:='integration.symmy.job:'||(p_receipt->>'resourceId');
 ELSIF p_receipt->>'resourceKind'='SYNC' THEN
  SELECT s.legal_entity_id,s.retention_receipt IS NOT NULL INTO v_target,v_erased FROM symmy_integration.sync_admissions s
   WHERE s.tenant_id=p_tenant AND s.admission_id=(p_receipt->>'resourceId')::uuid;
  v_found:=FOUND; v_resource:='integration.symmy.sync-admission:'||(p_receipt->>'resourceId');
 ELSE RETURN QUERY SELECT false; RETURN; END IF;
 IF NOT coalesce(v_found,false) OR p_receipt->'targetLegalEntityId' IS DISTINCT FROM coalesce(to_jsonb(v_target),'null'::jsonb)
  OR (v_target IS NOT NULL AND v_target<>v_governance)
  OR v_outcome->>'owningCapability' IS DISTINCT FROM 'integration.symmy'
  OR v_outcome->>'outcomeId' IS DISTINCT FROM p_receipt->>'receiptId'
  OR v_outcome->'evidenceRefs' IS DISTINCT FROM jsonb_build_array('integration.symmy.privacy-measure-execution:'||(p_receipt->>'receiptId')) THEN
  RETURN QUERY SELECT false; RETURN; END IF;
 IF p_receipt->>'retentionStatus'='BLOCKED' THEN
  IF v_outcome->>'status' IS DISTINCT FROM 'BLOCKED' OR v_outcome->'includedResourceRefs' IS DISTINCT FROM '[]'::jsonb
   OR v_outcome->'remainingResourceRefs' IS DISTINCT FROM jsonb_build_array(v_resource) THEN RETURN QUERY SELECT false; RETURN; END IF;
 ELSIF p_receipt->>'retentionStatus' IN ('PURGED','ALREADY_PURGED') THEN
  IF NOT coalesce(v_erased,false) OR v_outcome->>'status' IS DISTINCT FROM 'SUCCEEDED'
   OR v_outcome->'remainingResourceRefs' IS DISTINCT FROM '[]'::jsonb
   OR v_outcome->'includedResourceRefs' IS DISTINCT FROM jsonb_build_array(v_resource) THEN RETURN QUERY SELECT false; RETURN; END IF;
 ELSE RETURN QUERY SELECT false; RETURN; END IF;
 INSERT INTO symmy_integration.privacy_measure_executions(receipt_id,tenant_id,governance_legal_entity_id,idempotency_digest,
  attempt,action_invocation_id,actor_principal_id,handoff_fingerprint,resource_kind,resource_id,target_legal_entity_id,retention_status,outcome)
 VALUES((p_receipt->>'receiptId')::uuid,p_tenant,v_governance,p_digest,v_attempt,(p_receipt->>'actionInvocationId')::uuid,
  (p_receipt->>'actorPrincipalId')::uuid,p_receipt->>'handoffFingerprint',p_receipt->>'resourceKind',
  (p_receipt->>'resourceId')::uuid,v_target,p_receipt->>'retentionStatus',v_outcome);
 RETURN QUERY SELECT true;
END; $$;
--> statement-breakpoint
REVOKE ALL ON TABLE symmy_integration.privacy_measure_executions FROM ontos_runtime;
REVOKE ALL ON FUNCTION symmy_integration.read_symmy_privacy_execution(uuid,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION symmy_integration.lock_symmy_privacy_execution(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION symmy_integration.record_symmy_privacy_execution(uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION symmy_integration.read_symmy_privacy_execution(uuid,text,integer) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION symmy_integration.lock_symmy_privacy_execution(uuid,text) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION symmy_integration.record_symmy_privacy_execution(uuid,text,jsonb) TO ontos_runtime;
