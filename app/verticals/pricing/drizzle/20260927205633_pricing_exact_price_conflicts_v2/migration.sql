-- Custom SQL migration file, put your code below! --
-- #764 owner-authorized exact Price conflict diagnostics. The v1 lookup remains the complete
-- exact-key/currentness proof for non-conflicting state. This wrapper only upgrades a proven set
-- of two or more distinct Current Price Revisions to an explicit diagnostic; it never chooses a
-- winner by value, timestamp, identifier, schedule revision, or delivery order.
CREATE FUNCTION pricing.lookup_exact_current_price_v2(
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
  v_v1_result jsonb;
  v_request jsonb;
  v_effective_at timestamptz;
  v_observed_at timestamptz := pg_catalog.statement_timestamp();
  v_database_claimants jsonb := '[]'::jsonb;
  v_claimants jsonb := '[]'::jsonb;
  v_distinct_claimants jsonb := '[]'::jsonb;
  v_claimant jsonb;
  v_database_raw_count integer := 0;
  v_database_valid_count integer := 0;
  v_claimant_count integer := 0;
  v_distinct_claimant_count integer := 0;
  v_invalid_claimant_count integer := 0;
  v_provenance_count integer;
  v_distinct_provenance_count integer;
  v_evidence jsonb;
BEGIN
  SELECT result.payload
    INTO v_v1_result
    FROM pricing.lookup_exact_current_price_v1(p_tenant_id, p_legal_entity_id, p_input) AS result;

  IF v_v1_result IS NULL THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      '_tag', 'UNVERIFIABLE',
      'reason', 'SET_COMPLETENESS_UNVERIFIABLE',
      'request', p_input
    );
    RETURN;
  END IF;

  v_request := v_v1_result -> 'request';
  BEGIN
    v_effective_at := (v_request ->> 'effectiveAt')::timestamptz;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    RETURN QUERY SELECT v_v1_result;
    RETURN;
  END;

  -- Read every Current claimant for the complete exact key. Grouping preserves multiple opaque
  -- provenance links for one canonical Revision without multiplying that claimant.
  WITH current_claimants AS (
    SELECT price.price_id,
           price.catalog_selection,
           price.channel_id,
           price.market_id,
           price.currency_code AS identity_currency,
           price.unit_ref,
           price.basis_quantity,
           price.price_group_selector,
           head.price_schedule_revision_id,
           head.schedule_revision,
           entry.price_revision_id,
           entry.effective_from,
           entry.effective_to,
           revision.revision_number,
           revision.amount,
           revision.currency_code,
           revision.monetary_boundary,
           count(assertion.source_assertion_id)::integer AS provenance_count,
           count(assertion.source_assertion_id) FILTER (
             WHERE assertion.source_authority_ref <> 'legacy:unverified:not-asserted'
               AND assertion.source_effective_at <= v_effective_at
               AND assertion.owner_business_effective_at <= v_effective_at
           )::integer AS usable_provenance_count,
           coalesce(
             pg_catalog.jsonb_agg(
               assertion.source_assertion_id::text ORDER BY assertion.source_assertion_id
             ) FILTER (WHERE assertion.source_assertion_id IS NOT NULL),
             '[]'::jsonb
           ) AS provenance_refs
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
      LEFT JOIN pricing.price_source_assertions AS assertion
        ON assertion.tenant_id = revision.tenant_id
       AND assertion.legal_entity_id = revision.legal_entity_id
       AND assertion.price_id = revision.price_id
       AND assertion.price_revision_id = revision.price_revision_id
     WHERE price.tenant_id = p_tenant_id
       AND price.legal_entity_id = p_legal_entity_id
       AND price.catalog_selection = v_request #> '{exactKey,catalogSelection}'
       AND price.channel_id = v_request #>> '{exactKey,commercialScope,channelId}'
       AND price.market_id = v_request #>> '{exactKey,commercialScope,marketId}'
       AND price.currency_code = v_request #>> '{exactKey,currencyCode}'
       AND price.unit_ref = v_request #> '{exactKey,unitBasis,unitRef}'
       AND price.basis_quantity = (v_request #>> '{exactKey,unitBasis,quantity}')::numeric(38, 9)
       AND price.price_group_selector = v_request #> '{exactKey,priceGroupSelector}'
       AND entry.effective_from <= v_effective_at
       AND (entry.effective_to IS NULL OR v_effective_at < entry.effective_to)
     GROUP BY price.price_id, price.catalog_selection, price.channel_id, price.market_id,
              price.currency_code, price.unit_ref, price.basis_quantity,
              price.price_group_selector, head.price_schedule_revision_id,
              head.schedule_revision, entry.price_revision_id, entry.effective_from,
              entry.effective_to, revision.revision_number, revision.amount,
              revision.currency_code, revision.monetary_boundary
  )
  SELECT count(*)::integer,
         count(*) FILTER (
           WHERE claimant.provenance_count > 0
             AND claimant.provenance_count = claimant.usable_provenance_count
             AND claimant.currency_code = claimant.identity_currency
             AND claimant.monetary_boundary = 'PRE_TAX'
             AND claimant.amount >= 0
         )::integer,
         coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'effectivePeriod', pg_catalog.jsonb_build_object(
                 'effectiveFrom', pg_catalog.to_char(
                   claimant.effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                 ),
                 'effectiveTo', CASE WHEN claimant.effective_to IS NULL THEN NULL ELSE pg_catalog.to_char(
                   claimant.effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                 ) END
               ),
               'exactKey', v_request -> 'exactKey',
               'priceRef', pg_catalog.jsonb_build_object(
                 'moduleId', 'commerce.pricing',
                 'resourceId', claimant.price_id::text,
                 'resourceType', 'commerce.pricing.price',
                 'tenantId', p_tenant_id::text
               ),
               'priceRevision', pg_catalog.jsonb_build_object(
                 'effectiveFrom', pg_catalog.to_char(
                   claimant.effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                 ),
                 'monetaryAmount', pg_catalog.jsonb_build_object(
                   'amount', claimant.amount::text,
                   'currencyCode', claimant.currency_code
                 ),
                 'monetaryBoundary', claimant.monetary_boundary,
                 'revision', claimant.revision_number,
                 'revisionId', claimant.price_revision_id::text
               ),
               'priceScheduleRevisionId', claimant.price_schedule_revision_id::text,
               'provenanceRefs', claimant.provenance_refs,
               'scheduleRevision', claimant.schedule_revision
             ) ORDER BY claimant.price_id, claimant.price_revision_id
           ) FILTER (
             WHERE claimant.provenance_count > 0
               AND claimant.provenance_count = claimant.usable_provenance_count
               AND claimant.currency_code = claimant.identity_currency
               AND claimant.monetary_boundary = 'PRE_TAX'
               AND claimant.amount >= 0
           ),
           '[]'::jsonb
         )
    INTO v_database_raw_count, v_database_valid_count, v_database_claimants
    FROM current_claimants AS claimant;

  v_claimants := coalesce(v_database_claimants, '[]'::jsonb);

  -- A repeated row for the same Price Revision is delivery replay, not another claimant.
  SELECT coalesce(pg_catalog.jsonb_agg(candidate.claimant ORDER BY candidate.identity), '[]'::jsonb),
         count(*)::integer
    INTO v_distinct_claimants, v_distinct_claimant_count
    FROM (
      SELECT DISTINCT ON (
               item.claimant #>> '{priceRef,resourceId}',
               item.claimant #>> '{priceRevision,revisionId}'
             )
             item.claimant,
             concat(
               item.claimant #>> '{priceRef,resourceId}', ':',
               item.claimant #>> '{priceRevision,revisionId}'
             ) AS identity
        FROM pg_catalog.jsonb_array_elements(v_claimants) AS item(claimant)
       ORDER BY item.claimant #>> '{priceRef,resourceId}',
                item.claimant #>> '{priceRevision,revisionId}',
                item.claimant::text
    ) AS candidate;

  v_claimant_count := pg_catalog.jsonb_array_length(v_claimants);
  IF v_distinct_claimant_count < 2 THEN
    RETURN QUERY SELECT v_v1_result;
    RETURN;
  END IF;

  -- Only a complete, exact-key-bound, currently effective, provenance-backed set is a known
  -- collision. Anything else is indeterminate owner state, never a fabricated winner/conflict.
  FOR v_claimant IN SELECT value FROM pg_catalog.jsonb_array_elements(v_distinct_claimants)
  LOOP
    BEGIN
      IF v_claimant -> 'exactKey' IS DISTINCT FROM v_request -> 'exactKey'
        OR v_claimant #>> '{priceRef,tenantId}' IS DISTINCT FROM p_tenant_id::text
        OR v_claimant #>> '{priceRevision,monetaryAmount,currencyCode}'
             IS DISTINCT FROM v_request #>> '{exactKey,currencyCode}'
        OR v_claimant #> '{effectivePeriod,effectiveFrom}' IS NULL
        OR (v_claimant #>> '{effectivePeriod,effectiveFrom}')::timestamptz > v_effective_at
        OR v_claimant #> '{effectivePeriod,effectiveTo}' IS NULL
        OR (
          v_claimant #> '{effectivePeriod,effectiveTo}' <> 'null'::jsonb
          AND v_effective_at >= (v_claimant #>> '{effectivePeriod,effectiveTo}')::timestamptz
        )
        OR v_claimant #>> '{priceRevision,effectiveFrom}'
             IS DISTINCT FROM v_claimant #>> '{effectivePeriod,effectiveFrom}'
        OR pg_catalog.jsonb_typeof(v_claimant -> 'provenanceRefs') <> 'array'
        OR pg_catalog.jsonb_array_length(v_claimant -> 'provenanceRefs') = 0
      THEN
        v_invalid_claimant_count := v_invalid_claimant_count + 1;
        CONTINUE;
      END IF;
    EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
      v_invalid_claimant_count := v_invalid_claimant_count + 1;
      CONTINUE;
    END;

    SELECT count(*)::integer, count(DISTINCT provenance.value)::integer
      INTO v_provenance_count, v_distinct_provenance_count
      FROM pg_catalog.jsonb_array_elements_text(v_claimant -> 'provenanceRefs') AS provenance(value)
     WHERE provenance.value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
    IF v_provenance_count <> pg_catalog.jsonb_array_length(v_claimant -> 'provenanceRefs')
      OR v_provenance_count <> v_distinct_provenance_count
    THEN
      v_invalid_claimant_count := v_invalid_claimant_count + 1;
    END IF;
  END LOOP;

  IF v_invalid_claimant_count <> 0
    OR v_database_raw_count <> v_database_valid_count
    OR v_claimant_count <> v_database_valid_count
  THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      '_tag', 'UNVERIFIABLE',
      'reason', 'SET_COMPLETENESS_UNVERIFIABLE',
      'request', v_request
    );
    RETURN;
  END IF;

  v_evidence := pg_catalog.jsonb_build_object(
    'effectiveAt', v_request ->> 'effectiveAt',
    'observedAt', pg_catalog.to_char(
      v_observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'ownerRevision', 'pricing-exact-conflict-v2:' || pg_catalog.encode(
      public.digest(
        pg_catalog.convert_to(pg_catalog.jsonb_build_object(
          'effectiveAt', v_effective_at,
          'exactKey', v_request -> 'exactKey',
          'claimants', v_distinct_claimants
        )::text, 'UTF8'),
        'sha256'
      ),
      'hex'
    )
  );

  RETURN QUERY SELECT pg_catalog.jsonb_build_object(
    '_tag', 'EXACT_PRICE_CONFLICT_DIAGNOSTIC',
    'claimants', v_distinct_claimants,
    'evidence', v_evidence,
    'reason', 'COMPETING_CURRENT_EXACT_PRICES',
    'request', v_request,
    'verification', 'OWNER_VERIFIED_COMPLETE_CURRENT_SET'
  );
END;
$function$;

REVOKE ALL ON FUNCTION pricing.lookup_exact_current_price_v2(uuid, uuid, jsonb)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pricing.lookup_exact_current_price_v2(uuid, uuid, jsonb)
  TO ontos_runtime;
