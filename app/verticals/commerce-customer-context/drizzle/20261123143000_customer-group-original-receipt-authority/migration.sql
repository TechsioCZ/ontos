DROP FUNCTION commerce_customer_context.read_customer_group_definition_source(uuid,uuid,uuid,jsonb);
--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.read_customer_group_definition_source(
  p_tenant_id uuid, p_legal_entity_id uuid, p_actor_principal_id uuid, p_original_invocation_id uuid, p_input jsonb
) RETURNS TABLE (outcome text, result jsonb)
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = pg_catalog, commerce_customer_context, pg_temp SET row_security = on AS $$
DECLARE
  v_binding commerce_customer_context.customer_group_definition_source_bindings%ROWTYPE;
  v_receipt commerce_customer_context.customer_group_definition_source_receipts%ROWTYPE;
  v_reader boolean;
BEGIN
  IF p_tenant_id IS NULL OR p_legal_entity_id IS NULL
    OR p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id',true),'')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id',true),'')::uuid
  THEN RAISE EXCEPTION 'Commerce scope mismatch' USING ERRCODE = '42501'; END IF;
  IF p_original_invocation_id IS NOT NULL AND p_input->>'mode' IS DISTINCT FROM 'RECEIPT' THEN
    RETURN QUERY SELECT 'SOURCE_AUTHORITY_DENIED'::text,NULL::jsonb; RETURN;
  END IF;
  -- The route's writer reads in every mode, as on main; a reader it names reads current definitions only, never a receipt.
  SELECT r.principal_id IS DISTINCT FROM p_actor_principal_id INTO v_reader
    FROM commerce_customer_context.customer_group_definition_source_routes r
    WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.active
      AND r.route_id=p_input->'route'->>'id' AND r.route_revision=p_input->'route'->>'revision'
      AND (r.principal_id=p_actor_principal_id OR (p_input->>'mode'='CURRENT' AND p_actor_principal_id=ANY(r.source_reader_principal_ids)))
      AND r.issuer=p_input->>'issuer' AND r.namespace=p_input->>'namespace'
      AND r.mapping_revision=p_input->>'mappingRevision';
  IF NOT FOUND THEN RETURN QUERY SELECT 'SOURCE_AUTHORITY_DENIED'::text,NULL::jsonb; RETURN; END IF;
  IF p_input->>'mode'='CURRENT' THEN
    SELECT * INTO v_binding FROM commerce_customer_context.customer_group_definition_source_bindings b
      WHERE b.tenant_id=p_tenant_id AND b.legal_entity_id=p_legal_entity_id AND b.issuer=p_input->>'issuer'
        AND b.namespace=p_input->>'namespace' AND b.record_id=p_input->>'recordId';
    IF NOT FOUND THEN RETURN QUERY SELECT 'FOUND'::text,jsonb_build_object('_tag','ABSENT'); RETURN; END IF;
    -- A reader reads only a definition last stored through the route that names it, never one another route of the
    -- same issuer and namespace stored.
    IF v_reader AND v_binding.source_intent->'payload'->'source'->'route'->>'id' IS DISTINCT FROM p_input->'route'->>'id'
    THEN RETURN QUERY SELECT 'SOURCE_AUTHORITY_DENIED'::text,NULL::jsonb; RETURN; END IF;
    RETURN QUERY SELECT 'FOUND'::text,jsonb_build_object('_tag','CURRENT',
      'group',commerce_customer_context.customer_group_document(p_tenant_id,p_legal_entity_id,v_binding.customer_group_id),
      'source',v_binding.source_intent->'payload'->'source'); RETURN;
  ELSIF p_input->>'mode'='RECEIPT' THEN
    SELECT * INTO v_receipt FROM commerce_customer_context.customer_group_definition_source_receipts r
      WHERE r.tenant_id=p_tenant_id AND r.legal_entity_id=p_legal_entity_id AND r.issuer=p_input->>'issuer'
        AND r.namespace=p_input->>'namespace' AND r.effect_id=p_input->>'effectId' AND r.actor_principal_id=p_actor_principal_id
        AND (p_original_invocation_id IS NULL OR r.action_invocation_id=p_original_invocation_id);
    IF NOT FOUND THEN RETURN QUERY SELECT 'NOT_FOUND'::text,NULL::jsonb; RETURN; END IF;
    IF p_original_invocation_id IS NOT NULL AND (
      v_receipt.intent #> '{payload,source,route}' IS DISTINCT FROM p_input->'route'
      OR v_receipt.intent #>> '{payload,source,mappingRevision}' IS DISTINCT FROM p_input->>'mappingRevision'
    ) THEN RETURN QUERY SELECT 'SOURCE_AUTHORITY_DENIED'::text,NULL::jsonb; RETURN; END IF;
    IF v_receipt.intent->>'operation' IS DISTINCT FROM p_input->>'expectedOperation'
      OR v_receipt.intent->'payload' IS DISTINCT FROM p_input->'expectedIntent'
    THEN RETURN QUERY SELECT 'SOURCE_CONFLICT'::text,NULL::jsonb; RETURN; END IF;
    RETURN QUERY SELECT 'FOUND'::text,jsonb_build_object('_tag','RECEIPT','group',v_receipt.result->'group',
      'operation',v_receipt.intent->>'operation','source',v_receipt.intent->'payload'->'source',
      'originalIntent',v_receipt.intent->'payload') || CASE WHEN v_receipt.intent->>'operation'='CREATE'
        THEN jsonb_build_object('created',v_receipt.result->'created') ELSE jsonb_build_object('changed',v_receipt.result->'changed') END; RETURN;
  END IF;
  RETURN QUERY SELECT 'NOT_FOUND'::text,NULL::jsonb;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.read_customer_group_definition_source(uuid,uuid,uuid,uuid,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.read_customer_group_definition_source(uuid,uuid,uuid,uuid,jsonb) TO ontos_runtime;
--> statement-breakpoint
DROP FUNCTION commerce_customer_context.read_customer_group_membership_source_receipt(uuid,uuid,uuid,jsonb);
--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.read_customer_group_membership_source_receipt(
  p_tenant_id uuid, p_legal_entity_id uuid, p_actor_principal_id uuid, p_original_invocation_id uuid, p_query jsonb
)
RETURNS TABLE (outcome text, result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
SET row_security = on
AS $$
DECLARE
  v_prior_kind text := current_setting('ontos.ccc_membership_processing_kind', true);
  v_prior_code text := current_setting('ontos.ccc_membership_reason_code', true);
  v_kind text := CASE WHEN p_query->>'processingKind' = 'ORG_BUSINESS_REFERENCE'
    THEN 'ORG_BUSINESS_REFERENCE' ELSE 'PERSON' END;
  v_outcome text;
  v_result jsonb;
  v_receipt_kind text;
BEGIN
  PERFORM set_config('ontos.ccc_membership_processing_kind', v_kind, true);
  PERFORM set_config('ontos.ccc_membership_reason_code', '', true);
  IF (v_kind = 'ORG_BUSINESS_REFERENCE' AND
      p_query #>> '{profile,profileKind}' IS DISTINCT FROM 'COUNTERPARTY')
    OR (v_kind = 'PERSON' AND p_query ? 'processingKind') THEN
    v_outcome := 'SOURCE_AUTHORITY_DENIED';
  ELSE
    SELECT recovered.outcome, recovered.result INTO v_outcome, v_result
    FROM commerce_customer_context.read_membership_source_receipt_classified_internal(
      p_tenant_id, p_legal_entity_id, p_actor_principal_id, p_query
    ) AS recovered;
  END IF;
  IF v_outcome = 'FOUND' THEN
    SELECT receipt.processing_kind INTO v_receipt_kind
    FROM commerce_customer_context.customer_group_membership_source_receipts AS receipt
    WHERE receipt.tenant_id = p_tenant_id AND receipt.legal_entity_id = p_legal_entity_id
      AND receipt.customer_profile_id = (p_query #>> '{profile,profileRef,resourceId}')::uuid
      AND receipt.issuer = p_query #>> '{manager,issuer}'
      AND receipt.source_namespace = p_query #>> '{manager,sourceNamespace}'
      AND receipt.effect_id = p_query->>'effectId' AND receipt.actor_principal_id = p_actor_principal_id
      AND (p_original_invocation_id IS NULL OR receipt.action_invocation_id = p_original_invocation_id);
    IF v_receipt_kind IS DISTINCT FROM v_kind THEN
      v_outcome := 'SOURCE_AUTHORITY_DENIED';
      v_result := NULL;
    ELSIF v_kind = 'ORG_BUSINESS_REFERENCE' THEN
      IF v_result->>'processingKind' IS DISTINCT FROM 'ORG_BUSINESS_REFERENCE'
        OR v_result->>'reasonCode' IS NULL OR v_result->>'reasonCode' NOT IN (
          'SOURCE_MEMBERSHIP_ASSERTED', 'SOURCE_MEMBERSHIP_WITHDRAWN',
          'SOURCE_COMPLETE_SET_RECONCILED', 'SOURCE_PARTIAL_SET_ASSERTED') THEN
        v_outcome := 'SOURCE_AUTHORITY_DENIED';
        v_result := NULL;
      ELSE
        v_result := commerce_customer_context.project_organization_membership_result(v_result, v_result->>'reasonCode');
      END IF;
    END IF;
  END IF;
  PERFORM set_config('ontos.ccc_membership_processing_kind', COALESCE(v_prior_kind, ''), true);
  PERFORM set_config('ontos.ccc_membership_reason_code', COALESCE(v_prior_code, ''), true);
  RETURN QUERY SELECT v_outcome, v_result;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('ontos.ccc_membership_processing_kind', COALESCE(v_prior_kind, ''), true);
  PERFORM set_config('ontos.ccc_membership_reason_code', COALESCE(v_prior_code, ''), true);
  RAISE;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION commerce_customer_context.read_customer_group_membership_source_receipt(uuid,uuid,uuid,uuid,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION commerce_customer_context.read_customer_group_membership_source_receipt(uuid,uuid,uuid,uuid,jsonb) TO ontos_runtime;
