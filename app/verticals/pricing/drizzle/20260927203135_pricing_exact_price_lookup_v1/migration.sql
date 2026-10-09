-- #763 exact owner-local Current Price lookup. One statement evaluates the complete exact-key
-- read set, Tenant Currency Support, schedule Currentness, and source usability. It deliberately
-- aggregates all candidates; no ordering or LIMIT can hide competing canonical truths.
CREATE FUNCTION pricing.lookup_exact_current_price_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_input jsonb
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_observed_at timestamptz := pg_catalog.statement_timestamp();
  v_effective_at timestamptz;
  v_key jsonb;
  v_request jsonb;
  v_currency_code text;
  v_basis_quantity numeric(38, 9);
  v_support_root_count integer;
  v_support_id uuid;
  v_support_head_id uuid;
  v_support_schedule_revision integer;
  v_support_current_count integer;
  v_support_entry_count integer;
  v_support_revision_id uuid;
  v_supported_currencies jsonb;
  v_matching_root_count integer;
  v_matching_head_count integer;
  v_incomplete_schedule_count integer;
  v_exact_schedule_state jsonb;
  v_current_truth_count integer;
  v_current_price_count integer;
  v_invalid_truth_count integer;
  v_current_price_refs jsonb;
  v_current_state jsonb;
  v_price_id uuid;
  v_price_revision_id uuid;
  v_revision_number integer;
  v_amount numeric(38, 9);
  v_revision_currency text;
  v_monetary_boundary text;
  v_revision_effective_from timestamptz;
  v_next_boundary timestamptz;
  v_owner_revision text;
  v_evidence jsonb;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Pricing exact Price lookup scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
    OR jsonb_typeof(p_input -> 'exactKey') <> 'object'
  THEN
    RAISE EXCEPTION 'Pricing exact Price lookup input is invalid' USING ERRCODE = '22023';
  END IF;

  v_key := p_input -> 'exactKey';
  BEGIN
    v_effective_at := (p_input ->> 'effectiveAt')::timestamptz;
    v_basis_quantity := (v_key #>> '{unitBasis,quantity}')::numeric(38, 9);
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'Pricing exact Price lookup input is invalid' USING ERRCODE = '22023';
  END;
  v_currency_code := v_key ->> 'currencyCode';
  v_request := pg_catalog.jsonb_build_object(
    'effectiveAt', pg_catalog.to_char(
      v_effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'exactKey', v_key
  );

  IF v_effective_at IS NULL OR v_key #>> '{catalogSelection,productRef,tenantId}' IS DISTINCT FROM p_tenant_id::text
    OR v_key #>> '{catalogSelection,variantRef,tenantId}' IS DISTINCT FROM p_tenant_id::text
    OR v_key #>> '{commercialScope,sellingLegalEntityId}' IS DISTINCT FROM p_legal_entity_id::text
    OR v_key #>> '{unitBasis,unitRef,tenantId}' IS DISTINCT FROM p_tenant_id::text
    OR (
      v_key #>> '{priceGroupSelector,kind}' = 'PRICE_GROUP'
      AND v_key #>> '{priceGroupSelector,priceGroupRef,tenantId}' IS DISTINCT FROM p_tenant_id::text
    )
  THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      '_tag', 'INVALID', 'reason', 'PRICE_KEY_MISMATCH', 'request', v_request
    );
    RETURN;
  END IF;
  IF v_key #>> '{unitBasis,unitRef,resourceType}' IS DISTINCT FROM 'commerce.catalog.product-unit'
    OR v_basis_quantity IS NULL OR v_basis_quantity <= 0
  THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      '_tag', 'INVALID', 'reason', 'UNSUPPORTED_UNIT_BASIS', 'request', v_request
    );
    RETURN;
  END IF;
  IF v_effective_at > v_observed_at THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      '_tag', 'UNVERIFIABLE', 'reason', 'CURRENTNESS_UNVERIFIABLE', 'request', v_request
    );
    RETURN;
  END IF;

  -- Currency Support is part of the exact proof. Missing or gapped Current support is known
  -- unsupported configuration; conflicting/incomplete owner state remains unverifiable.
  SELECT count(*)::integer, min(root.currency_support_id::text)::uuid
    INTO v_support_root_count, v_support_id
    FROM pricing.currency_support_roots AS root
   WHERE root.tenant_id = p_tenant_id;
  IF v_support_root_count = 0 THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      '_tag', 'INVALID', 'reason', 'UNSUPPORTED_CURRENCY', 'request', v_request
    );
    RETURN;
  END IF;
  IF v_support_root_count <> 1 THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      '_tag', 'UNVERIFIABLE', 'reason', 'SET_COMPLETENESS_UNVERIFIABLE', 'request', v_request
    );
    RETURN;
  END IF;

  SELECT head.currency_support_schedule_revision_id, head.schedule_revision
    INTO v_support_head_id, v_support_schedule_revision
    FROM pricing.currency_support_schedule_heads AS head
   WHERE head.tenant_id = p_tenant_id
     AND head.currency_support_id = v_support_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      '_tag', 'UNVERIFIABLE', 'reason', 'CURRENTNESS_UNVERIFIABLE', 'request', v_request
    );
    RETURN;
  END IF;

  SELECT count(*)::integer,
         min(entry.currency_support_revision_id::text)::uuid,
         min(revision.supported_currencies::text)::jsonb
    INTO v_support_current_count, v_support_revision_id, v_supported_currencies
    FROM pricing.currency_support_schedule_entries AS entry
    JOIN pricing.currency_support_value_revisions AS revision
      ON revision.tenant_id = entry.tenant_id
     AND revision.currency_support_id = entry.currency_support_id
     AND revision.currency_support_revision_id = entry.currency_support_revision_id
   WHERE entry.tenant_id = p_tenant_id
     AND entry.currency_support_id = v_support_id
     AND entry.currency_support_schedule_revision_id = v_support_head_id
     AND entry.effective_from <= v_effective_at
     AND (entry.effective_to IS NULL OR v_effective_at < entry.effective_to);
  IF v_support_current_count = 0 THEN
    SELECT count(*)::integer
      INTO v_support_entry_count
      FROM pricing.currency_support_schedule_entries AS entry
     WHERE entry.tenant_id = p_tenant_id
       AND entry.currency_support_id = v_support_id
       AND entry.currency_support_schedule_revision_id = v_support_head_id;
    IF v_support_entry_count = 0 THEN
      RETURN QUERY SELECT pg_catalog.jsonb_build_object(
        '_tag', 'UNVERIFIABLE', 'reason', 'SET_COMPLETENESS_UNVERIFIABLE', 'request', v_request
      );
      RETURN;
    END IF;
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      '_tag', 'INVALID', 'reason', 'UNSUPPORTED_CURRENCY', 'request', v_request
    );
    RETURN;
  END IF;
  IF v_support_current_count <> 1 OR v_supported_currencies IS NULL THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      '_tag', 'UNVERIFIABLE', 'reason', 'CURRENTNESS_UNVERIFIABLE', 'request', v_request
    );
    RETURN;
  END IF;
  IF v_currency_code IS NULL OR NOT (v_supported_currencies ? v_currency_code) THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      '_tag', 'INVALID', 'reason', 'UNSUPPORTED_CURRENCY', 'request', v_request
    );
    RETURN;
  END IF;

  WITH exact_prices AS (
    SELECT price.price_id
      FROM pricing.prices AS price
     WHERE price.tenant_id = p_tenant_id
       AND price.legal_entity_id = p_legal_entity_id
       AND price.catalog_selection = v_key -> 'catalogSelection'
       AND price.channel_id = v_key #>> '{commercialScope,channelId}'
       AND price.market_id = v_key #>> '{commercialScope,marketId}'
       AND price.currency_code = v_currency_code
       AND price.unit_ref = v_key #> '{unitBasis,unitRef}'
       AND price.basis_quantity = v_basis_quantity
       AND price.price_group_selector = v_key -> 'priceGroupSelector'
  )
  SELECT count(*)::integer,
         count(head.price_id)::integer,
         count(*) FILTER (
           WHERE head.price_id IS NOT NULL AND NOT EXISTS (
             SELECT 1
               FROM pricing.price_schedule_entries AS entry
              WHERE entry.tenant_id = p_tenant_id
                AND entry.legal_entity_id = p_legal_entity_id
                AND entry.price_id = price.price_id
                AND entry.price_schedule_revision_id = head.price_schedule_revision_id
           )
         )::integer,
         coalesce(pg_catalog.jsonb_agg(
           pg_catalog.jsonb_build_object(
             'priceId', price.price_id,
             'priceScheduleRevisionId', head.price_schedule_revision_id,
             'scheduleRevision', head.schedule_revision,
             'entries', coalesce((
               SELECT pg_catalog.jsonb_agg(
                 pg_catalog.jsonb_build_object(
                   'priceRevisionId', entry.price_revision_id,
                   'effectiveFrom', entry.effective_from,
                   'effectiveTo', entry.effective_to
                 ) ORDER BY entry.effective_from, entry.price_revision_id
               )
                 FROM pricing.price_schedule_entries AS entry
                WHERE entry.tenant_id = p_tenant_id
                  AND entry.legal_entity_id = p_legal_entity_id
                  AND entry.price_id = price.price_id
                  AND entry.price_schedule_revision_id = head.price_schedule_revision_id
             ), '[]'::jsonb)
           ) ORDER BY price.price_id
         ), '[]'::jsonb)
    INTO v_matching_root_count, v_matching_head_count, v_incomplete_schedule_count,
         v_exact_schedule_state
    FROM exact_prices AS price
    LEFT JOIN pricing.price_schedule_heads AS head
      ON head.tenant_id = p_tenant_id
     AND head.legal_entity_id = p_legal_entity_id
     AND head.price_id = price.price_id;
  IF v_matching_head_count <> v_matching_root_count OR v_incomplete_schedule_count <> 0 THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      '_tag', 'UNVERIFIABLE', 'reason', 'SET_COMPLETENESS_UNVERIFIABLE', 'request', v_request
    );
    RETURN;
  END IF;

  WITH current_truths AS (
    SELECT price.price_id,
           head.price_schedule_revision_id,
           head.schedule_revision,
           entry.price_revision_id,
           entry.effective_from,
           entry.effective_to,
           revision.revision_number,
           revision.amount,
           revision.currency_code,
           revision.monetary_boundary,
           (SELECT count(*)::integer
              FROM pricing.price_source_assertions AS assertion
             WHERE assertion.tenant_id = p_tenant_id
               AND assertion.legal_entity_id = p_legal_entity_id
               AND assertion.price_id = price.price_id
               AND assertion.price_revision_id = entry.price_revision_id) AS source_count,
           (SELECT count(*)::integer
               FROM pricing.price_source_assertions AS assertion
              WHERE assertion.tenant_id = p_tenant_id
                AND assertion.legal_entity_id = p_legal_entity_id
                AND assertion.price_id = price.price_id
                AND assertion.price_revision_id = entry.price_revision_id
                AND assertion.source_authority_ref <> 'legacy:unverified:not-asserted'
                AND assertion.source_effective_at <= v_effective_at
                AND assertion.owner_business_effective_at <= v_effective_at) AS usable_source_count
      FROM pricing.prices AS price
      JOIN pricing.price_schedule_heads AS head
        ON head.tenant_id = price.tenant_id
       AND head.legal_entity_id = price.legal_entity_id
       AND head.price_id = price.price_id
      JOIN pricing.price_schedule_entries AS entry
        ON entry.tenant_id = head.tenant_id
       AND entry.legal_entity_id = head.legal_entity_id
       AND entry.price_id = head.price_id
       AND entry.price_schedule_revision_id = head.price_schedule_revision_id
      JOIN pricing.price_revisions AS revision
        ON revision.tenant_id = entry.tenant_id
       AND revision.legal_entity_id = entry.legal_entity_id
       AND revision.price_id = entry.price_id
       AND revision.price_revision_id = entry.price_revision_id
     WHERE price.tenant_id = p_tenant_id
       AND price.legal_entity_id = p_legal_entity_id
       AND price.catalog_selection = v_key -> 'catalogSelection'
       AND price.channel_id = v_key #>> '{commercialScope,channelId}'
       AND price.market_id = v_key #>> '{commercialScope,marketId}'
       AND price.currency_code = v_currency_code
       AND price.unit_ref = v_key #> '{unitBasis,unitRef}'
       AND price.basis_quantity = v_basis_quantity
       AND price.price_group_selector = v_key -> 'priceGroupSelector'
       AND entry.effective_from <= v_effective_at
       AND (entry.effective_to IS NULL OR v_effective_at < entry.effective_to)
  )
  SELECT count(*)::integer,
         count(DISTINCT truth.price_id)::integer,
         count(*) FILTER (
           WHERE truth.source_count <> 1
              OR truth.usable_source_count <> 1
              OR truth.currency_code IS DISTINCT FROM v_currency_code
              OR truth.monetary_boundary IS DISTINCT FROM 'PRE_TAX'
              OR truth.amount < 0
         )::integer,
         coalesce(pg_catalog.jsonb_agg(
           pg_catalog.jsonb_build_object(
             'moduleId', 'commerce.pricing',
             'resourceId', truth.price_id::text,
             'resourceType', 'commerce.pricing.price',
             'tenantId', p_tenant_id::text
           ) ORDER BY truth.price_id
         ), '[]'::jsonb),
         coalesce(pg_catalog.jsonb_agg(
           pg_catalog.jsonb_build_object(
             'priceId', truth.price_id,
             'priceRevisionId', truth.price_revision_id,
             'priceScheduleRevisionId', truth.price_schedule_revision_id,
             'scheduleRevision', truth.schedule_revision,
             'effectiveFrom', truth.effective_from,
             'effectiveTo', truth.effective_to,
             'sourceCount', truth.source_count,
             'usableSourceCount', truth.usable_source_count
           ) ORDER BY truth.price_id, truth.price_revision_id
         ), '[]'::jsonb),
         min(truth.price_id::text)::uuid,
         min(truth.price_revision_id::text)::uuid,
         min(truth.revision_number),
         min(truth.amount),
         min(truth.currency_code),
         min(truth.monetary_boundary),
         min(truth.effective_from)
    INTO v_current_truth_count, v_current_price_count, v_invalid_truth_count,
         v_current_price_refs, v_current_state, v_price_id, v_price_revision_id,
         v_revision_number, v_amount, v_revision_currency, v_monetary_boundary,
         v_revision_effective_from
    FROM current_truths AS truth;

  IF v_invalid_truth_count <> 0 OR v_current_truth_count <> v_current_price_count THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      '_tag', 'INVALID', 'reason', 'INVALID_CANONICAL_PRICE', 'request', v_request
    );
    RETURN;
  END IF;

  SELECT min(boundary)
    INTO v_next_boundary
    FROM (
      SELECT entry.effective_from AS boundary
        FROM pricing.prices AS price
        JOIN pricing.price_schedule_heads AS head
          ON head.tenant_id = price.tenant_id
         AND head.legal_entity_id = price.legal_entity_id
         AND head.price_id = price.price_id
        JOIN pricing.price_schedule_entries AS entry
          ON entry.tenant_id = head.tenant_id
         AND entry.legal_entity_id = head.legal_entity_id
         AND entry.price_id = head.price_id
         AND entry.price_schedule_revision_id = head.price_schedule_revision_id
       WHERE price.tenant_id = p_tenant_id
         AND price.legal_entity_id = p_legal_entity_id
         AND price.catalog_selection = v_key -> 'catalogSelection'
         AND price.channel_id = v_key #>> '{commercialScope,channelId}'
         AND price.market_id = v_key #>> '{commercialScope,marketId}'
         AND price.currency_code = v_currency_code
         AND price.unit_ref = v_key #> '{unitBasis,unitRef}'
         AND price.basis_quantity = v_basis_quantity
         AND price.price_group_selector = v_key -> 'priceGroupSelector'
         AND entry.effective_from > v_observed_at
      UNION ALL
      SELECT entry.effective_to
        FROM pricing.prices AS price
        JOIN pricing.price_schedule_heads AS head
          ON head.tenant_id = price.tenant_id
         AND head.legal_entity_id = price.legal_entity_id
         AND head.price_id = price.price_id
        JOIN pricing.price_schedule_entries AS entry
          ON entry.tenant_id = head.tenant_id
         AND entry.legal_entity_id = head.legal_entity_id
         AND entry.price_id = head.price_id
         AND entry.price_schedule_revision_id = head.price_schedule_revision_id
       WHERE price.tenant_id = p_tenant_id
         AND price.legal_entity_id = p_legal_entity_id
         AND price.catalog_selection = v_key -> 'catalogSelection'
         AND price.channel_id = v_key #>> '{commercialScope,channelId}'
         AND price.market_id = v_key #>> '{commercialScope,marketId}'
         AND price.currency_code = v_currency_code
         AND price.unit_ref = v_key #> '{unitBasis,unitRef}'
         AND price.basis_quantity = v_basis_quantity
         AND price.price_group_selector = v_key -> 'priceGroupSelector'
         AND entry.effective_to > v_observed_at
      UNION ALL
      SELECT entry.effective_from
        FROM pricing.currency_support_schedule_entries AS entry
       WHERE entry.tenant_id = p_tenant_id
         AND entry.currency_support_id = v_support_id
         AND entry.currency_support_schedule_revision_id = v_support_head_id
         AND entry.effective_from > v_observed_at
      UNION ALL
      SELECT entry.effective_to
        FROM pricing.currency_support_schedule_entries AS entry
       WHERE entry.tenant_id = p_tenant_id
         AND entry.currency_support_id = v_support_id
         AND entry.currency_support_schedule_revision_id = v_support_head_id
         AND entry.effective_to > v_observed_at
    ) AS boundaries;

  v_owner_revision := 'pricing-exact-current-v1:' || pg_catalog.encode(
    public.digest(
      pg_catalog.convert_to(pg_catalog.jsonb_build_object(
        'effectiveAt', v_effective_at,
        'exactKey', v_key,
        'matchingRootCount', v_matching_root_count,
        'exactSchedules', v_exact_schedule_state,
        'currentTruths', v_current_state,
        'supportId', v_support_id,
        'supportRevisionId', v_support_revision_id,
        'supportScheduleRevision', v_support_schedule_revision,
        'supportedCurrencies', v_supported_currencies
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
  v_evidence := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'effectiveAt', v_request ->> 'effectiveAt',
    'nextApplicabilityBoundary', CASE WHEN v_next_boundary IS NULL THEN NULL ELSE pg_catalog.to_char(
      v_next_boundary AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ) END,
    'observedAt', pg_catalog.to_char(
      v_observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'ownerRevision', v_owner_revision
  ));

  IF v_current_price_count = 0 THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      '_tag', 'ABSENT', 'evidence', v_evidence, 'request', v_request
    );
    RETURN;
  END IF;
  IF v_current_price_count > 1 THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      '_tag', 'CONFLICT',
      'currentPriceRefs', v_current_price_refs,
      'evidence', v_evidence,
      'request', v_request
    );
    RETURN;
  END IF;

  RETURN QUERY SELECT pg_catalog.jsonb_build_object(
    '_tag', 'FOUND',
    'evidence', v_evidence,
    'priceRef', pg_catalog.jsonb_build_object(
      'moduleId', 'commerce.pricing',
      'resourceId', v_price_id::text,
      'resourceType', 'commerce.pricing.price',
      'tenantId', p_tenant_id::text
    ),
    'priceRevision', pg_catalog.jsonb_build_object(
      'effectiveFrom', pg_catalog.to_char(
        v_revision_effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'monetaryAmount', pg_catalog.jsonb_build_object(
        'amount', v_amount::text,
        'currencyCode', v_revision_currency
      ),
      'monetaryBoundary', v_monetary_boundary,
      'revision', v_revision_number,
      'revisionId', v_price_revision_id::text
    ),
    'request', v_request
  );
END;
$function$;

REVOKE ALL ON FUNCTION pricing.lookup_exact_current_price_v1(uuid, uuid, jsonb)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pricing.lookup_exact_current_price_v1(uuid, uuid, jsonb)
  TO ontos_runtime;
