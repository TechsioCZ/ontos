CREATE FUNCTION commerce_customer_context.read_source_profile_address_candidates(
  p_tenant_id uuid, p_legal_entity_id uuid, p_actor_id uuid, p_input jsonb
) RETURNS TABLE(outcome text, candidates jsonb)
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = pg_catalog, commerce_customer_context, pg_temp SET row_security = on AS $$
DECLARE v_source jsonb := p_input->'source';
BEGIN
  PERFORM commerce_customer_context.assert_profile_operation_scope(p_tenant_id, p_legal_entity_id);
  IF NOT EXISTS (
    SELECT 1 FROM commerce_customer_context.customer_profile_source_routes r
    WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.active
      AND (r.principal_id=p_actor_id OR p_actor_id=ANY(r.source_reader_principal_ids))
      AND r.route_id=v_source->'route'->>'id' AND r.route_revision=v_source->'route'->>'revision'
      AND r.mapping_revision=v_source->>'mappingRevision' AND r.issuer=v_source->>'issuer'
      AND r.namespace=v_source->>'namespace' AND r.record_type=v_source->>'recordType'
  ) THEN
    RETURN QUERY SELECT 'SOURCE_AUTHORITY_DENIED'::text, '[]'::jsonb; RETURN;
  END IF;
  -- Correlation metadata only. The caller must reauthorize CURRENT source/Privacy before reading address values.
  RETURN QUERY SELECT 'AVAILABLE'::text, coalesce(jsonb_agg(q.candidate ORDER BY q.saved_address_id), '[]'::jsonb)
  FROM (
    SELECT b.saved_address_id,
      jsonb_build_object('savedAddressId',b.saved_address_id,'source',receipt.source) AS candidate
    FROM commerce_customer_context.saved_address_source_bindings b
    JOIN LATERAL (
      SELECT r.source FROM commerce_customer_context.saved_address_source_receipts r
      WHERE r.tenant_id=b.tenant_id AND r.legal_entity_id=b.legal_entity_id
        AND r.issuer=b.issuer AND r.namespace=b.namespace
        AND r.source #>> '{identity,recordType}'=b.record_type
        AND r.source #>> '{identity,recordId}'=b.record_id
        AND r.result #>> '{profile,profileRef,resourceId}'=b.customer_profile_id::text
        AND r.source #>> '{identity,routeRef}'=v_source->'route'->>'id'
      ORDER BY r.recorded_at DESC, r.action_invocation_id DESC LIMIT 1
    ) receipt ON true
    WHERE b.tenant_id=p_tenant_id AND b.legal_entity_id=p_legal_entity_id
      AND b.customer_profile_id=(p_input->>'profileId')::uuid
      AND b.issuer=v_source->>'issuer' AND b.namespace=v_source->>'namespace'
    ORDER BY b.saved_address_id LIMIT 257
  ) q;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.read_source_profile_address_candidates(uuid,uuid,uuid,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.read_source_profile_address_candidates(uuid,uuid,uuid,jsonb) TO ontos_runtime;
