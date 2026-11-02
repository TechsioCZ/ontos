-- #1279: preserve actual proof observation and frozen business effective time in generation verification.
CREATE OR REPLACE FUNCTION pricing.verify_exact_price_candidate_set_generation_v1(
  p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb
)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_key jsonb := p_input -> 'exactKey';
  v_authority jsonb := p_input -> 'authority';
  v_through timestamptz;
  v_observed_at timestamptz;
  v_next_boundary timestamptz;
  v_root record;
  v_head record;
  v_head_found boolean := false;
  v_current boolean := false;
  v_root_count integer := 0;
  v_price_count integer := 0;
  v_actual_next_boundary timestamptz;
  v_effective_at timestamptz;
  v_canonical_key jsonb;
  v_predicate_digest text;
  v_basis_quantity numeric;
  v_stored_basis_quantity numeric(38,9);
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Exact Price candidate-set verification scope mismatch' USING ERRCODE = '42501';
  END IF;
  BEGIN
    v_through := (p_input ->> 'through')::timestamptz;
    v_effective_at := (p_input ->> 'effectiveAt')::timestamptz;
    v_observed_at := (v_authority ->> 'observedAt')::timestamptz;
    v_next_boundary := (v_authority ->> 'nextApplicabilityBoundary')::timestamptz;
    v_basis_quantity := (v_key#>>'{unitBasis,quantity}')::numeric;
    v_stored_basis_quantity := (v_key#>>'{unitBasis,quantity}')::numeric(38,9);
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Exact Price candidate-set verification input is invalid' USING ERRCODE = '22023';
  END;
  -- Business effectiveAt and actual owner observedAt are separate instants. The
  -- retained original witness must span aggregate completion, never a later reread.
  IF v_effective_at IS NULL OR v_observed_at IS NULL OR v_through IS NULL
    OR v_basis_quantity IS NULL OR v_stored_basis_quantity IS NULL
    OR v_basis_quantity<=0 OR v_basis_quantity<>v_stored_basis_quantity OR v_observed_at<v_effective_at
    OR v_through < v_observed_at OR v_through > pg_catalog.statement_timestamp() THEN
    RAISE EXCEPTION 'Exact Price candidate-set verification interval is invalid' USING ERRCODE = '22023';
  END IF;
  IF v_authority->>'kind' = 'VIRTUAL_EMPTY' THEN
    v_canonical_key := pg_catalog.jsonb_set(
      v_key, '{unitBasis,quantity}',
      pg_catalog.to_jsonb(v_stored_basis_quantity::text), false
    );
    v_predicate_digest := pg_catalog.encode(public.digest(pg_catalog.convert_to(v_canonical_key::text,'UTF8'),'sha256'),'hex');
    SELECT count(*)::integer INTO v_root_count FROM pricing.price_candidate_set_roots AS root
     WHERE root.tenant_id=p_tenant_id AND root.legal_entity_id=p_legal_entity_id
       AND root.catalog_selection=v_key->'catalogSelection'
       AND root.channel_id=v_key#>>'{commercialScope,channelId}' AND root.market_id=v_key#>>'{commercialScope,marketId}'
       AND root.currency_code=v_key->>'currencyCode' AND root.unit_ref=v_key#>'{unitBasis,unitRef}'
       AND root.basis_quantity=v_stored_basis_quantity
       AND root.price_group_selector=v_key->'priceGroupSelector';
    SELECT count(*)::integer INTO v_price_count FROM pricing.prices AS price
     WHERE price.tenant_id=p_tenant_id AND price.legal_entity_id=p_legal_entity_id
       AND price.catalog_selection=v_key->'catalogSelection'
       AND price.channel_id=v_key#>>'{commercialScope,channelId}' AND price.market_id=v_key#>>'{commercialScope,marketId}'
       AND price.currency_code=v_key->>'currencyCode' AND price.unit_ref=v_key#>'{unitBasis,unitRef}'
       AND price.basis_quantity=v_stored_basis_quantity
       AND price.price_group_selector=v_key->'priceGroupSelector';
    v_current := v_root_count=0 AND v_price_count=0
      AND v_authority->>'ownerRootRef'='commerce.pricing.virtual-empty-price-set-root:' || v_predicate_digest
      AND v_authority->>'ownerRevision'='commerce.pricing.virtual-empty-price-set-revision:' || v_predicate_digest
      AND v_authority->>'predicateRef'='commerce.pricing.exact-price-candidates:' || v_predicate_digest
      AND v_authority->>'verificationRef'='commerce.pricing.virtual-empty-price-set-proof:' || v_predicate_digest
      AND (v_next_boundary IS NULL OR v_through<v_next_boundary);
  ELSE
  SELECT root.* INTO v_root FROM pricing.price_candidate_set_roots AS root
   WHERE root.tenant_id=p_tenant_id AND root.legal_entity_id=p_legal_entity_id
     AND root.catalog_selection=v_key->'catalogSelection'
     AND root.channel_id=v_key#>>'{commercialScope,channelId}' AND root.market_id=v_key#>>'{commercialScope,marketId}'
     AND root.currency_code=v_key->>'currencyCode' AND root.unit_ref=v_key#>'{unitBasis,unitRef}'
     AND root.basis_quantity=v_stored_basis_quantity
     AND root.price_group_selector=v_key->'priceGroupSelector';
  IF FOUND THEN
    SELECT head.* INTO v_head FROM pricing.price_candidate_set_heads AS head
     WHERE head.tenant_id=p_tenant_id AND head.legal_entity_id=p_legal_entity_id
       AND head.price_candidate_set_root_id=v_root.price_candidate_set_root_id;
    v_head_found := FOUND;
    SELECT min(boundary) INTO v_actual_next_boundary FROM (
      SELECT entry.effective_from AS boundary
        FROM pricing.prices AS price
        JOIN pricing.price_schedule_heads AS schedule_head
          ON schedule_head.tenant_id=price.tenant_id AND schedule_head.legal_entity_id=price.legal_entity_id
         AND schedule_head.price_id=price.price_id
        JOIN pricing.price_schedule_entries AS entry
          ON entry.tenant_id=schedule_head.tenant_id AND entry.legal_entity_id=schedule_head.legal_entity_id
         AND entry.price_id=schedule_head.price_id
         AND entry.price_schedule_revision_id=schedule_head.price_schedule_revision_id
       WHERE price.tenant_id=p_tenant_id AND price.legal_entity_id=p_legal_entity_id
         AND price.catalog_selection=v_root.catalog_selection AND price.channel_id=v_root.channel_id
         AND price.market_id=v_root.market_id AND price.currency_code=v_root.currency_code
         AND price.unit_ref=v_root.unit_ref AND price.basis_quantity=v_root.basis_quantity
         AND price.price_group_selector=v_root.price_group_selector AND entry.effective_from>v_effective_at
      UNION ALL
      SELECT entry.effective_to
        FROM pricing.prices AS price
        JOIN pricing.price_schedule_heads AS schedule_head
          ON schedule_head.tenant_id=price.tenant_id AND schedule_head.legal_entity_id=price.legal_entity_id
         AND schedule_head.price_id=price.price_id
        JOIN pricing.price_schedule_entries AS entry
          ON entry.tenant_id=schedule_head.tenant_id AND entry.legal_entity_id=schedule_head.legal_entity_id
         AND entry.price_id=schedule_head.price_id
         AND entry.price_schedule_revision_id=schedule_head.price_schedule_revision_id
       WHERE price.tenant_id=p_tenant_id AND price.legal_entity_id=p_legal_entity_id
         AND price.catalog_selection=v_root.catalog_selection AND price.channel_id=v_root.channel_id
         AND price.market_id=v_root.market_id AND price.currency_code=v_root.currency_code
         AND price.unit_ref=v_root.unit_ref AND price.basis_quantity=v_root.basis_quantity
         AND price.price_group_selector=v_root.price_group_selector AND entry.effective_to>v_effective_at
      UNION ALL
      SELECT assertion.owner_business_effective_at
        FROM pricing.prices AS price
        JOIN pricing.price_source_assertions AS assertion
          ON assertion.tenant_id=price.tenant_id AND assertion.legal_entity_id=price.legal_entity_id
         AND assertion.price_id=price.price_id
       WHERE price.tenant_id=p_tenant_id AND price.legal_entity_id=p_legal_entity_id
         AND price.catalog_selection=v_root.catalog_selection AND price.channel_id=v_root.channel_id
         AND price.market_id=v_root.market_id AND price.currency_code=v_root.currency_code
         AND price.unit_ref=v_root.unit_ref AND price.basis_quantity=v_root.basis_quantity
         AND price.price_group_selector=v_root.price_group_selector
         AND assertion.owner_business_effective_at>v_effective_at
    ) AS boundaries;
    v_current := v_head_found
      AND v_root.price_candidate_set_root_id::text = v_authority->>'ownerRootRef'
      AND v_head.price_candidate_set_revision_id::text = v_authority->>'ownerRevision'
      AND v_head.generation = (v_authority->>'generation')::integer
      AND v_authority->>'predicateRef'='commerce.pricing.exact-price-candidates:' || v_root.price_candidate_set_root_id::text
      AND v_authority->>'verificationRef'='commerce.pricing.exact-price-candidate-set-proof:' ||
        v_root.price_candidate_set_root_id::text || ':' || v_head.price_candidate_set_revision_id::text || ':' || v_head.generation::text
      AND v_next_boundary IS NOT DISTINCT FROM v_actual_next_boundary
      AND (v_next_boundary IS NULL OR v_through < v_next_boundary);
  END IF;
  END IF;
  IF v_current IS NOT TRUE THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      'outcome','EXACT_PRICE_CANDIDATE_SET_GENERATION_CHANGED',
      'verifiedThrough',pg_catalog.to_char(v_through AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    RETURN;
  END IF;
  RETURN QUERY SELECT pg_catalog.jsonb_build_object(
    'authority',v_authority,'outcome','EXACT_PRICE_CANDIDATE_SET_GENERATION_CURRENT',
    'verifiedThrough',pg_catalog.to_char(v_through AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END;
$function$;

REVOKE ALL ON FUNCTION pricing.verify_exact_price_candidate_set_generation_v1(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pricing.verify_exact_price_candidate_set_generation_v1(uuid, uuid, jsonb) TO ontos_runtime;
