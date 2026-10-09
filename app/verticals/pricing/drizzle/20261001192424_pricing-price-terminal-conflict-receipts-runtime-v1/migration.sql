-- A Product bulk Action commits terminal per-target conflicts as part of its own successful
-- orchestration result. Retain those exact owner results so a later bulk retry reconciles the
-- original target instead of executing the same terminal conflict again. Retryable validation
-- outcomes and acknowledgement-required revisions remain unstored so the same invocation may
-- be retried when their missing precondition is supplied.
CREATE FUNCTION pricing.execute_price_action_with_terminal_result_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_input jsonb,
  p_action_kind text
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_invocation_id uuid;
  v_principal_id uuid;
  v_result jsonb;
  v_canonical_input jsonb;
  v_matching_claim boolean := false;
BEGIN
  IF p_action_kind NOT IN ('DEFINE_PRICE', 'REVISE_PRICE') THEN
    RAISE EXCEPTION 'Pricing terminal result action kind is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT result.payload INTO v_result
    FROM pricing.execute_price_fee_action_with_result_v1(
      p_tenant_id,
      p_legal_entity_id,
      p_input,
      p_action_kind
    ) AS result;
  IF v_result IS NULL OR pg_catalog.jsonb_typeof(v_result) <> 'object' THEN
    RAISE EXCEPTION 'Pricing Action returned no result' USING ERRCODE = 'P7602';
  END IF;

  IF v_result ->> 'outcome' = 'CONFLICT'
    AND v_result ->> 'reason' IS DISTINCT FROM 'IDEMPOTENCY_CONFLICT'
  THEN
    BEGIN
      v_invocation_id := (p_input ->> 'actionInvocationId')::uuid;
      v_principal_id := (p_input ->> 'actingPrincipalId')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Pricing terminal result invocation is invalid' USING ERRCODE = '22023';
    END;
    IF v_invocation_id IS NULL OR v_principal_id IS NULL THEN
      RAISE EXCEPTION 'Pricing terminal result invocation or principal is missing' USING ERRCODE = '22023';
    END IF;

    v_canonical_input := p_input
      - 'requestCorrelationId'
      - 'trustedOperationAt'
      - 'acknowledgement';

    INSERT INTO pricing.price_fee_action_invocation_claims (
      tenant_id,
      legal_entity_id,
      action_invocation_id,
      acting_principal_id,
      action_kind,
      canonical_request_payload
    ) VALUES (
      p_tenant_id,
      p_legal_entity_id,
      v_invocation_id,
      v_principal_id,
      p_action_kind,
      v_canonical_input
    ) ON CONFLICT (tenant_id, action_invocation_id) DO NOTHING;

    SELECT true INTO v_matching_claim
      FROM pricing.price_fee_action_invocation_claims AS claim
     WHERE claim.tenant_id = p_tenant_id
       AND claim.legal_entity_id = p_legal_entity_id
       AND claim.action_invocation_id = v_invocation_id
       AND claim.acting_principal_id = v_principal_id
       AND claim.action_kind = p_action_kind
       AND claim.canonical_request_payload = v_canonical_input;
    IF NOT v_matching_claim THEN
      RETURN QUERY SELECT pg_catalog.jsonb_build_object(
        'outcome', 'CONFLICT', 'reason', 'IDEMPOTENCY_CONFLICT'
      );
      RETURN;
    END IF;

    INSERT INTO pricing.price_fee_action_result_receipts (
      tenant_id,
      legal_entity_id,
      action_invocation_id,
      acting_principal_id,
      action_kind,
      request_payload,
      result_payload
    ) VALUES (
      p_tenant_id,
      p_legal_entity_id,
      v_invocation_id,
      v_principal_id,
      p_action_kind,
      v_canonical_input,
      v_result
    ) ON CONFLICT (tenant_id, action_invocation_id) DO NOTHING;
  END IF;

  RETURN QUERY SELECT v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION pricing.define_price_v3(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_input jsonb
)
RETURNS TABLE(payload jsonb)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT result.payload
    FROM pricing.execute_price_action_with_terminal_result_v1(
      p_tenant_id, p_legal_entity_id, p_input, 'DEFINE_PRICE'
    ) AS result;
$function$;

CREATE OR REPLACE FUNCTION pricing.revise_price_v3(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_input jsonb
)
RETURNS TABLE(payload jsonb)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT result.payload
    FROM pricing.execute_price_action_with_terminal_result_v1(
      p_tenant_id, p_legal_entity_id, p_input, 'REVISE_PRICE'
    ) AS result;
$function$;

GRANT CREATE ON SCHEMA pricing TO pricing_management_routine_writer;
ALTER FUNCTION pricing.execute_price_action_with_terminal_result_v1(uuid,uuid,jsonb,text)
  OWNER TO pricing_management_routine_writer;
REVOKE CREATE ON SCHEMA pricing FROM pricing_management_routine_writer;

REVOKE ALL ON FUNCTION pricing.execute_price_action_with_terminal_result_v1(uuid,uuid,jsonb,text)
  FROM PUBLIC, ontos_runtime;
REVOKE ALL ON FUNCTION pricing.define_price_v3(uuid,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.revise_price_v3(uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pricing.define_price_v3(uuid,uuid,jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.revise_price_v3(uuid,uuid,jsonb) TO ontos_runtime;
