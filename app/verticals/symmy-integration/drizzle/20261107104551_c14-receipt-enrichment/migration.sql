-- Canonical references never change; exact owner invocation metadata may be enriched once.
CREATE OR REPLACE FUNCTION symmy_integration.record_symmy_owner_receipt(p_tenant uuid,p_job uuid,p_effect uuid,p_token uuid,p_version integer,p_receipt jsonb)
RETURNS TABLE(applied boolean) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, symmy_integration, pg_temp SET row_security = on AS $$
DECLARE v_effect symmy_integration.job_effects%ROWTYPE;
BEGIN
  IF p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id',true),'')::uuid THEN
    RAISE EXCEPTION 'tenant scope mismatch' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_effect FROM symmy_integration.job_effects e WHERE e.tenant_id=p_tenant AND e.job_id=p_job AND e.effect_id=p_effect FOR UPDATE;
  IF NOT FOUND OR v_effect.state<>'attempting' OR v_effect.claim_token IS DISTINCT FROM p_token OR v_effect.version<>p_version OR v_effect.lease_until<=clock_timestamp() THEN
    RETURN QUERY SELECT false; RETURN; END IF;
  IF jsonb_typeof(p_receipt) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_each(p_receipt) r WHERE jsonb_typeof(r.value)='object' AND r.value ? 'tenantId' AND (r.value->>'tenantId' IS DISTINCT FROM p_tenant::text OR r.value->>'moduleId' IS DISTINCT FROM v_effect.effect#>>'{ref,operation,moduleId}')) THEN
    RAISE EXCEPTION 'invalid canonical receipt scope' USING ERRCODE='22023'; END IF;
  IF v_effect.owner_receipt IS NOT NULL THEN
    IF v_effect.owner_receipt=p_receipt THEN RETURN QUERY SELECT true; RETURN; END IF;
    IF (v_effect.owner_receipt-'actionInvocationId') IS DISTINCT FROM (p_receipt-'actionInvocationId')
      OR v_effect.owner_receipt ? 'actionInvocationId'
      OR p_receipt->>'actionInvocationId' IS DISTINCT FROM v_effect.owner_invocation_id::text THEN
      RETURN QUERY SELECT false; RETURN; END IF;
  END IF;
  IF v_effect.owner_executor_principal_id IS NULL THEN RETURN QUERY SELECT false; RETURN; END IF;
  UPDATE symmy_integration.job_effects SET owner_receipt=p_receipt WHERE tenant_id=p_tenant AND effect_id=p_effect;
  RETURN QUERY SELECT true;
END; $$;
