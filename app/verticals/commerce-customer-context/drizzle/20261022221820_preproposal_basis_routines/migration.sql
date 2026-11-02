ALTER TABLE commerce_customer_context.purchase_proposal_bases FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.purchase_proposal_basis_state(p_tenant_id uuid, p_legal_entity_id uuid, p_payload jsonb)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
SET row_security = on
AS $$
DECLARE
  v_row commerce_customer_context.purchase_proposal_bases%ROWTYPE;
  v_operation text := p_payload->>'operation';
  v_basis jsonb := p_payload->'basis';
  v_id uuid;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id',true),'')::uuid
     OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id',true),'')::uuid
     OR p_tenant_id IS NULL OR p_legal_entity_id IS NULL THEN
    RAISE EXCEPTION 'verified basis scope required' USING ERRCODE='42501';
  END IF;
  IF v_operation = 'INTENT' THEN
    SELECT * INTO v_row FROM commerce_customer_context.purchase_proposal_bases
      WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id
        AND buyer_principal_id=(p_payload->>'buyerPrincipalId')::uuid AND intent_key=p_payload->>'intentKey';
    RETURN QUERY SELECT CASE WHEN FOUND THEN jsonb_build_object('inputHash',v_row.input_hash,'basis',v_row.encoded_basis) ELSE 'null'::jsonb END;
    RETURN;
  END IF;
  IF v_operation = 'LOAD' THEN
    SELECT * INTO v_row FROM commerce_customer_context.purchase_proposal_bases
      WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id AND basis_id=(p_payload->>'sourceRef')::uuid FOR SHARE;
    RETURN QUERY SELECT CASE WHEN FOUND THEN v_row.encoded_basis ELSE 'null'::jsonb END;
    RETURN;
  END IF;
  IF v_basis->'basisRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
    OR v_basis->'proposal'->'context'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
    OR v_basis->'proposal'->'context'->>'sellingLegalEntityId' IS DISTINCT FROM p_legal_entity_id::text
    OR v_basis->'proposal'->'proposalRevisionRef'->>'resourceId' IS DISTINCT FROM v_basis->'basisRef'->>'resourceId'
    OR v_basis->'proposal'->'purchaseValue'->>'sourceRef' IS DISTINCT FROM v_basis->'basisRef'->>'resourceId'
    OR v_basis->'proposal'->'purchaseValue'->>'sourceRevision' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'basis identity differs' USING ERRCODE='23514';
  END IF;
  v_id := (v_basis->'basisRef'->>'resourceId')::uuid;
  IF v_operation = 'PREPARE' THEN
    IF v_basis->>'status' IS DISTINCT FROM 'PREPARED'
      OR v_basis->>'preparationInvocationId' IS DISTINCT FROM p_payload->>'actionInvocationId'
      OR v_basis->'proposal'->'identity'->'buyer'->>'principalId' IS DISTINCT FROM p_payload->>'buyerPrincipalId'
      OR p_payload->>'actorPrincipalId' IS DISTINCT FROM p_payload->>'buyerPrincipalId' THEN
      RAISE EXCEPTION 'basis preparation provenance differs' USING ERRCODE='23514';
    END IF;
    INSERT INTO commerce_customer_context.purchase_proposal_bases(tenant_id,legal_entity_id,basis_id,buyer_principal_id,intent_key,input_hash,encoded_basis,action_invocation_id,actor_principal_id)
      VALUES(p_tenant_id,p_legal_entity_id,v_id,(p_payload->>'buyerPrincipalId')::uuid,p_payload->>'intentKey',p_payload->>'inputHash',v_basis,(p_payload->>'actionInvocationId')::uuid,(p_payload->>'actorPrincipalId')::uuid);
  ELSIF v_operation = 'COMPLETE' THEN
    SELECT * INTO v_row FROM commerce_customer_context.purchase_proposal_bases
      WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id AND basis_id=v_id FOR UPDATE;
    IF NOT FOUND OR v_row.encoded_basis IS DISTINCT FROM p_payload->'expected'
      OR v_row.encoded_basis->>'status' IS DISTINCT FROM 'PREPARED' OR v_basis->>'status' IS DISTINCT FROM 'READY'
      OR v_basis->>'completionInvocationId' IS DISTINCT FROM p_payload->>'actionInvocationId'
      OR v_basis->>'completionActorPrincipalId' IS DISTINCT FROM p_payload->>'actorPrincipalId'
      OR v_basis->>'completionInvocationId' IS NULL OR v_basis->>'pricingIssuanceInvocationId' IS NULL
      OR v_basis->'quotation' IS NULL OR v_basis->'quotation'='null'::jsonb
      OR v_basis->>'pricingIssuerPrincipalId' IS NULL
      OR ((v_row.encoded_basis->'proposal') - 'canonicalHash' - 'purchaseValue' - 'hierarchyInputs') IS DISTINCT FROM ((v_basis->'proposal') - 'canonicalHash' - 'purchaseValue' - 'hierarchyInputs')
      OR ((v_row.encoded_basis->'proposal'->'hierarchyInputs') - 'purchaseValue') IS DISTINCT FROM ((v_basis->'proposal'->'hierarchyInputs') - 'purchaseValue')
      OR ((v_row.encoded_basis->'proposal'->'purchaseValue') - 'monetaryAmount' - 'roundingRuleRevision') IS DISTINCT FROM ((v_basis->'proposal'->'purchaseValue') - 'monetaryAmount' - 'roundingRuleRevision')
      OR (v_row.encoded_basis - 'status' - 'proposal' - 'quotation' - 'pricingIssuanceInvocationId' - 'completionInvocationId' - 'pricingIssuerPrincipalId' - 'completionActorPrincipalId') IS DISTINCT FROM (v_basis - 'status' - 'proposal' - 'quotation' - 'pricingIssuanceInvocationId' - 'completionInvocationId' - 'pricingIssuerPrincipalId' - 'completionActorPrincipalId') THEN
      RAISE EXCEPTION 'basis completion conflict' USING ERRCODE='23514';
    END IF;
    UPDATE commerce_customer_context.purchase_proposal_bases SET encoded_basis=v_basis
      WHERE tenant_id=p_tenant_id AND legal_entity_id=p_legal_entity_id AND basis_id=v_id;
  ELSE
    RAISE EXCEPTION 'unknown basis operation' USING ERRCODE='22023';
  END IF;
  RETURN QUERY SELECT v_basis;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.purchase_proposal_basis_state(uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_customer_context.purchase_proposal_basis_state(uuid,uuid,jsonb) TO ontos_runtime;
