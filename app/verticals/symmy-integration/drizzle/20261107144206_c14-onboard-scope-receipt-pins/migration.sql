-- Retain actual native Onboard legal-entity and role-period evidence without widening other receipt tags.
CREATE OR REPLACE FUNCTION symmy_integration.record_symmy_owner_receipt(p_tenant uuid,p_job uuid,p_effect uuid,p_token uuid,p_version integer,p_receipt jsonb)
RETURNS TABLE(applied boolean) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, symmy_integration, pg_temp SET row_security = on AS $$
DECLARE v_effect symmy_integration.job_effects%ROWTYPE; v_expected jsonb; v_optional jsonb := '{}'::jsonb; v_owner text; v_operation text;
BEGIN
  IF p_tenant IS DISTINCT FROM nullif(current_setting('ontos.tenant_id',true),'')::uuid THEN
    RAISE EXCEPTION 'tenant scope mismatch' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_effect FROM symmy_integration.job_effects e WHERE e.tenant_id=p_tenant AND e.job_id=p_job AND e.effect_id=p_effect FOR UPDATE;
  IF NOT FOUND OR v_effect.state<>'attempting' OR v_effect.claim_token IS DISTINCT FROM p_token OR v_effect.version<>p_version OR v_effect.lease_until<=clock_timestamp() THEN
    RETURN QUERY SELECT false; RETURN; END IF;
  -- Linked Party/Counterparty references remain Party-owned even in a Commerce profile receipt.
  -- The finite tag determines the exact allowed reference fields; this is not a foreign-ref allowlist.
  CASE p_receipt->>'_tag'
    WHEN 'ProductCreated' THEN v_owner:='commerce.catalog'; v_operation:='commerce.catalog.create-product';
      v_expected:='{"productRef":["commerce.catalog","commerce.catalog.product"],"initialVariantRef":["commerce.catalog","commerce.catalog.variant"]}'::jsonb;
    WHEN 'VariantCreated' THEN v_owner:='commerce.catalog'; v_operation:='commerce.catalog.create-variant';
      v_expected:='{"productRef":["commerce.catalog","commerce.catalog.product"],"variantRef":["commerce.catalog","commerce.catalog.variant"]}'::jsonb;
    WHEN 'PriceGroupCreated' THEN v_owner:='pricing.price-group-catalog'; v_operation:='pricing.price-group-catalog.create-price-group';
      v_expected:='{"priceGroupRef":["pricing.price-group-catalog","pricing.price-group-catalog.price-group"]}'::jsonb;
    WHEN 'PartyCreated' THEN v_owner:='party.registry'; v_operation:='party.registry.create-party';
      v_expected:='{"partyRef":["party.registry","party.registry.party"]}'::jsonb;
    WHEN 'PartyMatched' THEN v_owner:='party.registry'; v_operation:='party.registry.match-party';
      v_expected:='{"partyRef":["party.registry","party.registry.party"]}'::jsonb;
    WHEN 'CounterpartyCustomerOnboarded' THEN v_owner:='party.registry'; v_operation:='party.registry.counterparty-customer-onboard';
      v_expected:='{"partyRef":["party.registry","party.registry.party"],"counterpartyRef":["party.registry","party.registry.counterparty"]}'::jsonb;
      v_optional:='{"legalEntityRef":["core.identity","core.identity.legal-entity"],"rolePeriodRef":["party.registry","party.registry.counterparty-role-period"]}'::jsonb;
    WHEN 'PartyContactPointAdded' THEN v_owner:='party.registry'; v_operation:='party.registry.add-contact-point';
      v_expected:='{"partyRef":["party.registry","party.registry.party"],"contactPointRef":["party.registry","party.registry.party-contact-point"]}'::jsonb;
    WHEN 'RetailProfileEnsured' THEN v_owner:='commerce.customer-context'; v_operation:='commerce.customer-context.ensure-retail-customer-profile';
      v_expected:='{"partyRef":["party.registry","party.registry.party"],"profileRef":["commerce.customer-context","commerce.customer-context.retail-customer-profile"]}'::jsonb;
    WHEN 'CounterpartyProfileCreated' THEN v_owner:='commerce.customer-context'; v_operation:='commerce.customer-context.create-counterparty-purchasing-profile';
      v_expected:='{"counterpartyRef":["party.registry","party.registry.counterparty"],"profileRef":["commerce.customer-context","commerce.customer-context.counterparty-purchasing-profile"]}'::jsonb;
    ELSE RAISE EXCEPTION 'unsupported canonical receipt kind' USING ERRCODE='22023';
  END CASE;
  IF jsonb_typeof(p_receipt) IS DISTINCT FROM 'object'
    OR v_effect.effect#>>'{ref,operation,moduleId}' IS DISTINCT FROM v_owner
    OR v_effect.effect#>>'{ref,operation,entrypointKey}' IS DISTINCT FROM v_operation
    OR EXISTS(SELECT 1 FROM jsonb_each(v_expected || v_optional) expected
      WHERE (v_expected ? expected.key OR p_receipt ? expected.key) AND (jsonb_typeof(p_receipt->expected.key) IS DISTINCT FROM 'object'
        OR p_receipt#>>ARRAY[expected.key,'tenantId'] IS DISTINCT FROM p_tenant::text
        OR p_receipt#>>ARRAY[expected.key,'moduleId'] IS DISTINCT FROM expected.value->>0
        OR p_receipt#>>ARRAY[expected.key,'resourceType'] IS DISTINCT FROM expected.value->>1
        OR jsonb_typeof(p_receipt#>ARRAY[expected.key,'resourceId']) IS DISTINCT FROM 'string'
        OR char_length(p_receipt#>>ARRAY[expected.key,'resourceId']) NOT BETWEEN 1 AND 300))
    OR EXISTS(SELECT 1 FROM jsonb_each(p_receipt) r WHERE jsonb_typeof(r.value)='object' AND r.value ? 'tenantId' AND NOT((v_expected || v_optional) ? r.key))
    OR (p_receipt ? 'legalEntityRef' AND p_receipt#>>'{legalEntityRef,resourceId}' IS DISTINCT FROM
      (SELECT j.legal_entity_id::text FROM symmy_integration.import_jobs j WHERE j.tenant_id=p_tenant AND j.job_id=p_job)) THEN
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
