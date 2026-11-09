-- A native Price Group receipt may resolve only the named dependent Price command.
-- A source-relative dependent command resolves once, before any native write attempt.
CREATE OR REPLACE FUNCTION symmy_integration.record_symmy_resolved_effect(p_tenant uuid,p_job uuid,p_effect uuid,p_token uuid,p_version integer,p_resolved jsonb)
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
  IF NOT ((v_effect.effect#>>'{intent,_tag}'='PriceDefineFromGroupEffect' AND p_resolved#>>'{intent,_tag}'='PriceDefine')
    OR (v_effect.effect#>>'{intent,_tag}'='CatalogCreateVariantFromProductEffect' AND p_resolved#>>'{intent,_tag}'='CatalogCreateVariant')
    OR (v_effect.effect#>>'{intent,_tag}'='EnsureRetailProfileFromParty' AND p_resolved#>>'{intent,_tag}'='EnsureRetailProfile')
    OR (v_effect.effect#>>'{intent,_tag}'='OnboardCounterpartyCustomerFromParty' AND p_resolved#>>'{intent,_tag}'='OnboardCounterpartyCustomer')
    OR (v_effect.effect#>>'{intent,_tag}'='AddPartyContactPointFromParty' AND p_resolved#>>'{intent,_tag}'='AddPartyContactPoint')
    OR (v_effect.effect#>>'{intent,_tag}'='AddSavedRetailAddressFromOwnerReceipts' AND p_resolved#>>'{intent,_tag}'='AddSavedAddress')
    OR (v_effect.effect#>>'{intent,_tag}'='AddSavedCounterpartyAddressFromOwnerReceipts' AND p_resolved#>>'{intent,_tag}'='AddSavedAddress')
    OR (v_effect.effect#>>'{intent,_tag}'='CreateCounterpartyProfileFromCounterparty' AND p_resolved#>>'{intent,_tag}'='CreateCounterpartyProfile')) THEN
      RAISE EXCEPTION 'unsupported dependent command resolution' USING ERRCODE='22023'; END IF;
  UPDATE symmy_integration.job_effects SET resolved_effect=p_resolved WHERE tenant_id=p_tenant AND effect_id=p_effect;
  RETURN QUERY SELECT true;
END; $$;
