-- Historical occurrence replay must not rewind the current source mapping version.
CREATE OR REPLACE FUNCTION price_group_catalog.execute_source_occurrence(p_tenant_id uuid, p_input jsonb, p_kind text)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_source jsonb := p_input->'sourceCorrelation';
  v_occurrence text := v_source->>'sourceOccurrenceId';
  v_hash text;
  v_saved price_group_catalog.price_group_source_operation_receipts%ROWTYPE;
  v_original price_group_catalog.price_group_catalog_ledger%ROWTYPE;
  v_native_input jsonb := p_input;
  v_outcome jsonb;
  v_original_id uuid;
BEGIN
  PERFORM price_group_catalog.assert_operation_scope(p_tenant_id);
  IF p_kind NOT IN ('CREATE_PRICE_GROUP','CREATE_DEFINITION_REVISION') THEN
    RAISE EXCEPTION 'Invalid source operation kind' USING ERRCODE='22023';
  END IF;
  IF v_occurrence IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_tenant_id::text,334));
    v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((p_input - 'actionInvocationId' - 'actingPrincipalId' - 'trustedEffectiveAt' - 'definitionRevisionId' - 'priceGroupId')::text,'UTF8')),'hex');
    SELECT * INTO v_saved FROM price_group_catalog.price_group_source_operation_receipts
      WHERE tenant_id=p_tenant_id AND action_invocation_id=(p_input->>'actionInvocationId')::uuid;
    IF FOUND THEN
      IF v_saved.intent_hash IS DISTINCT FROM v_hash OR v_saved.operation_kind IS DISTINCT FROM p_kind
        OR v_saved.acting_principal_id IS DISTINCT FROM (p_input->>'actingPrincipalId')::uuid THEN
        RETURN QUERY SELECT jsonb_build_object('_tag','idempotency_conflict'); RETURN;
      END IF;
    ELSE
      SELECT * INTO v_saved FROM price_group_catalog.price_group_source_operation_receipts
        WHERE tenant_id=p_tenant_id AND issuer=v_source->>'issuer' AND route_id=v_source->>'routeId'
          AND namespace=v_source->>'namespace' AND record_key=v_source->>'recordKey'
          AND source_occurrence_id=v_occurrence AND operation_kind=p_kind
          AND action_invocation_id=business_original_invocation_id;
      IF FOUND AND v_saved.intent_hash IS DISTINCT FROM v_hash THEN
        RETURN QUERY SELECT jsonb_build_object('_tag','idempotency_conflict'); RETURN;
      END IF;
    END IF;
    IF v_saved.action_invocation_id IS NOT NULL THEN
      SELECT * INTO STRICT v_original FROM price_group_catalog.price_group_catalog_ledger
        WHERE tenant_id=p_tenant_id AND action_invocation_id=v_saved.business_original_invocation_id AND operation_kind=p_kind;
      v_native_input := p_input || jsonb_build_object('actionInvocationId',v_original.action_invocation_id,
        'actingPrincipalId',v_original.acting_principal_id,'trustedEffectiveAt',v_original.trusted_effective_at);
    END IF;
  END IF;
  IF p_kind='CREATE_PRICE_GROUP' THEN
    SELECT result.payload INTO v_outcome FROM price_group_catalog.create_price_group_with_complete_schedule(p_tenant_id,v_native_input) AS result;
  ELSE
    SELECT result.payload INTO v_outcome FROM price_group_catalog.create_definition_revision_with_continuity(p_tenant_id,v_native_input) AS result;
  END IF;
  IF v_outcome->>'_tag' NOT IN ('accepted','replayed') THEN
    RETURN QUERY SELECT v_outcome; RETURN;
  END IF;
  -- Only successful native acceptance/replay may bind source identity or record a receipt.
  IF v_saved.action_invocation_id IS NULL THEN
    PERFORM price_group_catalog.bind_price_group_source_correlation(p_tenant_id,v_native_input,(v_outcome#>>'{definition,priceGroupRef,resourceId}')::uuid);
  END IF;
  IF v_occurrence IS NOT NULL THEN
    v_original_id := (v_outcome#>>'{definition,created,actionInvocationId}')::uuid;
    INSERT INTO price_group_catalog.price_group_source_operation_receipts
      (tenant_id,action_invocation_id,acting_principal_id,business_original_invocation_id,operation_kind,issuer,route_id,namespace,record_key,source_occurrence_id,intent_hash)
    VALUES (p_tenant_id,(p_input->>'actionInvocationId')::uuid,(p_input->>'actingPrincipalId')::uuid,v_original_id,p_kind,
      v_source->>'issuer',v_source->>'routeId',v_source->>'namespace',v_source->>'recordKey',v_occurrence,v_hash)
    ON CONFLICT (tenant_id,action_invocation_id) DO NOTHING;
    v_outcome := v_outcome || jsonb_build_object('businessOriginalInvocationId',v_original_id);
  END IF;
  RETURN QUERY SELECT v_outcome;
END $function$;
