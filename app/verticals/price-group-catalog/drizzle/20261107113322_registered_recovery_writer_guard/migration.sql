-- A verified recovery reader selects the immutable original writer only after Core historical proof.
CREATE OR REPLACE FUNCTION price_group_catalog.read_price_group_operation_receipt(p_tenant_id uuid, p_input jsonb)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
DECLARE v_entry price_group_catalog.price_group_catalog_ledger%ROWTYPE;
BEGIN
  PERFORM price_group_catalog.assert_operation_scope(p_tenant_id);
  SELECT * INTO v_entry FROM price_group_catalog.price_group_catalog_ledger
    WHERE tenant_id = p_tenant_id AND action_invocation_id = (p_input->>'actionInvocationId')::uuid
      AND (NOT p_input ? 'actingPrincipalId' OR acting_principal_id = (p_input->>'actingPrincipalId')::uuid);
  IF NOT FOUND THEN
    RETURN QUERY SELECT jsonb_build_object('outcome','PRICE_GROUP_OPERATION_ABSENT','actionInvocationId',p_input->>'actionInvocationId'); RETURN;
  END IF;
  RETURN QUERY SELECT jsonb_build_object('outcome','PRICE_GROUP_OPERATION_FOUND','receipt',jsonb_build_object(
    'actionInvocationId',v_entry.action_invocation_id,'operationKind',v_entry.operation_kind,
    'catalogRevision',v_entry.catalog_revision,'definitionRevisionId',v_entry.definition_revision_id,
    'priceGroupRef',jsonb_build_object('moduleId','pricing.price-group-catalog','resourceType','pricing.price-group-catalog.price-group','tenantId',p_tenant_id,'resourceId',v_entry.price_group_id)
  ));
END $function$;
