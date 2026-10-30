-- Preserve the native Commercial Fee as-of/observation distinction at final validation.
CREATE OR REPLACE FUNCTION pricing.verify_commercial_fee_set_generation_v1(
  p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb
)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_authority jsonb := p_input->'authority';
  v_variant_ref jsonb := p_input#>'{target,variantRef}';
  v_through timestamptz;
  v_effective_at timestamptz;
  v_observed_at timestamptz;
  v_next_boundary timestamptz;
  v_actual_next_boundary timestamptz;
  v_predicate_ref text;
  v_root record;
  v_head record;
  v_head_found boolean := false;
  v_current boolean := false;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Commercial Fee set verification scope mismatch' USING ERRCODE = '42501';
  END IF;
  BEGIN
    v_through := (p_input->>'through')::timestamptz;
    v_effective_at := (p_input->>'effectiveAt')::timestamptz;
    v_observed_at := (v_authority->>'observedAt')::timestamptz;
    v_next_boundary := (v_authority->>'nextApplicabilityBoundary')::timestamptz;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Commercial Fee set verification input is invalid' USING ERRCODE = '22023';
  END;
  -- Actual observation may follow the requested as-of instant. Confirm the original
  -- witness through aggregate completion, never a later replacement observation.
  IF v_effective_at IS NULL OR v_observed_at IS NULL OR v_through IS NULL
    OR v_observed_at < v_effective_at OR v_through < v_observed_at
    OR v_through > pg_catalog.statement_timestamp() THEN
    RAISE EXCEPTION 'Commercial Fee set verification interval is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT root.* INTO v_root FROM pricing.fee_set_roots AS root
   WHERE root.tenant_id=p_tenant_id AND root.legal_entity_id=p_legal_entity_id
     AND root.variant_ref=v_variant_ref
     AND root.channel_id=p_input#>>'{commercialScope,channelId}'
     AND root.market_id=p_input#>>'{commercialScope,marketId}'
     AND root.currency_code=p_input->>'currencyCode' AND root.monetary_boundary='PRE_TAX';
  IF FOUND THEN
    SELECT head.* INTO v_head FROM pricing.fee_set_heads AS head
     WHERE head.tenant_id=p_tenant_id AND head.legal_entity_id=p_legal_entity_id
       AND head.fee_set_root_id=v_root.fee_set_root_id;
    v_head_found := FOUND;
    SELECT min(boundary) INTO v_actual_next_boundary FROM (
      SELECT entry.effective_from AS boundary
        FROM pricing.fees AS fee
        JOIN pricing.fee_schedule_heads AS schedule_head
          ON schedule_head.tenant_id=fee.tenant_id AND schedule_head.legal_entity_id=fee.legal_entity_id
         AND schedule_head.fee_id=fee.fee_id
        JOIN pricing.fee_schedule_entries AS entry
          ON entry.tenant_id=schedule_head.tenant_id AND entry.legal_entity_id=schedule_head.legal_entity_id
         AND entry.fee_id=schedule_head.fee_id
         AND entry.fee_schedule_revision_id=schedule_head.fee_schedule_revision_id
       WHERE fee.tenant_id=p_tenant_id AND fee.legal_entity_id=p_legal_entity_id
         AND fee.variant_ref=v_root.variant_ref AND fee.channel_id=v_root.channel_id
         AND fee.market_id=v_root.market_id AND fee.currency_code=v_root.currency_code
         AND fee.monetary_boundary=v_root.monetary_boundary AND entry.effective_from>v_effective_at
      UNION ALL
      SELECT entry.effective_to
        FROM pricing.fees AS fee
        JOIN pricing.fee_schedule_heads AS schedule_head
          ON schedule_head.tenant_id=fee.tenant_id AND schedule_head.legal_entity_id=fee.legal_entity_id
         AND schedule_head.fee_id=fee.fee_id
        JOIN pricing.fee_schedule_entries AS entry
          ON entry.tenant_id=schedule_head.tenant_id AND entry.legal_entity_id=schedule_head.legal_entity_id
         AND entry.fee_id=schedule_head.fee_id
         AND entry.fee_schedule_revision_id=schedule_head.fee_schedule_revision_id
       WHERE fee.tenant_id=p_tenant_id AND fee.legal_entity_id=p_legal_entity_id
         AND fee.variant_ref=v_root.variant_ref AND fee.channel_id=v_root.channel_id
         AND fee.market_id=v_root.market_id AND fee.currency_code=v_root.currency_code
         AND fee.monetary_boundary=v_root.monetary_boundary AND entry.effective_to>v_effective_at
    ) AS boundaries;
    v_predicate_ref := 'pricing-commercial-fee-current-set:v1:' ||
      pricing.encode_uri_component_v1(v_variant_ref->>'tenantId') || ':' ||
      pricing.encode_uri_component_v1(v_variant_ref->>'moduleId') || ':' ||
      pricing.encode_uri_component_v1(v_variant_ref->>'resourceType') || ':' ||
      pricing.encode_uri_component_v1(v_variant_ref->>'resourceId') || ':' ||
      pricing.encode_uri_component_v1(p_legal_entity_id::text) || ':' ||
      pricing.encode_uri_component_v1(v_root.channel_id) || ':' ||
      pricing.encode_uri_component_v1(v_root.market_id) || ':' ||
      pricing.encode_uri_component_v1(v_root.currency_code);
    v_current := v_head_found AND v_root.fee_set_root_id::text=v_authority->>'ownerRootRef'
      AND v_head.fee_set_revision_id::text=v_authority->>'ownerRevision'
      AND v_head.generation=(v_authority->>'generation')::integer
      AND v_authority->>'predicateRef'=v_predicate_ref
      AND v_authority->>'verificationRef'='commerce.pricing.commercial-fee-set-proof:' ||
        v_root.fee_set_root_id::text || ':' || v_head.fee_set_revision_id::text || ':' || v_head.generation::text
      AND v_next_boundary IS NOT DISTINCT FROM v_actual_next_boundary
      AND (v_next_boundary IS NULL OR v_through < v_next_boundary);
  END IF;
  IF v_current IS NOT TRUE THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      'outcome','COMMERCIAL_FEE_SET_GENERATION_CHANGED',
      'verifiedThrough',pg_catalog.to_char(v_through AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    RETURN;
  END IF;
  RETURN QUERY SELECT pg_catalog.jsonb_build_object(
    'authority',v_authority,'outcome','COMMERCIAL_FEE_SET_GENERATION_CURRENT',
    'verifiedThrough',pg_catalog.to_char(v_through AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END;
$function$;
