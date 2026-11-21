-- An external source changes a Price it already asserted.
--
-- The define path refused every second amount for an exact key that is already bound (EXACT_KEY_ALREADY_BOUND),
-- so a source could never change its own price. When the caller asks for it (`onExactKeyBound` is
-- `SUPERSEDE_SAME_SOURCE`, sent only by the define-price Action) and the Current Revision of the bound Price was
-- asserted by the same source authority and mapping, the assertion now becomes that Price's next revision through
-- the owner's own value-only revision and provenance bind: same Price, next Revision, effective from the asserted
-- time, its source fact superseding the Current one. The same amount changes nothing and answers the Current fact
-- (REUSED). Another authority or mapping, a staff or retirement fact, no Current Revision, and every caller without
-- the request keep the conflict exactly as before. Replace the deployed wrapper; the routines it calls are unchanged.
CREATE OR REPLACE FUNCTION pricing.define_price_unwrapped_v2(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_input jsonb
) RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_assertion jsonb := p_input #> '{sourceEvidence,sourceAssertion}';
  v_binding jsonb;
  v_current_amount numeric(38,9);
  v_current_count integer;
  v_current_from timestamptz;
  v_current_number integer;
  v_current_source pricing.price_source_assertions%ROWTYPE;
  v_current_to timestamptz;
  v_current_transition text;
  v_failure jsonb;
  v_head_id uuid;
  v_head_revision integer;
  v_lineage jsonb;
  v_price_id uuid;
  v_price_ref jsonb;
  v_price_revision_id uuid;
  v_result jsonb;
  v_revision jsonb;
  v_trusted_at timestamptz;
BEGIN
  BEGIN
    SELECT legacy.payload INTO v_result
      FROM pricing.define_price_v1(p_tenant_id, p_legal_entity_id, p_input) AS legacy;
    IF v_result ->> 'outcome' IN ('CREATED', 'REUSED') THEN
      v_price_id := (v_result #>> '{definition,priceRef,resourceId}')::uuid;
      v_price_revision_id := (v_result #>> '{definition,revision,revisionId}')::uuid;
      v_binding := pricing.bind_price_source_provenance_v1(
        p_tenant_id, p_legal_entity_id, v_price_id, v_price_revision_id, p_input
      );
      IF v_binding ->> 'outcome' NOT IN ('RECORDED', 'REUSED') THEN
        v_failure := v_binding;
        RAISE EXCEPTION 'Pricing source provenance rejected' USING ERRCODE = 'P7601';
      END IF;
      v_result := v_result || pg_catalog.jsonb_build_object('provenance', v_binding -> 'provenance');
    END IF;
  EXCEPTION WHEN SQLSTATE 'P7601' THEN
    v_result := v_failure;
  END;

  IF v_result ->> 'outcome' IS DISTINCT FROM 'CONFLICT'
    OR v_result ->> 'reason' IS DISTINCT FROM 'EXACT_KEY_ALREADY_BOUND'
    OR p_input ->> 'onExactKeyBound' IS DISTINCT FROM 'SUPERSEDE_SAME_SOURCE'
  THEN
    RETURN QUERY SELECT v_result;
    RETURN;
  END IF;

  -- define_price_v1 validated the whole input before it answered EXACT_KEY_ALREADY_BOUND.
  v_trusted_at := (p_input ->> 'trustedOperationAt')::timestamptz;
  SELECT price.price_id INTO v_price_id
    FROM pricing.prices AS price
   WHERE price.tenant_id = p_tenant_id
     AND price.legal_entity_id = p_legal_entity_id
     AND price.catalog_selection = p_input #> '{identityKey,catalogSelection}'
     AND price.channel_id = p_input #>> '{identityKey,commercialScope,channelId}'
     AND price.market_id = p_input #>> '{identityKey,commercialScope,marketId}'
     AND price.currency_code = p_input #>> '{identityKey,currencyCode}'
     AND price.unit_ref = p_input #> '{identityKey,unitBasis,unitRef}'
     AND price.basis_quantity = (p_input #>> '{identityKey,unitBasis,quantity}')::numeric(38,9)
     AND price.price_group_selector = p_input #> '{identityKey,priceGroupSelector}';
  IF NOT FOUND THEN
    RETURN QUERY SELECT v_result;
    RETURN;
  END IF;

  -- The same schedule lock the revision takes, so the Current Revision read here is the one it replaces.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_tenant_id::text || ':price-schedule:' || v_price_id::text, 0)
  );
  SELECT head.price_schedule_revision_id, head.schedule_revision
    INTO v_head_id, v_head_revision
    FROM pricing.price_schedule_heads AS head
   WHERE head.tenant_id = p_tenant_id AND head.legal_entity_id = p_legal_entity_id
     AND head.price_id = v_price_id;
  SELECT count(*)::integer,
         min(entry.price_revision_id::text)::uuid,
         min(revision.revision_number), min(revision.amount),
         min(entry.effective_from), min(entry.effective_to), min(revision.transition_kind)
    INTO v_current_count, v_price_revision_id, v_current_number, v_current_amount,
         v_current_from, v_current_to, v_current_transition
    FROM pricing.price_schedule_entries AS entry
    JOIN pricing.price_revisions AS revision
      ON revision.tenant_id = entry.tenant_id AND revision.legal_entity_id = entry.legal_entity_id
     AND revision.price_id = entry.price_id AND revision.price_revision_id = entry.price_revision_id
   WHERE entry.tenant_id = p_tenant_id AND entry.legal_entity_id = p_legal_entity_id
     AND entry.price_id = v_price_id AND entry.price_schedule_revision_id = v_head_id
     AND entry.effective_from <= v_trusted_at
     AND (entry.effective_to IS NULL OR v_trusted_at < entry.effective_to);
  SELECT assertion.* INTO v_current_source
    FROM pricing.price_source_assertions AS assertion
   WHERE assertion.tenant_id = p_tenant_id AND assertion.legal_entity_id = p_legal_entity_id
     AND assertion.price_id = v_price_id AND assertion.price_revision_id = v_price_revision_id;
  IF v_current_count IS DISTINCT FROM 1
    OR v_current_transition = 'RETIREMENT'
    OR v_current_source.source_assertion_id IS NULL
    OR v_current_source.source_authority_ref IS DISTINCT FROM v_assertion #>> '{sourceAuthority,sourceAuthorityRef}'
    OR v_current_source.source_authority_version
         IS DISTINCT FROM v_assertion #>> '{sourceAuthority,sourceAuthorityVersion}'
    OR v_current_source.mapping_contract_ref IS DISTINCT FROM v_assertion #>> '{mapping,mappingContractRef}'
    OR v_current_source.mapping_contract_version IS DISTINCT FROM v_assertion #>> '{mapping,mappingContractVersion}'
  THEN
    RETURN QUERY SELECT v_result;
    RETURN;
  END IF;

  IF v_current_amount = (p_input #>> '{monetaryAmount,amount}')::numeric(38,9) THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      'definition', pricing.scheduled_price_revision_json_v1(
        p_tenant_id, p_legal_entity_id, v_price_id, v_price_revision_id, v_current_from, v_current_to
      ) -> 'definition',
      'outcome', 'REUSED',
      'provenance', pricing.price_source_provenance_json_v1(
        p_tenant_id, p_legal_entity_id, v_price_id, v_price_revision_id
      )
    );
    RETURN;
  END IF;

  v_price_ref := pg_catalog.jsonb_build_object(
    'moduleId', 'commerce.pricing',
    'resourceId', v_price_id::text,
    'resourceType', 'commerce.pricing.price',
    'tenantId', p_tenant_id::text
  );
  v_lineage := pg_catalog.jsonb_build_object(
    'kind', 'SUPERSESSION',
    'reason', 'The same source authority asserted a new amount for this exact Price key.',
    'supersededSourceAssertionId', v_current_source.source_assertion_id::text
  );
  SELECT revised.payload INTO v_revision
    FROM pricing.revise_price_unwrapped_v2(
      p_tenant_id,
      p_legal_entity_id,
      (p_input - 'identityKey' - 'onExactKeyBound') || pg_catalog.jsonb_build_object(
        'expectedCurrent', pg_catalog.jsonb_build_object(
          'effectivePeriod', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
            'effectiveFrom', pg_catalog.to_char(v_current_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'effectiveTo', CASE WHEN v_current_to IS NULL THEN NULL ELSE
              pg_catalog.to_char(v_current_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
          )),
          'priceRef', v_price_ref,
          'revision', v_current_number,
          'revisionId', v_price_revision_id::text,
          'scheduleRevision', v_head_revision
        ),
        'intent', 'VALUE_ONLY_CURRENT',
        'priceRef', v_price_ref,
        'sourceEvidence', pg_catalog.jsonb_set(
          pg_catalog.jsonb_set(
            p_input -> 'sourceEvidence',
            '{lineage}',
            v_lineage || pg_catalog.jsonb_build_object(
              'actingPrincipalId', ((p_input ->> 'actingPrincipalId')::uuid)::text
            )
          ),
          '{sourceAssertion,lineage}',
          v_lineage
        )
      )
    ) AS revised;

  IF v_revision ->> 'outcome' = 'REVISED' THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      'definition', v_revision #> '{revision,definition}',
      'outcome', 'CREATED',
      'provenance', v_revision -> 'provenance'
    );
  ELSIF v_revision ->> 'outcome' = 'CONFLICT' AND v_revision ->> 'reason' IN (
    'CANONICAL_LINK_MISMATCH', 'SOURCE_FACT_CONFLICT', 'SOURCE_LINEAGE_INVALID', 'SOURCE_PROVENANCE_INVALID'
  ) THEN
    RETURN QUERY SELECT v_revision;
  ELSE
    -- A schedule the value-only revision cannot take (a boundary, a future change, a concurrent edit) keeps the
    -- key bound; the caller's wrapper rolls back anything the attempt recorded.
    RETURN QUERY SELECT v_result;
  END IF;
END;
$function$;
