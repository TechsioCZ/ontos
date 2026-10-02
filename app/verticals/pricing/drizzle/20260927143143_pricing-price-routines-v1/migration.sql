-- #755: immediate-current Price foundation only. #756 owns future schedules and interval changes.
ALTER TABLE "pricing"."prices" FORCE ROW LEVEL SECURITY;
ALTER TABLE "pricing"."price_revisions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "pricing"."price_current_revisions" FORCE ROW LEVEL SECURITY;

CREATE FUNCTION "pricing"."define_price_v1"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_input jsonb
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_action_invocation_id uuid;
  v_acting_principal_id uuid;
  v_amount_text text;
  v_amount numeric(38,9);
  v_catalog_selection jsonb;
  v_channel_id text;
  v_currency_code text;
  v_effective_from timestamptz;
  v_existing_price_id uuid;
  v_group_selector jsonb;
  v_market_id text;
  v_price_id uuid;
  v_requested_price_id uuid;
  v_price_revision_id uuid;
  v_reason text;
  v_requested_price_ref jsonb;
  v_trusted_operation_at timestamptz;
  v_unit_ref jsonb;
  v_basis_quantity_text text;
  v_basis_quantity numeric(38,9);
  v_current_count integer;
  v_current_amount numeric(38,9);
  v_current_currency_code text;
  v_current_effective_from timestamptz;
  v_current_revision_id uuid;
  v_current_revision_number integer;
  v_current_price_id uuid;
  v_current_legal_entity_id uuid;
  v_current_acting_principal_id uuid;
  v_current_reason text;
  v_current_monetary_boundary text;
  v_current_catalog_selection jsonb;
  v_current_channel_id text;
  v_current_market_id text;
  v_current_identity_currency_code text;
  v_current_unit_ref jsonb;
  v_current_basis_quantity numeric(38,9);
  v_current_group_selector jsonb;
  v_definition jsonb;
  v_lock_a bigint;
  v_lock_b bigint;
  v_lock_c bigint;
  v_receipt_checked_after_lock boolean := false;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Pricing Price write scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_input IS NULL OR jsonb_typeof(p_input) <> 'object' THEN
    RAISE EXCEPTION 'Pricing Price write input is invalid' USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_action_invocation_id := (p_input ->> 'actionInvocationId')::uuid;
    v_acting_principal_id := (p_input ->> 'actingPrincipalId')::uuid;
    v_requested_price_id := (p_input #>> '{priceRef,resourceId}')::uuid;
    v_price_id := v_requested_price_id;
    v_effective_from := (p_input ->> 'effectiveFrom')::timestamptz;
    v_trusted_operation_at := (p_input ->> 'trustedOperationAt')::timestamptz;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'Pricing Price write input is invalid' USING ERRCODE = '22023';
  END;

  v_amount_text := p_input #>> '{monetaryAmount,amount}';
  v_basis_quantity_text := p_input #>> '{identityKey,unitBasis,quantity}';
  IF v_amount_text IS NULL OR v_amount_text !~ '^(0|[1-9][0-9]{0,28})(\.[0-9]{1,9})?$'
    OR v_basis_quantity_text IS NULL
    OR v_basis_quantity_text !~ '^(0|[1-9][0-9]{0,28})(\.[0-9]{1,9})?$'
  THEN
    RAISE EXCEPTION 'Pricing Price decimal input is not exactly representable as numeric(38,9)'
      USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_amount := v_amount_text::numeric(38,9);
    v_basis_quantity := v_basis_quantity_text::numeric(38,9);
  EXCEPTION WHEN numeric_value_out_of_range THEN
    RAISE EXCEPTION 'Pricing Price decimal input is not exactly representable as numeric(38,9)'
      USING ERRCODE = '22023';
  END;

  v_requested_price_ref := p_input -> 'priceRef';
  v_catalog_selection := p_input #> '{identityKey,catalogSelection}';
  v_channel_id := p_input #>> '{identityKey,commercialScope,channelId}';
  v_market_id := p_input #>> '{identityKey,commercialScope,marketId}';
  v_currency_code := p_input #>> '{identityKey,currencyCode}';
  v_unit_ref := p_input #> '{identityKey,unitBasis,unitRef}';
  v_group_selector := p_input #> '{identityKey,priceGroupSelector}';
  v_reason := p_input ->> 'reason';

  IF v_action_invocation_id IS NULL OR v_acting_principal_id IS NULL OR v_price_id IS NULL
    OR v_effective_from IS NULL OR v_trusted_operation_at IS NULL OR v_amount IS NULL
    OR v_catalog_selection IS NULL OR jsonb_typeof(v_catalog_selection) <> 'object'
    OR jsonb_typeof(v_catalog_selection -> 'productRef') <> 'object'
    OR jsonb_typeof(v_catalog_selection -> 'variantRef') <> 'object'
    OR v_channel_id IS NULL OR v_channel_id <> btrim(v_channel_id) OR v_channel_id = '*'
    OR v_market_id IS NULL OR v_market_id <> btrim(v_market_id) OR v_market_id = '*'
    OR v_currency_code !~ '^[A-Z]{3}$' OR v_currency_code IS DISTINCT FROM p_input #>> '{monetaryAmount,currencyCode}'
    OR v_unit_ref IS NULL OR v_unit_ref ->> 'resourceType' <> 'commerce.catalog.product-unit'
    OR v_basis_quantity <= 0 OR v_group_selector IS NULL OR jsonb_typeof(v_group_selector) <> 'object'
    OR v_reason IS NULL OR v_reason <> btrim(v_reason) OR length(v_reason) NOT BETWEEN 1 AND 1000
    OR v_requested_price_ref ->> 'moduleId' <> 'commerce.pricing'
    OR v_requested_price_ref ->> 'resourceType' <> 'commerce.pricing.price'
    OR v_requested_price_ref ->> 'tenantId' <> p_tenant_id::text
    OR v_catalog_selection #>> '{productRef,tenantId}' <> p_tenant_id::text
    OR v_catalog_selection #>> '{variantRef,tenantId}' <> p_tenant_id::text
    OR v_unit_ref ->> 'tenantId' <> p_tenant_id::text
    OR p_input #>> '{identityKey,commercialScope,sellingLegalEntityId}' <> p_legal_entity_id::text
    OR NOT (
      (v_group_selector ->> 'kind' = 'NO_GROUP' AND NOT (v_group_selector ? 'priceGroupRef'))
      OR (
        v_group_selector ->> 'kind' = 'PRICE_GROUP'
        AND v_group_selector #>> '{priceGroupRef,tenantId}' = p_tenant_id::text
        AND v_group_selector #>> '{priceGroupRef,resourceType}' = 'pricing.price-group-catalog.price-group'
      )
    )
    OR v_amount < 0
  THEN
    RAISE EXCEPTION 'Pricing Price write input is invalid' USING ERRCODE = '22023';
  END IF;

  IF v_effective_from > v_trusted_operation_at THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'EFFECTIVE_TIME_INVALID');
    RETURN;
  END IF;

  v_lock_c := hashtextextended(p_tenant_id::text || ':invocation:' || v_action_invocation_id::text, 0);
  LOOP
    SELECT receipt.requested_price_id, receipt.resolved_price_id, receipt.resolved_price_revision_id,
           revision.revision_number, receipt.amount, receipt.currency_code, receipt.effective_from,
           receipt.acting_principal_id, receipt.reason, receipt.monetary_boundary,
           receipt.legal_entity_id, receipt.catalog_selection, receipt.channel_id, receipt.market_id,
           receipt.currency_code, receipt.unit_ref, receipt.basis_quantity, receipt.price_group_selector
      INTO v_existing_price_id, v_current_price_id, v_current_revision_id,
           v_current_revision_number, v_current_amount, v_current_currency_code, v_current_effective_from,
           v_current_acting_principal_id, v_current_reason, v_current_monetary_boundary,
           v_current_legal_entity_id, v_current_catalog_selection, v_current_channel_id, v_current_market_id,
           v_current_identity_currency_code, v_current_unit_ref, v_current_basis_quantity, v_current_group_selector
      FROM pricing.price_invocation_receipts AS receipt
      JOIN pricing.price_revisions AS revision
        ON revision.tenant_id = receipt.tenant_id
       AND revision.legal_entity_id = receipt.legal_entity_id
       AND revision.price_id = receipt.resolved_price_id
       AND revision.price_revision_id = receipt.resolved_price_revision_id
     WHERE receipt.tenant_id = p_tenant_id
       AND receipt.action_invocation_id = v_action_invocation_id;
    IF FOUND THEN
      IF v_existing_price_id IS DISTINCT FROM v_requested_price_id
        OR v_current_amount IS DISTINCT FROM v_amount
        OR v_current_currency_code IS DISTINCT FROM v_currency_code
        OR v_current_effective_from IS DISTINCT FROM v_effective_from
        OR v_current_acting_principal_id IS DISTINCT FROM v_acting_principal_id
        OR v_current_reason IS DISTINCT FROM v_reason
        OR v_current_monetary_boundary IS DISTINCT FROM 'PRE_TAX'
        OR v_current_legal_entity_id IS DISTINCT FROM p_legal_entity_id
        OR v_current_catalog_selection IS DISTINCT FROM v_catalog_selection
        OR v_current_channel_id IS DISTINCT FROM v_channel_id
        OR v_current_market_id IS DISTINCT FROM v_market_id
        OR v_current_identity_currency_code IS DISTINCT FROM v_currency_code
        OR v_current_unit_ref IS DISTINCT FROM v_unit_ref
        OR v_current_basis_quantity IS DISTINCT FROM v_basis_quantity
        OR v_current_group_selector IS DISTINCT FROM v_group_selector
      THEN
        RETURN QUERY SELECT jsonb_build_object('outcome', 'CONFLICT', 'reason', 'IDEMPOTENCY_CONFLICT');
        RETURN;
      END IF;

      v_definition := jsonb_build_object(
        'identityKey', jsonb_build_object(
          'catalogSelection', v_current_catalog_selection,
          'commercialScope', jsonb_build_object(
            'channelId', v_current_channel_id,
            'marketId', v_current_market_id,
            'sellingLegalEntityId', v_current_legal_entity_id::text
          ),
          'currencyCode', v_current_identity_currency_code,
          'priceGroupSelector', v_current_group_selector,
          'unitBasis', jsonb_build_object('quantity', v_current_basis_quantity::text, 'unitRef', v_current_unit_ref)
        ),
        'priceRef', jsonb_build_object(
          'moduleId', 'commerce.pricing',
          'resourceId', v_current_price_id::text,
          'resourceType', 'commerce.pricing.price',
          'tenantId', p_tenant_id::text
        ),
        'revision', jsonb_build_object(
          'effectiveFrom', to_char(v_current_effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'monetaryAmount', jsonb_build_object('amount', v_current_amount::text, 'currencyCode', v_current_currency_code),
          'monetaryBoundary', v_current_monetary_boundary,
          'revision', v_current_revision_number,
          'revisionId', v_current_revision_id::text
        )
      );
      RETURN QUERY SELECT jsonb_build_object('definition', v_definition, 'outcome', 'REUSED');
      RETURN;
    END IF;

    EXIT WHEN v_receipt_checked_after_lock;
    PERFORM pg_advisory_xact_lock(v_lock_c);
    v_receipt_checked_after_lock := true;
  END LOOP;

  v_lock_a := hashtextextended(p_tenant_id::text || ':price:' || v_price_id::text, 0);
  v_lock_b := hashtextextended(
    p_tenant_id::text || ':identity:' || jsonb_build_array(
      v_catalog_selection, p_legal_entity_id, v_channel_id, v_market_id, v_currency_code,
      v_unit_ref, v_basis_quantity, v_group_selector
    )::text,
    0
  );
  PERFORM pg_advisory_xact_lock(lock_key)
  FROM unnest(ARRAY[v_lock_a, v_lock_b]) AS lock_key
  ORDER BY lock_key;

  SELECT price.price_id INTO v_existing_price_id
    FROM pricing.prices AS price
   WHERE price.tenant_id = p_tenant_id
     AND price.legal_entity_id = p_legal_entity_id
     AND price.price_id = v_price_id;
  IF FOUND AND NOT (
    SELECT price.catalog_selection = v_catalog_selection
       AND price.channel_id = v_channel_id
       AND price.market_id = v_market_id
       AND price.currency_code = v_currency_code
       AND price.unit_ref = v_unit_ref
       AND price.basis_quantity = v_basis_quantity
       AND price.price_group_selector = v_group_selector
    FROM pricing.prices AS price
    WHERE price.tenant_id = p_tenant_id AND price.legal_entity_id = p_legal_entity_id AND price.price_id = v_price_id
  ) THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'CONFLICT', 'reason', 'PRICE_RESOURCE_ALREADY_BOUND');
    RETURN;
  END IF;

  SELECT price.price_id INTO v_existing_price_id
    FROM pricing.prices AS price
   WHERE price.tenant_id = p_tenant_id
     AND price.legal_entity_id = p_legal_entity_id
     AND price.catalog_selection = v_catalog_selection
     AND price.channel_id = v_channel_id
     AND price.market_id = v_market_id
     AND price.currency_code = v_currency_code
     AND price.unit_ref = v_unit_ref
     AND price.basis_quantity = v_basis_quantity
     AND price.price_group_selector = v_group_selector;

  IF FOUND THEN
    SELECT count(*)::integer,
           min(revision.price_revision_id::text)::uuid, min(revision.revision_number),
           min(revision.amount), min(revision.currency_code), min(revision.effective_from)
      INTO v_current_count, v_current_revision_id, v_current_revision_number,
           v_current_amount, v_current_currency_code, v_current_effective_from
      FROM pricing.price_current_revisions AS current_revision
      JOIN pricing.price_revisions AS revision
        ON revision.tenant_id = current_revision.tenant_id
       AND revision.legal_entity_id = current_revision.legal_entity_id
       AND revision.price_id = current_revision.price_id
       AND revision.price_revision_id = current_revision.price_revision_id
     WHERE current_revision.tenant_id = p_tenant_id
       AND current_revision.legal_entity_id = p_legal_entity_id
       AND current_revision.price_id = v_existing_price_id;
    IF v_current_count <> 1 THEN
      RETURN QUERY SELECT jsonb_build_object('outcome', 'CONFLICT', 'reason', 'UNVERIFIABLE_CURRENTNESS');
      RETURN;
    END IF;
    IF v_current_amount <> v_amount OR v_current_currency_code <> v_currency_code
      OR v_current_effective_from <> v_effective_from
    THEN
      RETURN QUERY SELECT jsonb_build_object('outcome', 'CONFLICT', 'reason', 'EXACT_KEY_ALREADY_BOUND');
      RETURN;
    END IF;
    v_price_id := v_existing_price_id;
  ELSE
    v_price_revision_id := gen_random_uuid();
    INSERT INTO pricing.prices (
      price_id, tenant_id, legal_entity_id, catalog_selection, channel_id, market_id,
      currency_code, unit_ref, basis_quantity, price_group_selector,
      created_by_action_invocation_id, created_by_principal_id
    ) VALUES (
      v_price_id, p_tenant_id, p_legal_entity_id, v_catalog_selection, v_channel_id, v_market_id,
      v_currency_code, v_unit_ref, v_basis_quantity, v_group_selector,
      v_action_invocation_id, v_acting_principal_id
    );
    INSERT INTO pricing.price_revisions (
      price_revision_id, tenant_id, legal_entity_id, price_id, revision_number, amount,
      currency_code, monetary_boundary, effective_from, action_invocation_id,
      acting_principal_id, reason
    ) VALUES (
      v_price_revision_id, p_tenant_id, p_legal_entity_id, v_price_id, 1, v_amount,
      v_currency_code, 'PRE_TAX', v_effective_from, v_action_invocation_id,
      v_acting_principal_id, v_reason
    );
    INSERT INTO pricing.price_current_revisions (
      tenant_id, legal_entity_id, price_id, price_revision_id, revision_number,
      effective_from, bound_by_action_invocation_id
    ) VALUES (
      p_tenant_id, p_legal_entity_id, v_price_id, v_price_revision_id, 1,
      v_effective_from, v_action_invocation_id
    );
    v_current_revision_id := v_price_revision_id;
    v_current_revision_number := 1;
    v_current_amount := v_amount;
    v_current_currency_code := v_currency_code;
    v_current_effective_from := v_effective_from;
  END IF;

  INSERT INTO pricing.price_invocation_receipts (
    tenant_id, legal_entity_id, action_invocation_id,
    requested_price_id, resolved_price_id, resolved_price_revision_id,
    catalog_selection, channel_id, market_id, currency_code,
    unit_ref, basis_quantity, price_group_selector,
    amount, monetary_boundary, effective_from, acting_principal_id, reason
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_action_invocation_id,
    v_requested_price_id, v_price_id, v_current_revision_id,
    v_catalog_selection, v_channel_id, v_market_id, v_currency_code,
    v_unit_ref, v_basis_quantity, v_group_selector,
    v_amount, 'PRE_TAX', v_effective_from, v_acting_principal_id, v_reason
  );

  v_definition := jsonb_build_object(
    'identityKey', jsonb_build_object(
      'catalogSelection', v_catalog_selection,
      'commercialScope', jsonb_build_object(
        'channelId', v_channel_id,
        'marketId', v_market_id,
        'sellingLegalEntityId', p_legal_entity_id::text
      ),
      'currencyCode', v_currency_code,
      'priceGroupSelector', v_group_selector,
      'unitBasis', jsonb_build_object('quantity', v_basis_quantity::text, 'unitRef', v_unit_ref)
    ),
    'priceRef', jsonb_build_object(
      'moduleId', 'commerce.pricing',
      'resourceId', v_price_id::text,
      'resourceType', 'commerce.pricing.price',
      'tenantId', p_tenant_id::text
    ),
    'revision', jsonb_build_object(
      'effectiveFrom', to_char(v_current_effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'monetaryAmount', jsonb_build_object('amount', v_current_amount::text, 'currencyCode', v_current_currency_code),
      'monetaryBoundary', 'PRE_TAX',
      'revision', v_current_revision_number,
      'revisionId', v_current_revision_id::text
    )
  );
  RETURN QUERY SELECT jsonb_build_object(
    'definition', v_definition,
    'outcome', CASE WHEN v_existing_price_id IS NULL THEN 'CREATED' ELSE 'REUSED' END
  );
END;
$function$;

CREATE FUNCTION "pricing"."read_current_price_definition_v1"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_price_id uuid
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_candidate_revision_ids jsonb;
  v_count integer;
  v_definition jsonb;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Pricing Price read scope mismatch' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pricing.prices AS price
     WHERE price.tenant_id = p_tenant_id
       AND price.legal_entity_id = p_legal_entity_id
       AND price.price_id = p_price_id
  ) THEN
    RETURN QUERY SELECT jsonb_build_object(
      'outcome', 'PRICE_DEFINITION_NOT_FOUND',
      'priceRef', jsonb_build_object(
        'moduleId', 'commerce.pricing', 'resourceId', p_price_id::text,
        'resourceType', 'commerce.pricing.price', 'tenantId', p_tenant_id::text
      )
    );
    RETURN;
  END IF;

  SELECT count(*)::integer,
         coalesce(jsonb_agg(revision.price_revision_id::text ORDER BY revision.revision_number), '[]'::jsonb)
    INTO v_count, v_candidate_revision_ids
    FROM pricing.price_current_revisions AS current_revision
    JOIN pricing.price_revisions AS revision
      ON revision.tenant_id = current_revision.tenant_id
     AND revision.legal_entity_id = current_revision.legal_entity_id
     AND revision.price_id = current_revision.price_id
     AND revision.price_revision_id = current_revision.price_revision_id
   WHERE current_revision.tenant_id = p_tenant_id
     AND current_revision.legal_entity_id = p_legal_entity_id
     AND current_revision.price_id = p_price_id;

  IF v_count <> 1 THEN
    RETURN QUERY SELECT jsonb_build_object(
      'candidateRevisionIds', v_candidate_revision_ids,
      'outcome', 'PRICE_DEFINITION_CONFLICT',
      'priceRef', jsonb_build_object(
        'moduleId', 'commerce.pricing', 'resourceId', p_price_id::text,
        'resourceType', 'commerce.pricing.price', 'tenantId', p_tenant_id::text
      ),
      'reason', CASE WHEN v_count = 0 THEN 'ZERO_CURRENT_REVISION' ELSE 'MULTIPLE_CURRENT_REVISIONS' END
    );
    RETURN;
  END IF;

  SELECT jsonb_build_object(
    'identityKey', jsonb_build_object(
      'catalogSelection', price.catalog_selection,
      'commercialScope', jsonb_build_object(
        'channelId', price.channel_id,
        'marketId', price.market_id,
        'sellingLegalEntityId', price.legal_entity_id::text
      ),
      'currencyCode', price.currency_code,
      'priceGroupSelector', price.price_group_selector,
      'unitBasis', jsonb_build_object('quantity', price.basis_quantity::text, 'unitRef', price.unit_ref)
    ),
    'priceRef', jsonb_build_object(
      'moduleId', 'commerce.pricing', 'resourceId', price.price_id::text,
      'resourceType', 'commerce.pricing.price', 'tenantId', price.tenant_id::text
    ),
    'revision', jsonb_build_object(
      'effectiveFrom', to_char(revision.effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'monetaryAmount', jsonb_build_object('amount', revision.amount::text, 'currencyCode', revision.currency_code),
      'monetaryBoundary', revision.monetary_boundary,
      'revision', revision.revision_number,
      'revisionId', revision.price_revision_id::text
    )
  ) INTO v_definition
  FROM pricing.prices AS price
  JOIN pricing.price_current_revisions AS current_revision
    ON current_revision.tenant_id = price.tenant_id
   AND current_revision.legal_entity_id = price.legal_entity_id
   AND current_revision.price_id = price.price_id
  JOIN pricing.price_revisions AS revision
    ON revision.tenant_id = current_revision.tenant_id
   AND revision.legal_entity_id = current_revision.legal_entity_id
   AND revision.price_id = current_revision.price_id
   AND revision.price_revision_id = current_revision.price_revision_id
  WHERE price.tenant_id = p_tenant_id
    AND price.legal_entity_id = p_legal_entity_id
    AND price.price_id = p_price_id;

  RETURN QUERY SELECT jsonb_build_object(
    'currentEvidence', jsonb_build_object(
      'observedAt', to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'priceRef', v_definition -> 'priceRef',
      'revision', v_definition #> '{revision,revision}',
      'revisionId', v_definition #> '{revision,revisionId}'
    ),
    'definition', v_definition,
    'outcome', 'PRICE_DEFINITION_CURRENT'
  );
END;
$function$;

REVOKE ALL ON FUNCTION "pricing"."define_price_v1"(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION "pricing"."read_current_price_definition_v1"(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "pricing"."define_price_v1"(uuid, uuid, jsonb) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "pricing"."read_current_price_definition_v1"(uuid, uuid, uuid) TO "ontos_runtime";
