CREATE OR REPLACE FUNCTION commerce_customer_context.apply_customer_group_membership_source(
  p_tenant_id uuid, p_legal_entity_id uuid, p_actor_principal_id uuid,
  p_invocation_id uuid, p_recorded_at timestamptz, p_payload jsonb
)
RETURNS TABLE (outcome text, result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
SET row_security = on
AS $$
DECLARE
  v_prior_kind text := current_setting('ontos.ccc_membership_processing_kind', true);
  v_prior_code text := current_setting('ontos.ccc_membership_reason_code', true);
  v_kind text := CASE WHEN p_payload->>'processingKind' = 'ORG_BUSINESS_REFERENCE'
    THEN 'ORG_BUSINESS_REFERENCE' ELSE 'PERSON' END;
  v_code text;
  v_payload jsonb := p_payload;
  v_outcome text;
  v_result jsonb;
  v_receipt_kind text;
  v_customer jsonb := p_payload->'customerSource';
  v_current jsonb;
  v_read_outcome text;
BEGIN
  -- This namespace belongs to ERP assignment, never to an unfenced direct writer.
  IF starts_with(p_payload #>> '{manager,sourceNamespace}', 'erp-membership-v1:') OR v_customer IS NOT NULL THEN
    IF v_customer IS NULL OR p_payload->>'operation' IS DISTINCT FROM 'ASSIGN'
      OR p_payload #>> '{manager,issuer}' IS DISTINCT FROM v_customer->>'issuer' THEN
      RETURN QUERY SELECT 'SOURCE_AUTHORITY_DENIED'::text,NULL::jsonb; RETURN;
    END IF;
    -- The owner's CURRENT read locks the active route (including reader identity) until this write commits.
    SELECT r.outcome,r.result INTO v_read_outcome,v_current FROM commerce_customer_context.read_customer_profile_source(
      p_tenant_id,p_legal_entity_id,p_actor_principal_id,v_customer || jsonb_build_object('mode','CURRENT')) r;
    IF v_read_outcome IS DISTINCT FROM 'AVAILABLE' OR v_current->>'_tag' IS DISTINCT FROM 'CURRENT' THEN
      RETURN QUERY SELECT 'SOURCE_AUTHORITY_DENIED'::text,NULL::jsonb; RETURN;
    END IF;
    -- Lock the exact binding and reproject its source after any competing update completes.
    SELECT commerce_customer_context.customer_profile_source_item(p_tenant_id,p_legal_entity_id,to_jsonb(b)) INTO v_current
      FROM commerce_customer_context.customer_profile_source_bindings b
      WHERE b.tenant_id=p_tenant_id AND b.issuer=v_customer->>'issuer' AND b.namespace=v_customer->>'namespace'
        AND b.record_type=v_customer->>'recordType' AND b.record_id=v_customer->>'recordId'
        AND b.customer_profile_id=(p_payload #>> '{profile,profileRef,resourceId}')::uuid
        AND b.profile_kind=p_payload #>> '{profile,profileKind}' FOR SHARE;
    IF NOT FOUND OR v_current->'source' IS DISTINCT FROM v_customer OR v_current #>> '{profile,state}' IS DISTINCT FROM 'ACTIVE' THEN
      RETURN QUERY SELECT 'TARGET_INELIGIBLE'::text,NULL::jsonb; RETURN;
    END IF;
  END IF;
  -- Caller-controlled session settings can never choose the native processing class.
  PERFORM set_config('ontos.ccc_membership_processing_kind', v_kind, true);
  PERFORM set_config('ontos.ccc_membership_reason_code', '', true);
  IF v_kind = 'ORG_BUSINESS_REFERENCE' THEN
    v_code := CASE p_payload->>'operation'
      WHEN 'ASSIGN' THEN 'SOURCE_MEMBERSHIP_ASSERTED'
      WHEN 'REMOVE' THEN 'SOURCE_MEMBERSHIP_WITHDRAWN'
      WHEN 'COMPLETE' THEN 'SOURCE_COMPLETE_SET_RECONCILED'
      WHEN 'PARTIAL' THEN 'SOURCE_PARTIAL_SET_ASSERTED' END;
    IF p_payload #>> '{profile,profileKind}' IS DISTINCT FROM 'COUNTERPARTY'
      OR p_payload ? 'reason' OR v_code IS NULL OR p_payload->>'reasonCode' IS DISTINCT FROM v_code THEN
      v_outcome := 'SOURCE_CONFLICT';
      v_result := NULL;
    ELSE
      PERFORM set_config('ontos.ccc_membership_reason_code', v_code, true);
      -- The native ledger receives the explicit finite code, never an inferred business reason.
      v_payload := p_payload || jsonb_build_object('reason', v_code);
      SELECT admitted.outcome, admitted.result INTO v_outcome, v_result
      FROM commerce_customer_context.apply_membership_source_classified_internal(
        p_tenant_id, p_legal_entity_id, p_actor_principal_id, p_invocation_id, p_recorded_at, v_payload
      ) AS admitted;
    END IF;
  ELSIF p_payload ? 'processingKind' OR p_payload ? 'reasonCode' THEN
    v_outcome := 'SOURCE_CONFLICT';
    v_result := NULL;
  ELSE
    SELECT admitted.outcome, admitted.result INTO v_outcome, v_result
      FROM commerce_customer_context.apply_membership_source_classified_internal(
      p_tenant_id, p_legal_entity_id, p_actor_principal_id, p_invocation_id, p_recorded_at, v_payload
    ) AS admitted;
  END IF;
  IF v_outcome IN ('APPLIED', 'REPLAY') THEN
    SELECT receipt.processing_kind INTO v_receipt_kind
    FROM commerce_customer_context.customer_group_membership_source_receipts AS receipt
    WHERE receipt.tenant_id = p_tenant_id AND receipt.legal_entity_id = p_legal_entity_id
      AND receipt.customer_profile_id = (p_payload #>> '{profile,profileRef,resourceId}')::uuid
      AND receipt.issuer = p_payload #>> '{manager,issuer}'
      AND receipt.source_namespace = p_payload #>> '{manager,sourceNamespace}'
      AND receipt.effect_id = p_payload #>> '{source,effectId}';
    IF v_receipt_kind IS DISTINCT FROM v_kind THEN
      v_outcome := 'SOURCE_CONFLICT';
      v_result := NULL;
    END IF;
  END IF;
  PERFORM set_config('ontos.ccc_membership_processing_kind', COALESCE(v_prior_kind, ''), true);
  PERFORM set_config('ontos.ccc_membership_reason_code', COALESCE(v_prior_code, ''), true);
  RETURN QUERY SELECT v_outcome, CASE WHEN v_kind = 'ORG_BUSINESS_REFERENCE'
    AND v_outcome IN ('APPLIED', 'REPLAY') THEN
      commerce_customer_context.project_organization_membership_result(v_result, v_code)
    ELSE v_result END;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('ontos.ccc_membership_processing_kind', COALESCE(v_prior_kind, ''), true);
  PERFORM set_config('ontos.ccc_membership_reason_code', COALESCE(v_prior_code, ''), true);
  RAISE;
END;
$$;
