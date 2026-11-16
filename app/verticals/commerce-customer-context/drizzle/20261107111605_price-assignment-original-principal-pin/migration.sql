CREATE OR REPLACE FUNCTION commerce_customer_context.record_customer_price_group_assignment_receipt(
 p_tenant_id uuid, p_legal_entity_id uuid, p_invocation_id uuid, p_principal_id uuid, p_action_key text, p_receipt jsonb
) RETURNS TABLE(outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, commerce_customer_context, pg_temp SET row_security = on AS $$
DECLARE v_existing commerce_customer_context.customer_price_group_assignment_receipts%ROWTYPE;
BEGIN
 IF current_setting('ontos.tenant_id',true) IS DISTINCT FROM p_tenant_id::text
 OR current_setting('ontos.legal_entity_id',true) IS DISTINCT FROM p_legal_entity_id::text
 OR p_receipt->>'recordedPrincipalId' IS DISTINCT FROM p_principal_id::text
 OR p_receipt->>'recordedActionKey' IS DISTINCT FROM p_action_key
 OR p_receipt->>'actionInvocationId' IS DISTINCT FROM p_invocation_id::text
 OR p_receipt->'profile'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
 OR p_receipt->'assignmentRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
 OR p_receipt->'priceGroupRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
 OR NOT ((p_action_key = 'commerce.customer-context.assign-customer-price-group' AND p_receipt->'profile'->>'kind'='RETAIL')
   OR (p_action_key = 'commerce.customer-context.assign-counterparty-price-group' AND p_receipt->'profile'->>'kind'='COUNTERPARTY'))
 OR NOT EXISTS (SELECT 1 FROM commerce_customer_context.customer_price_group_assignments a
  WHERE a.tenant_id=p_tenant_id AND a.legal_entity_id=p_legal_entity_id
  AND a.customer_price_group_assignment_id::text=p_receipt->'assignmentRef'->>'resourceId'
  AND a.customer_profile_id::text=p_receipt->'profile'->>'resourceId'
  AND a.price_group_resource_id=p_receipt->'priceGroupRef'->>'resourceId'
  AND a.price_group_module_id=p_receipt->'priceGroupRef'->>'moduleId'
  AND a.price_group_resource_type=p_receipt->'priceGroupRef'->>'resourceType'
  AND a.revision=(p_receipt->>'revision')::integer)
 THEN RETURN QUERY SELECT 'CONFLICT'::text; RETURN; END IF;
 INSERT INTO commerce_customer_context.customer_price_group_assignment_receipts
  (tenant_id,legal_entity_id,action_invocation_id,principal_id,action_key,receipt)
 VALUES (p_tenant_id,p_legal_entity_id,p_invocation_id,p_principal_id,p_action_key,p_receipt)
 ON CONFLICT DO NOTHING;
 SELECT r.* INTO v_existing FROM commerce_customer_context.customer_price_group_assignment_receipts r
 WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.action_invocation_id=p_invocation_id;
 IF v_existing.principal_id=p_principal_id AND v_existing.action_key=p_action_key AND v_existing.receipt=p_receipt
 THEN RETURN QUERY SELECT 'RECORDED'::text;
 ELSE RETURN QUERY SELECT 'CONFLICT'::text;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION commerce_customer_context.read_customer_price_group_assignment_receipt(
 p_tenant_id uuid, p_legal_entity_id uuid, p_invocation_id uuid, p_profile_id text, p_profile_kind text
) RETURNS TABLE(receipt jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, commerce_customer_context, pg_temp SET row_security = on AS $$
 SELECT r.receipt FROM commerce_customer_context.customer_price_group_assignment_receipts r
 WHERE current_setting('ontos.tenant_id',true)=p_tenant_id::text
 AND current_setting('ontos.legal_entity_id',true)=p_legal_entity_id::text
 AND r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.action_invocation_id=p_invocation_id
 AND r.receipt->>'recordedPrincipalId'=r.principal_id::text
 AND r.receipt->>'recordedActionKey'=r.action_key
 AND r.receipt->'profile'->>'resourceId'=p_profile_id AND r.receipt->'profile'->>'kind'=p_profile_kind;
$$;
