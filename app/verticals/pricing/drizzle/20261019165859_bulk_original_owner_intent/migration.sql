-- Existing immutable receipts remain the original owner authority. No history or public DTO rewrite.
CREATE OR REPLACE FUNCTION pricing.lookup_price_action_result_v1(
  p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb
)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_invocation_id uuid;
  v_principal_id uuid;
  v_receipt record;
  v_expected_operation jsonb;
  v_original_payload jsonb;
  v_expected_action_kind text;
  v_original_intent_matches boolean;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Pricing Price result scope mismatch' USING ERRCODE = '42501';
  END IF;
  BEGIN
    v_invocation_id := (p_input ->> 'actionInvocationId')::uuid;
    v_principal_id := (p_input ->> 'actingPrincipalId')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Pricing Price result lookup input is invalid' USING ERRCODE = '22023';
  END;
  IF jsonb_typeof(p_input) <> 'object' OR v_invocation_id IS NULL OR v_principal_id IS NULL THEN
    RAISE EXCEPTION 'Pricing Price result lookup input is invalid' USING ERRCODE = '22023';
  END IF;
  -- Private bulk callers request an exact verdict; ordinary public lookup remains result-only.
  IF p_input ? 'operation' THEN
    v_expected_operation := p_input -> 'operation';
    IF jsonb_typeof(v_expected_operation) IS DISTINCT FROM 'object'
      OR jsonb_typeof(v_expected_operation -> 'payload') IS DISTINCT FROM 'object'
      OR v_expected_operation ->> 'kind' IS NULL
      OR v_expected_operation ->> 'kind' NOT IN ('DEFINE_PRICE', 'REVISE_PRICE')
      OR (v_expected_operation - 'kind' - 'payload') <> '{}'::jsonb
    THEN
      RAISE EXCEPTION 'Pricing Price original operation is invalid' USING ERRCODE = '22023';
    END IF;
  END IF;
  SELECT receipt.* INTO v_receipt FROM pricing.price_fee_action_result_receipts AS receipt
   WHERE receipt.tenant_id = p_tenant_id AND receipt.legal_entity_id = p_legal_entity_id
     AND receipt.action_invocation_id = v_invocation_id
     AND receipt.acting_principal_id = v_principal_id;
  IF FOUND THEN
    IF v_receipt.action_kind IN ('DEFINE_PRICE', 'REVISE_PRICE') THEN
      IF v_expected_operation IS NOT NULL THEN
        v_original_payload := v_receipt.request_payload - 'actingPrincipalId' - 'actionInvocationId';
        IF jsonb_typeof(v_original_payload) IS DISTINCT FROM 'object' THEN
          RAISE EXCEPTION 'Pricing Price original operation is unavailable' USING ERRCODE = 'P7602';
        END IF;
      IF v_receipt.action_kind = 'DEFINE_PRICE'
        OR (v_receipt.action_kind = 'REVISE_PRICE' AND v_original_payload ->> 'intent' IS DISTINCT FROM 'RETIRE_CURRENT')
      THEN
        IF jsonb_typeof(v_original_payload -> 'sourceEvidence' -> 'sourceAssertion') IS DISTINCT FROM 'object' THEN
          RAISE EXCEPTION 'Pricing Price original operation predates exact source authority' USING ERRCODE = 'P7602';
        END IF;
        -- Invert the existing admitted-input transform. Retain the immutable owner proof as stored;
        -- compare the complete source assertion, never a newly admitted or restamped proof.
        v_original_payload := (v_original_payload - 'sourceEvidence') || pg_catalog.jsonb_build_object(
          'sourceAssertion', v_original_payload -> 'sourceEvidence' -> 'sourceAssertion');
      END IF;
        v_expected_action_kind := CASE v_expected_operation ->> 'kind' WHEN 'DEFINE_PRICE' THEN 'DEFINE_PRICE' ELSE 'REVISE_PRICE' END;
        -- Match every canonical business field, including full interval, expected basis and reason.
        -- Acknowledgement is the same owner-issued retry evidence excluded by the writer.
        v_original_intent_matches := v_receipt.action_kind = v_expected_action_kind
          AND v_original_payload = ((v_expected_operation -> 'payload') - 'acknowledgement');
        RETURN QUERY SELECT pg_catalog.jsonb_build_object(
          'actionInvocationId', v_invocation_id::text,
          'originalIntentMatches', v_original_intent_matches,
          'outcome', 'PRICE_ACTION_RESULT_FOUND', 'result', v_receipt.result_payload);
      ELSE
      RETURN QUERY SELECT pg_catalog.jsonb_build_object(
        'actionInvocationId', v_invocation_id::text,
        'outcome', 'PRICE_ACTION_RESULT_FOUND', 'result', v_receipt.result_payload);
      END IF;
    ELSE
      RETURN QUERY SELECT pg_catalog.jsonb_build_object(
        'actionInvocationId', v_invocation_id::text, 'outcome', 'PRICE_ACTION_RESULT_ABSENT');
    END IF;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pricing.price_invocation_receipts AS receipt
     WHERE receipt.tenant_id = p_tenant_id AND receipt.legal_entity_id = p_legal_entity_id
       AND receipt.action_invocation_id = v_invocation_id
       AND receipt.acting_principal_id = v_principal_id
    UNION ALL
    SELECT 1 FROM pricing.price_schedule_revisions AS revision
     WHERE revision.tenant_id = p_tenant_id AND revision.legal_entity_id = p_legal_entity_id
       AND revision.action_invocation_id = v_invocation_id
       AND revision.acting_principal_id = v_principal_id
    UNION ALL
    SELECT 1 FROM pricing.price_revisions AS revision
     WHERE revision.tenant_id = p_tenant_id AND revision.legal_entity_id = p_legal_entity_id
       AND revision.action_invocation_id = v_invocation_id
       AND revision.acting_principal_id = v_principal_id
  ) THEN
    RAISE EXCEPTION 'Pricing Price result predates exact receipt authority' USING ERRCODE = 'P7602';
  END IF;
  RETURN QUERY SELECT pg_catalog.jsonb_build_object(
    'actionInvocationId', v_invocation_id::text, 'outcome', 'PRICE_ACTION_RESULT_ABSENT');
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION pricing.lookup_commercial_fee_action_result_v1(
  p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb
)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_invocation_id uuid;
  v_principal_id uuid;
  v_receipt record;
  v_expected_operation jsonb;
  v_original_payload jsonb;
  v_expected_action_kind text;
  v_original_intent_matches boolean;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Pricing Commercial Fee result scope mismatch' USING ERRCODE = '42501';
  END IF;
  BEGIN
    v_invocation_id := (p_input ->> 'actionInvocationId')::uuid;
    v_principal_id := (p_input ->> 'actingPrincipalId')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Pricing Commercial Fee result lookup input is invalid' USING ERRCODE = '22023';
  END;
  IF jsonb_typeof(p_input) <> 'object' OR v_invocation_id IS NULL OR v_principal_id IS NULL THEN
    RAISE EXCEPTION 'Pricing Commercial Fee result lookup input is invalid' USING ERRCODE = '22023';
  END IF;
  -- Private bulk callers request an exact verdict; ordinary public lookup remains result-only.
  IF p_input ? 'operation' THEN
    v_expected_operation := p_input -> 'operation';
    IF jsonb_typeof(v_expected_operation) IS DISTINCT FROM 'object'
      OR jsonb_typeof(v_expected_operation -> 'payload') IS DISTINCT FROM 'object'
      OR v_expected_operation ->> 'kind' IS NULL
      OR v_expected_operation ->> 'kind' NOT IN ('DEFINE_COMMERCIAL_FEE', 'REVISE_COMMERCIAL_FEE')
      OR (v_expected_operation - 'kind' - 'payload') <> '{}'::jsonb
    THEN
      RAISE EXCEPTION 'Pricing Fee original operation is invalid' USING ERRCODE = '22023';
    END IF;
  END IF;
  SELECT receipt.* INTO v_receipt FROM pricing.price_fee_action_result_receipts AS receipt
   WHERE receipt.tenant_id = p_tenant_id AND receipt.legal_entity_id = p_legal_entity_id
     AND receipt.action_invocation_id = v_invocation_id
     AND receipt.acting_principal_id = v_principal_id;
  IF FOUND THEN
    IF v_receipt.action_kind IN ('DEFINE_COMMERCIAL_FEE', 'REVISE_COMMERCIAL_FEE',
      'MANAGE_COMMERCIAL_FEE_REVISION') THEN
      IF v_expected_operation IS NOT NULL THEN
        v_original_payload := v_receipt.request_payload - 'actingPrincipalId' - 'actionInvocationId';
        IF jsonb_typeof(v_original_payload) IS DISTINCT FROM 'object' THEN
          RAISE EXCEPTION 'Pricing Fee original operation is unavailable' USING ERRCODE = 'P7602';
        END IF;
        v_expected_action_kind := CASE WHEN v_expected_operation ->> 'kind' = 'DEFINE_COMMERCIAL_FEE' THEN 'DEFINE_COMMERCIAL_FEE' WHEN v_expected_operation -> 'payload' ->> 'intent' IN ('CORRECT_REVISION', 'RETIRE_CURRENT') THEN 'MANAGE_COMMERCIAL_FEE_REVISION' ELSE 'REVISE_COMMERCIAL_FEE' END;
        -- Match every canonical business field, including full interval, expected basis and reason.
        -- Acknowledgement is the same owner-issued retry evidence excluded by the writer.
        v_original_intent_matches := v_receipt.action_kind = v_expected_action_kind
          AND v_original_payload = ((v_expected_operation -> 'payload') - 'acknowledgement');
        RETURN QUERY SELECT pg_catalog.jsonb_build_object(
          'actionInvocationId', v_invocation_id::text,
          'originalIntentMatches', v_original_intent_matches,
          'outcome', 'COMMERCIAL_FEE_ACTION_RESULT_FOUND', 'result', v_receipt.result_payload);
      ELSE
      RETURN QUERY SELECT pg_catalog.jsonb_build_object(
        'actionInvocationId', v_invocation_id::text,
        'outcome', 'COMMERCIAL_FEE_ACTION_RESULT_FOUND', 'result', v_receipt.result_payload);
      END IF;
    ELSE
      RETURN QUERY SELECT pg_catalog.jsonb_build_object(
        'actionInvocationId', v_invocation_id::text, 'outcome', 'COMMERCIAL_FEE_ACTION_RESULT_ABSENT');
    END IF;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pricing.fee_action_invocation_receipts AS receipt
     WHERE receipt.tenant_id = p_tenant_id AND receipt.legal_entity_id = p_legal_entity_id
       AND receipt.action_invocation_id = v_invocation_id
       AND receipt.acting_principal_id = v_principal_id
    UNION ALL
    SELECT 1 FROM pricing.fee_schedule_revisions AS revision
     WHERE revision.tenant_id = p_tenant_id AND revision.legal_entity_id = p_legal_entity_id
       AND revision.action_invocation_id = v_invocation_id
       AND revision.acting_principal_id = v_principal_id
    UNION ALL
    SELECT 1 FROM pricing.fee_revisions AS revision
     WHERE revision.tenant_id = p_tenant_id AND revision.legal_entity_id = p_legal_entity_id
       AND revision.action_invocation_id = v_invocation_id
       AND revision.acting_principal_id = v_principal_id
  ) THEN
    RAISE EXCEPTION 'Pricing Commercial Fee result predates exact receipt authority' USING ERRCODE = 'P7602';
  END IF;
  RETURN QUERY SELECT pg_catalog.jsonb_build_object(
    'actionInvocationId', v_invocation_id::text, 'outcome', 'COMMERCIAL_FEE_ACTION_RESULT_ABSENT');
END;
$function$;
