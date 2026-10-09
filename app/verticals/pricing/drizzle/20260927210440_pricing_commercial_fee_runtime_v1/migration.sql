-- #773 Pricing Commercial Fee runtime. Stable Fee facts and revisions are append-only;
-- only schedule heads mutate through compare-and-swap.
CREATE EXTENSION IF NOT EXISTS "btree_gist" WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA public;

ALTER TABLE pricing.fees FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.fee_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.fee_schedule_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.fee_schedule_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.fee_schedule_acknowledgements FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.fee_schedule_heads FORCE ROW LEVEL SECURITY;

ALTER TABLE pricing.fee_schedule_entries
  ADD CONSTRAINT pricing_fee_schedule_entries_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    legal_entity_id WITH =,
    fee_id WITH =,
    fee_schedule_revision_id WITH =,
    pg_catalog.tstzrange(effective_from, effective_to, '[)') WITH &&
  );

CREATE FUNCTION pricing.fee_identity_json_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_fee_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT jsonb_build_object(
    'calculationBasis', CASE WHEN fee.calculation_basis = 'FIXED_PER_LINE'
      THEN jsonb_build_object('kind', 'FIXED_PER_LINE')
      ELSE jsonb_build_object(
        'kind', 'FIXED_PER_UNIT',
        'unitBasis', jsonb_build_object(
          'quantity', fee.basis_quantity::text,
          'unitRef', fee.unit_ref
        )
      ) END,
    'commercialScope', jsonb_build_object(
      'sellingLegalEntityId', fee.legal_entity_id::text,
      'channelId', fee.channel_id,
      'marketId', fee.market_id
    ),
    'currencyCode', fee.currency_code,
    'family', fee.family,
    'monetaryBoundary', fee.monetary_boundary,
    'target', jsonb_build_object(
      'productRef', fee.product_ref,
      'variantRef', fee.variant_ref
    )
  )
    FROM pricing.fees AS fee
   WHERE fee.tenant_id = p_tenant_id
     AND fee.legal_entity_id = p_legal_entity_id
     AND fee.fee_id = p_fee_id
$function$;

CREATE OR REPLACE FUNCTION pricing.define_commercial_fee_v1(
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
  v_identity jsonb := p_input -> 'identityKey';
  v_action_invocation_id uuid;
  v_acting_principal_id uuid;
  v_fee_id uuid;
  v_fee_revision_id uuid;
  v_fee_schedule_revision_id uuid;
  v_amount_text text;
  v_amount numeric(38,9);
  v_basis_quantity_text text;
  v_basis_quantity numeric(38,9);
  v_basis_kind text;
  v_effective_from timestamptz;
  v_effective_to timestamptz;
  v_currency text;
  v_family text;
  v_product_ref jsonb;
  v_variant_ref jsonb;
  v_unit_ref jsonb;
  v_channel_id text;
  v_market_id text;
  v_reason text;
  v_request_correlation text;
  v_existing record;
  v_definition jsonb;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Pricing Commercial Fee write scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_input IS NULL OR jsonb_typeof(p_input) <> 'object' OR jsonb_typeof(v_identity) <> 'object' THEN
    RAISE EXCEPTION 'Pricing Commercial Fee write input is invalid' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_action_invocation_id := (p_input ->> 'actionInvocationId')::uuid;
    v_acting_principal_id := (p_input ->> 'actingPrincipalId')::uuid;
    v_effective_from := (p_input #>> '{effectivePeriod,effectiveFrom}')::timestamptz;
    IF p_input #> '{effectivePeriod,effectiveTo}' <> 'null'::jsonb THEN
      v_effective_to := (p_input #>> '{effectivePeriod,effectiveTo}')::timestamptz;
    END IF;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Pricing Commercial Fee write input is invalid' USING ERRCODE = '22023';
  END;
  v_amount_text := p_input #>> '{configuredAmount,amount}';
  v_basis_kind := v_identity #>> '{calculationBasis,kind}';
  v_basis_quantity_text := v_identity #>> '{calculationBasis,unitBasis,quantity}';
  IF v_amount_text IS NULL OR v_amount_text !~ '^(0|[1-9][0-9]{0,28})(\.[0-9]{1,9})?$'
    OR (v_basis_kind = 'FIXED_PER_UNIT' AND (
      v_basis_quantity_text IS NULL
      OR v_basis_quantity_text !~ '^(0|[1-9][0-9]{0,28})(\.[0-9]{1,9})?$'
    ))
  THEN
    RAISE EXCEPTION 'Pricing Commercial Fee decimal input is invalid' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_amount := v_amount_text::numeric(38,9);
    IF v_basis_kind = 'FIXED_PER_UNIT' THEN
      v_basis_quantity := v_basis_quantity_text::numeric(38,9);
    END IF;
  EXCEPTION WHEN numeric_value_out_of_range THEN
    RAISE EXCEPTION 'Pricing Commercial Fee decimal input is invalid' USING ERRCODE = '22023';
  END;
  v_currency := p_input #>> '{configuredAmount,currencyCode}';
  v_family := v_identity ->> 'family';
  v_product_ref := v_identity #> '{target,productRef}';
  v_variant_ref := v_identity #> '{target,variantRef}';
  v_unit_ref := v_identity #> '{calculationBasis,unitBasis,unitRef}';
  v_channel_id := v_identity #>> '{commercialScope,channelId}';
  v_market_id := v_identity #>> '{commercialScope,marketId}';
  v_reason := p_input ->> 'reason';
  v_request_correlation := p_input ->> 'requestCorrelationId';

  IF v_action_invocation_id IS NULL OR v_acting_principal_id IS NULL OR v_amount < 0
    OR v_effective_from IS NULL OR (v_effective_to IS NOT NULL AND v_effective_to <= v_effective_from)
    OR v_currency !~ '^[A-Z]{3}$' OR v_identity ->> 'currencyCode' !~ '^[A-Z]{3}$'
    OR v_family NOT IN ('RECYCLING_FEE', 'COPYRIGHT_FEE')
    OR v_identity ->> 'monetaryBoundary' <> 'PRE_TAX'
    OR v_identity #>> '{commercialScope,sellingLegalEntityId}' <> p_legal_entity_id::text
    OR v_channel_id IS NULL OR v_channel_id <> btrim(v_channel_id) OR length(v_channel_id) NOT BETWEEN 1 AND 100
    OR v_market_id IS NULL OR v_market_id <> btrim(v_market_id) OR length(v_market_id) NOT BETWEEN 1 AND 200
    OR jsonb_typeof(v_product_ref) <> 'object' OR jsonb_typeof(v_variant_ref) <> 'object'
    OR v_product_ref ->> 'moduleId' <> 'commerce.catalog'
    OR v_product_ref ->> 'resourceType' <> 'commerce.catalog.product'
    OR v_product_ref ->> 'tenantId' <> p_tenant_id::text
    OR v_variant_ref ->> 'moduleId' <> 'commerce.catalog'
    OR v_variant_ref ->> 'resourceType' <> 'commerce.catalog.variant'
    OR v_variant_ref ->> 'tenantId' <> p_tenant_id::text
    OR v_basis_kind NOT IN ('FIXED_PER_LINE', 'FIXED_PER_UNIT')
    OR (v_basis_kind = 'FIXED_PER_LINE' AND (v_basis_quantity IS NOT NULL OR v_unit_ref IS NOT NULL))
    OR (v_basis_kind = 'FIXED_PER_UNIT' AND (
      v_basis_quantity <= 0 OR jsonb_typeof(v_unit_ref) <> 'object'
      OR v_unit_ref ->> 'moduleId' <> 'commerce.catalog'
      OR v_unit_ref ->> 'resourceType' <> 'commerce.catalog.product-unit'
      OR v_unit_ref ->> 'tenantId' <> p_tenant_id::text
    ))
    OR v_reason IS NULL OR v_reason <> btrim(v_reason) OR length(v_reason) NOT BETWEEN 1 AND 1000
    OR v_request_correlation IS NULL OR v_request_correlation <> btrim(v_request_correlation)
    OR length(v_request_correlation) NOT BETWEEN 1 AND 500
  THEN
    RAISE EXCEPTION 'Pricing Commercial Fee write input is invalid' USING ERRCODE = '22023';
  END IF;
  IF v_currency IS DISTINCT FROM v_identity ->> 'currencyCode' THEN
    RETURN QUERY SELECT jsonb_build_object(
      'identityKey', v_identity,
      'outcome', 'COMMERCIAL_FEE_CONFLICT',
      'reason', 'IDENTITY_MISMATCH'
    );
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_tenant_id::text || ':' || p_legal_entity_id::text || ':' || v_family || ':' || v_product_ref::text || ':' ||
      v_variant_ref::text || ':' || v_channel_id || ':' || v_market_id || ':' || v_basis_kind || ':' ||
      coalesce(v_basis_quantity::text, '') || ':' || coalesce(v_unit_ref::text, '') || ':' || v_currency,
      0
    )
  );
  SELECT fee.fee_id,
         revision.fee_revision_id,
         revision.amount,
         revision.currency_code,
         entry.effective_from,
         entry.effective_to
    INTO v_existing
    FROM pricing.fees AS fee
    JOIN pricing.fee_revisions AS revision
      ON revision.tenant_id = fee.tenant_id
     AND revision.legal_entity_id = fee.legal_entity_id
     AND revision.fee_id = fee.fee_id
    JOIN pricing.fee_schedule_entries AS entry
      ON entry.tenant_id = revision.tenant_id
     AND entry.legal_entity_id = revision.legal_entity_id
     AND entry.fee_id = revision.fee_id
     AND entry.fee_revision_id = revision.fee_revision_id
   WHERE fee.tenant_id = p_tenant_id
     AND fee.legal_entity_id = p_legal_entity_id
     AND revision.action_invocation_id = v_action_invocation_id;
  IF FOUND THEN
    IF pricing.fee_id_for_identity_v1(p_tenant_id, p_legal_entity_id, v_identity)
         IS DISTINCT FROM v_existing.fee_id
      OR v_existing.amount IS DISTINCT FROM v_amount
      OR v_existing.currency_code IS DISTINCT FROM v_currency
      OR v_existing.effective_from IS DISTINCT FROM v_effective_from
      OR v_existing.effective_to IS DISTINCT FROM v_effective_to
    THEN
      RETURN QUERY SELECT jsonb_build_object(
        'identityKey', v_identity,
        'outcome', 'COMMERCIAL_FEE_CONFLICT',
        'reason', 'IDENTITY_MISMATCH'
      );
      RETURN;
    END IF;
    v_definition := pricing.scheduled_fee_revision_json_v1(
      p_tenant_id, p_legal_entity_id, v_existing.fee_id,
      v_existing.fee_revision_id, v_existing.effective_from, v_existing.effective_to
    ) -> 'definition';
    RETURN QUERY SELECT jsonb_build_object('definition', v_definition, 'outcome', 'COMMERCIAL_FEE_REUSED');
    RETURN;
  END IF;
  IF pricing.fee_id_for_identity_v1(p_tenant_id, p_legal_entity_id, v_identity) IS NOT NULL THEN
    RETURN QUERY SELECT jsonb_build_object(
      'identityKey', pricing.fee_identity_json_v1(
        p_tenant_id,
        p_legal_entity_id,
        pricing.fee_id_for_identity_v1(p_tenant_id, p_legal_entity_id, v_identity)
      ),
      'outcome', 'COMMERCIAL_FEE_CONFLICT',
      'reason', 'IDENTITY_MISMATCH'
    );
    RETURN;
  END IF;

  v_fee_id := pg_catalog.gen_random_uuid();
  v_fee_revision_id := pg_catalog.gen_random_uuid();
  v_fee_schedule_revision_id := pg_catalog.gen_random_uuid();
  INSERT INTO pricing.fees (
    fee_id, tenant_id, legal_entity_id, family, product_ref, variant_ref,
    channel_id, market_id, calculation_basis, basis_quantity, unit_ref,
    currency_code, monetary_boundary,
    created_by_action_invocation_id, created_by_principal_id
  ) VALUES (
    v_fee_id, p_tenant_id, p_legal_entity_id, v_family, v_product_ref, v_variant_ref,
    v_channel_id, v_market_id, v_basis_kind, v_basis_quantity, v_unit_ref,
    v_currency, 'PRE_TAX',
    v_action_invocation_id, v_acting_principal_id
  );
  INSERT INTO pricing.fee_revisions (
    fee_revision_id, tenant_id, legal_entity_id, fee_id,
    revision_number, amount, currency_code, previous_revision_id,
    corrected_revision_id, transition_kind, action_invocation_id, acting_principal_id, reason
  ) VALUES (
    v_fee_revision_id, p_tenant_id, p_legal_entity_id, v_fee_id,
    1, v_amount, v_currency, NULL, NULL, 'INITIAL',
    v_action_invocation_id, v_acting_principal_id, v_reason
  );
  INSERT INTO pricing.fee_schedule_revisions (
    fee_schedule_revision_id, tenant_id, legal_entity_id, fee_id,
    schedule_revision, previous_schedule_revision_id, action_invocation_id, acting_principal_id, reason
  ) VALUES (
    v_fee_schedule_revision_id, p_tenant_id, p_legal_entity_id, v_fee_id,
    1, NULL, v_action_invocation_id, v_acting_principal_id, v_reason
  );
  INSERT INTO pricing.fee_schedule_entries (
    tenant_id, legal_entity_id, fee_id, fee_revision_id,
    fee_schedule_revision_id, schedule_revision, effective_from, effective_to
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_fee_id, v_fee_revision_id,
    v_fee_schedule_revision_id, 1, v_effective_from, v_effective_to
  );
  INSERT INTO pricing.fee_schedule_heads (
    tenant_id, legal_entity_id, fee_id,
    fee_schedule_revision_id, schedule_revision
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_fee_id,
    v_fee_schedule_revision_id, 1
  );
  v_definition := pricing.scheduled_fee_revision_json_v1(
    p_tenant_id, p_legal_entity_id, v_fee_id,
    v_fee_revision_id, v_effective_from, v_effective_to
  ) -> 'definition';
  RETURN QUERY SELECT jsonb_build_object('definition', v_definition, 'outcome', 'COMMERCIAL_FEE_CREATED');
END;
$function$;

CREATE FUNCTION pricing.scheduled_fee_revision_json_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_fee_id uuid,
  p_fee_revision_id uuid,
  p_effective_from timestamptz,
  p_effective_to timestamptz
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT jsonb_build_object(
    'definition', jsonb_build_object(
      'feeRef', jsonb_build_object(
        'moduleId', 'commerce.pricing',
        'resourceId', revision.fee_id::text,
        'resourceType', 'commerce.pricing.commercial-fee',
        'tenantId', revision.tenant_id::text
      ),
      'identityKey', pricing.fee_identity_json_v1(
        p_tenant_id, p_legal_entity_id, p_fee_id
      ),
      'revision', jsonb_build_object(
        'effectiveFrom', to_char(p_effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'configuredAmount', jsonb_build_object(
          'amount', revision.amount::text,
          'currencyCode', revision.currency_code
        ),
        'revision', revision.revision_number,
        'revisionId', revision.fee_revision_id::text
      )
    ),
    'effectivePeriod', jsonb_build_object(
      'effectiveFrom', to_char(p_effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'effectiveTo', CASE WHEN p_effective_to IS NULL THEN NULL ELSE
        to_char(p_effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
    ),
    'lineage', jsonb_build_object(
      'correctedRevisionId', revision.corrected_revision_id::text,
      'kind', revision.transition_kind,
      'previousRevisionId', revision.previous_revision_id::text
    )
  )
    FROM pricing.fee_revisions AS revision
   WHERE revision.tenant_id = p_tenant_id
     AND revision.legal_entity_id = p_legal_entity_id
     AND revision.fee_id = p_fee_id
     AND revision.fee_revision_id = p_fee_revision_id
$function$;

CREATE FUNCTION pricing.fee_id_for_identity_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_identity jsonb
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT fee.fee_id
    FROM pricing.fees AS fee
   WHERE fee.tenant_id = p_tenant_id
     AND fee.legal_entity_id = p_legal_entity_id
     AND p_identity #>> '{commercialScope,sellingLegalEntityId}' = p_legal_entity_id::text
     AND fee.family = p_identity ->> 'family'
     AND fee.product_ref = p_identity #> '{target,productRef}'
     AND fee.variant_ref = p_identity #> '{target,variantRef}'
     AND fee.channel_id = p_identity #>> '{commercialScope,channelId}'
     AND fee.market_id = p_identity #>> '{commercialScope,marketId}'
     AND fee.calculation_basis = p_identity #>> '{calculationBasis,kind}'
     AND fee.basis_quantity IS NOT DISTINCT FROM CASE
       WHEN p_identity #>> '{calculationBasis,kind}' = 'FIXED_PER_UNIT'
       THEN (p_identity #>> '{calculationBasis,unitBasis,quantity}')::numeric(38,9)
       ELSE NULL
     END
     AND fee.unit_ref IS NOT DISTINCT FROM p_identity #> '{calculationBasis,unitBasis,unitRef}'
     AND fee.currency_code = p_identity ->> 'currencyCode'
     AND fee.monetary_boundary = p_identity ->> 'monetaryBoundary'
$function$;

CREATE OR REPLACE FUNCTION pricing.read_commercial_fee_schedule_v1(
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
  v_identity jsonb := p_input -> 'identityKey';
  v_observed_at timestamptz;
  v_fee_id uuid;
  v_head_revision_id uuid;
  v_schedule_revision integer;
  v_current_count integer;
  v_candidate_ids jsonb;
  v_current jsonb;
  v_revisions jsonb;
  v_future jsonb;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Pricing Commercial Fee read scope mismatch' USING ERRCODE = '42501';
  END IF;
  BEGIN
    v_observed_at := (p_input ->> 'trustedOperationAt')::timestamptz;
    v_fee_id := pricing.fee_id_for_identity_v1(
      p_tenant_id, p_legal_entity_id, v_identity
    );
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Pricing Commercial Fee read input is invalid' USING ERRCODE = '22023';
  END;
  IF v_observed_at IS NULL OR jsonb_typeof(v_identity) <> 'object' THEN
    RAISE EXCEPTION 'Pricing Commercial Fee read input is invalid' USING ERRCODE = '22023';
  END IF;
  IF v_fee_id IS NULL THEN
    RETURN QUERY SELECT jsonb_build_object(
      'identityKey', v_identity,
      'outcome', 'COMMERCIAL_FEE_SCHEDULE_ABSENT'
    );
    RETURN;
  END IF;

  SELECT head.fee_schedule_revision_id, head.schedule_revision
    INTO v_head_revision_id, v_schedule_revision
    FROM pricing.fee_schedule_heads AS head
   WHERE head.tenant_id = p_tenant_id
     AND head.legal_entity_id = p_legal_entity_id
     AND head.fee_id = v_fee_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT jsonb_build_object(
      'identityKey', pricing.fee_identity_json_v1(
        p_tenant_id, p_legal_entity_id, v_fee_id
      ),
      'outcome', 'COMMERCIAL_FEE_SCHEDULE_ABSENT'
    );
    RETURN;
  END IF;

  SELECT count(*)::integer,
         coalesce(jsonb_agg(entry.fee_revision_id::text ORDER BY entry.effective_from), '[]'::jsonb),
         min(pricing.scheduled_fee_revision_json_v1(
           p_tenant_id, p_legal_entity_id, v_fee_id,
           entry.fee_revision_id, entry.effective_from, entry.effective_to
         )::text)::jsonb
    INTO v_current_count, v_candidate_ids, v_current
    FROM pricing.fee_schedule_entries AS entry
   WHERE entry.tenant_id = p_tenant_id
     AND entry.legal_entity_id = p_legal_entity_id
     AND entry.fee_id = v_fee_id
     AND entry.fee_schedule_revision_id = v_head_revision_id
     AND entry.effective_from <= v_observed_at
     AND (entry.effective_to IS NULL OR v_observed_at < entry.effective_to);
  IF v_current_count > 1 THEN
    RETURN QUERY SELECT jsonb_build_object(
      'candidateRevisionIds', v_candidate_ids,
      'identityKey', pricing.fee_identity_json_v1(
        p_tenant_id, p_legal_entity_id, v_fee_id
      ),
      'outcome', 'COMMERCIAL_FEE_SCHEDULE_CONFLICT'
    );
    RETURN;
  END IF;

  SELECT coalesce(jsonb_agg(
           pricing.scheduled_fee_revision_json_v1(
             p_tenant_id, p_legal_entity_id, v_fee_id,
             entry.fee_revision_id, entry.effective_from, entry.effective_to
           ) ORDER BY entry.effective_from, entry.fee_revision_id
         ), '[]'::jsonb),
         coalesce(jsonb_agg(
           pricing.scheduled_fee_revision_json_v1(
             p_tenant_id, p_legal_entity_id, v_fee_id,
             entry.fee_revision_id, entry.effective_from, entry.effective_to
           ) ORDER BY entry.effective_from, entry.fee_revision_id
         ) FILTER (WHERE entry.effective_from > v_observed_at), '[]'::jsonb)
    INTO v_revisions, v_future
    FROM pricing.fee_schedule_entries AS entry
   WHERE entry.tenant_id = p_tenant_id
     AND entry.legal_entity_id = p_legal_entity_id
     AND entry.fee_id = v_fee_id
     AND entry.fee_schedule_revision_id = v_head_revision_id;

  RETURN QUERY SELECT jsonb_build_object(
    'outcome', 'COMMERCIAL_FEE_SCHEDULE',
    'schedule', jsonb_build_object(
      'feeRef', jsonb_build_object(
        'moduleId', 'commerce.pricing',
        'resourceId', v_fee_id::text,
        'resourceType', 'commerce.pricing.commercial-fee',
        'tenantId', p_tenant_id::text
      ),
      'future', v_future,
      'identityKey', pricing.fee_identity_json_v1(
        p_tenant_id, p_legal_entity_id, v_fee_id
      ),
      'observedAt', to_char(v_observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'revisions', v_revisions,
      'scheduleRevision', v_schedule_revision
    ) || CASE WHEN v_current_count = 1 THEN jsonb_build_object('current', v_current) ELSE '{}'::jsonb END
  );
END;
$function$;

CREATE OR REPLACE FUNCTION pricing.read_current_commercial_fee_v1(
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
  v_schedule jsonb;
  v_effective_at timestamptz;
BEGIN
  BEGIN
    v_effective_at := (p_input ->> 'effectiveAt')::timestamptz;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Pricing Commercial Fee Current input is invalid' USING ERRCODE = '22023';
  END;
  SELECT result.payload INTO v_schedule
    FROM pricing.read_commercial_fee_schedule_v1(
      p_tenant_id,
      p_legal_entity_id,
      jsonb_build_object('identityKey', p_input -> 'identityKey', 'trustedOperationAt', p_input ->> 'effectiveAt')
    ) AS result;
  IF v_schedule ->> 'outcome' = 'COMMERCIAL_FEE_SCHEDULE'
    AND v_schedule #> '{schedule,current}' IS NOT NULL
  THEN
    RETURN QUERY SELECT jsonb_build_object(
      'observedAt', to_char(v_effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'outcome', 'COMMERCIAL_FEE_CURRENT',
      'revision', v_schedule #> '{schedule,current}'
    );
  ELSIF v_schedule ->> 'outcome' = 'COMMERCIAL_FEE_SCHEDULE_CONFLICT' THEN
    RETURN QUERY SELECT jsonb_build_object(
      'candidateRevisionIds', v_schedule -> 'candidateRevisionIds',
      'identityKey', v_schedule -> 'identityKey',
      'observedAt', to_char(v_effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'outcome', 'COMMERCIAL_FEE_CURRENT_CONFLICT'
    );
  ELSE
    RETURN QUERY SELECT jsonb_build_object(
      'identityKey', coalesce(v_schedule #> '{schedule,identityKey}', v_schedule -> 'identityKey', p_input -> 'identityKey'),
      'observedAt', to_char(v_effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'outcome', 'COMMERCIAL_FEE_CURRENT_ABSENT'
    );
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION pricing.revise_commercial_fee_v1(
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
  v_identity jsonb := p_input -> 'identityKey';
  v_fee_id uuid;
  v_action_invocation_id uuid;
  v_acting_principal_id uuid;
  v_trusted_at timestamptz;
  v_amount_text text;
  v_amount numeric(38,9);
  v_currency text;
  v_reason text;
  v_request_correlation text;
  v_intent text := p_input ->> 'intent';
  v_head_revision_id uuid;
  v_schedule_revision integer;
  v_new_schedule_revision integer;
  v_new_schedule_revision_id uuid := pg_catalog.gen_random_uuid();
  v_new_revision_id uuid := pg_catalog.gen_random_uuid();
  v_new_revision_number integer;
  v_previous_revision_id uuid;
  v_previous_revision_number integer;
  v_current_count integer;
  v_current_entry_id uuid;
  v_current_revision_id uuid;
  v_current_revision_number integer;
  v_current_amount numeric(38,9);
  v_current_currency text;
  v_current_from timestamptz;
  v_current_to timestamptz;
  v_effective_from timestamptz;
  v_effective_to timestamptz;
  v_future jsonb;
  v_ack_body jsonb;
  v_ack jsonb;
  v_ack_fingerprint text;
  v_supplied_ack jsonb := p_input -> 'acknowledgement';
  v_updated_count integer;
  v_overlap_count integer;
  v_schedule_result jsonb;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Pricing Commercial Fee revision scope mismatch' USING ERRCODE = '42501';
  END IF;
  BEGIN
    v_action_invocation_id := (p_input ->> 'actionInvocationId')::uuid;
    v_acting_principal_id := (p_input ->> 'actingPrincipalId')::uuid;
    v_trusted_at := (p_input ->> 'trustedOperationAt')::timestamptz;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Pricing Commercial Fee revision input is invalid' USING ERRCODE = '22023';
  END;
  v_amount_text := p_input #>> '{configuredAmount,amount}';
  IF v_amount_text IS NULL OR v_amount_text !~ '^(0|[1-9][0-9]{0,28})(\.[0-9]{1,9})?$' THEN
    RAISE EXCEPTION 'Pricing Commercial Fee revision amount is invalid' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_amount := v_amount_text::numeric(38,9);
  EXCEPTION WHEN numeric_value_out_of_range THEN
    RAISE EXCEPTION 'Pricing Commercial Fee revision amount is invalid' USING ERRCODE = '22023';
  END;
  v_currency := p_input #>> '{configuredAmount,currencyCode}';
  v_reason := p_input ->> 'reason';
  v_request_correlation := p_input ->> 'requestCorrelationId';
  IF v_action_invocation_id IS NULL OR v_acting_principal_id IS NULL OR v_trusted_at IS NULL
    OR v_amount < 0 OR v_currency !~ '^[A-Z]{3}$' OR v_identity ->> 'currencyCode' !~ '^[A-Z]{3}$'
    OR v_identity #>> '{commercialScope,sellingLegalEntityId}' <> p_legal_entity_id::text
    OR v_intent NOT IN ('VALUE_ONLY_CURRENT', 'SCHEDULE_REVISION')
    OR v_reason IS NULL OR v_reason <> btrim(v_reason) OR length(v_reason) NOT BETWEEN 1 AND 1000
    OR v_request_correlation IS NULL OR v_request_correlation <> btrim(v_request_correlation)
    OR length(v_request_correlation) NOT BETWEEN 1 AND 500
  THEN
    RAISE EXCEPTION 'Pricing Commercial Fee revision input is invalid' USING ERRCODE = '22023';
  END IF;
  IF v_currency IS DISTINCT FROM v_identity ->> 'currencyCode' THEN
    RETURN QUERY SELECT jsonb_build_object(
      'identityKey', v_identity,
      'outcome', 'COMMERCIAL_FEE_CONFLICT',
      'reason', 'IDENTITY_MISMATCH'
    );
    RETURN;
  END IF;

  v_fee_id := pricing.fee_id_for_identity_v1(
    p_tenant_id, p_legal_entity_id, v_identity
  );
  IF v_fee_id IS NULL THEN
    RETURN QUERY SELECT jsonb_build_object(
      'identityKey', v_identity,
      'outcome', 'COMMERCIAL_FEE_CONFLICT',
      'reason', 'IDENTITY_MISMATCH'
    );
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pricing.fees AS fee
     WHERE fee.tenant_id = p_tenant_id
       AND fee.legal_entity_id = p_legal_entity_id
       AND fee.fee_id = v_fee_id
       AND fee.currency_code = v_currency
  ) THEN
    RETURN QUERY SELECT jsonb_build_object(
      'identityKey', pricing.fee_identity_json_v1(
        p_tenant_id, p_legal_entity_id, v_fee_id
      ),
      'outcome', 'COMMERCIAL_FEE_CONFLICT',
      'reason', 'IDENTITY_MISMATCH'
    );
    RETURN;
  END IF;

  SELECT head.fee_schedule_revision_id, head.schedule_revision
    INTO v_head_revision_id, v_schedule_revision
    FROM pricing.fee_schedule_heads AS head
   WHERE head.tenant_id = p_tenant_id
     AND head.legal_entity_id = p_legal_entity_id
     AND head.fee_id = v_fee_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT jsonb_build_object(
      'identityKey', v_identity,
      'outcome', 'COMMERCIAL_FEE_CONFLICT',
      'reason', 'IDENTITY_MISMATCH'
    );
    RETURN;
  END IF;
  v_new_schedule_revision := v_schedule_revision + 1;
  SELECT max(revision.revision_number) + 1
    INTO v_new_revision_number
    FROM pricing.fee_revisions AS revision
   WHERE revision.tenant_id = p_tenant_id
     AND revision.legal_entity_id = p_legal_entity_id
     AND revision.fee_id = v_fee_id;

  IF EXISTS (
    SELECT 1 FROM pricing.fee_revisions AS revision
     WHERE revision.tenant_id = p_tenant_id
       AND revision.action_invocation_id = v_action_invocation_id
  ) THEN
    SELECT result.payload INTO v_schedule_result
      FROM pricing.read_commercial_fee_schedule_v1(
        p_tenant_id, p_legal_entity_id,
        jsonb_build_object('identityKey', v_identity, 'trustedOperationAt', p_input ->> 'trustedOperationAt')
      ) AS result;
    RETURN QUERY SELECT jsonb_build_object(
      'outcome', 'COMMERCIAL_FEE_UNCHANGED',
      'schedule', v_schedule_result -> 'schedule'
    );
    RETURN;
  END IF;

  IF v_intent = 'VALUE_ONLY_CURRENT' THEN
    SELECT count(*)::integer,
           min(entry.fee_schedule_entry_id::text)::uuid,
           min(entry.fee_revision_id::text)::uuid,
           min(revision.revision_number), min(revision.amount), min(revision.currency_code),
           min(entry.effective_from), min(entry.effective_to)
      INTO v_current_count, v_current_entry_id, v_current_revision_id, v_current_revision_number,
           v_current_amount, v_current_currency, v_current_from, v_current_to
      FROM pricing.fee_schedule_entries AS entry
      JOIN pricing.fee_revisions AS revision
        ON revision.tenant_id = entry.tenant_id
       AND revision.legal_entity_id = entry.legal_entity_id
       AND revision.fee_id = entry.fee_id
       AND revision.fee_revision_id = entry.fee_revision_id
     WHERE entry.tenant_id = p_tenant_id
       AND entry.legal_entity_id = p_legal_entity_id
       AND entry.fee_id = v_fee_id
       AND entry.fee_schedule_revision_id = v_head_revision_id
       AND entry.effective_from <= v_trusted_at
       AND (entry.effective_to IS NULL OR v_trusted_at < entry.effective_to);
    IF v_current_count <> 1 THEN
      RETURN QUERY SELECT jsonb_build_object(
        'identityKey', v_identity,
        'outcome', 'COMMERCIAL_FEE_CONFLICT',
        'reason', 'EFFECTIVE_BOUNDARY_STALE'
      );
      RETURN;
    END IF;
    IF (p_input #>> '{expectedCurrent,scheduleRevision}')::integer IS DISTINCT FROM v_schedule_revision
      OR (p_input #>> '{expectedCurrent,revision}')::integer IS DISTINCT FROM v_current_revision_number
      OR (p_input #>> '{expectedCurrent,revisionId}')::uuid IS DISTINCT FROM v_current_revision_id
      OR p_input #>> '{expectedCurrent,feeRef,resourceId}' IS DISTINCT FROM v_fee_id::text
      OR p_input #>> '{expectedCurrent,feeRef,tenantId}' IS DISTINCT FROM p_tenant_id::text
      OR (p_input #>> '{expectedCurrent,effectivePeriod,effectiveFrom}')::timestamptz IS DISTINCT FROM v_current_from
      OR (CASE WHEN p_input #> '{expectedCurrent,effectivePeriod,effectiveTo}' = 'null'::jsonb THEN NULL ELSE
            (p_input #>> '{expectedCurrent,effectivePeriod,effectiveTo}')::timestamptz END) IS DISTINCT FROM v_current_to
      OR pricing.fee_id_for_identity_v1(
           p_tenant_id, p_legal_entity_id, p_input #> '{expectedCurrent,identityKey}'
         ) IS DISTINCT FROM v_fee_id
    THEN
      RETURN QUERY SELECT jsonb_build_object(
        'identityKey', pricing.fee_identity_json_v1(
          p_tenant_id, p_legal_entity_id, v_fee_id
        ),
        'outcome', 'COMMERCIAL_FEE_CONFLICT',
        'reason', 'EXPECTED_CURRENT_STALE'
      );
      RETURN;
    END IF;
    SELECT coalesce(jsonb_agg(
             pricing.scheduled_fee_revision_json_v1(
               p_tenant_id, p_legal_entity_id, v_fee_id,
               entry.fee_revision_id, entry.effective_from, entry.effective_to
             ) ORDER BY entry.effective_from, entry.fee_revision_id
           ), '[]'::jsonb)
      INTO v_future
      FROM pricing.fee_schedule_entries AS entry
     WHERE entry.tenant_id = p_tenant_id
       AND entry.legal_entity_id = p_legal_entity_id
       AND entry.fee_id = v_fee_id
       AND entry.fee_schedule_revision_id = v_head_revision_id
       AND entry.effective_from > v_trusted_at;

    IF v_current_amount = v_amount AND v_current_currency = v_currency THEN
      SELECT result.payload INTO v_schedule_result
        FROM pricing.read_commercial_fee_schedule_v1(
          p_tenant_id, p_legal_entity_id,
          jsonb_build_object('identityKey', v_identity, 'trustedOperationAt', p_input ->> 'trustedOperationAt')
        ) AS result;
      RETURN QUERY SELECT jsonb_build_object(
        'outcome', 'COMMERCIAL_FEE_UNCHANGED',
        'schedule', v_schedule_result -> 'schedule'
      );
      RETURN;
    END IF;

    v_ack_body := jsonb_build_object(
      'actingPrincipalId', v_acting_principal_id::text,
      'feeRef', jsonb_build_object(
        'moduleId', 'commerce.pricing',
        'resourceId', v_fee_id::text,
        'resourceType', 'commerce.pricing.commercial-fee',
        'tenantId', p_tenant_id::text
      ),
      'identityKey', pricing.fee_identity_json_v1(
        p_tenant_id, p_legal_entity_id, v_fee_id
      ),
      'intendedEffectivePeriod', jsonb_build_object(
        'effectiveFrom', to_char(v_current_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'effectiveTo', CASE WHEN v_current_to IS NULL THEN NULL ELSE
          to_char(v_current_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
      ),
      'intendedConfiguredAmount', jsonb_build_object(
        'amount', v_amount::text, 'currencyCode', v_currency
      ),
      'intent', 'VALUE_ONLY_CURRENT',
      'presentedFuture', v_future,
      'scheduleRevision', v_schedule_revision,
      'targetEffectivePeriod', jsonb_build_object(
        'effectiveFrom', to_char(v_current_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'effectiveTo', CASE WHEN v_current_to IS NULL THEN NULL ELSE
          to_char(v_current_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
      ),
      'targetRevisionId', v_current_revision_id::text
    );
    v_ack_fingerprint := pg_catalog.encode(
      public.digest(pg_catalog.convert_to(v_ack_body::text, 'UTF8'), 'sha256'), 'hex'
    );
    v_ack := v_ack_body || jsonb_build_object('fingerprint', v_ack_fingerprint);
    IF jsonb_array_length(v_future) > 0 AND v_supplied_ack IS NULL THEN
      RETURN QUERY SELECT jsonb_build_object(
        'acknowledgement', v_ack,
        'outcome', 'COMMERCIAL_FEE_ACKNOWLEDGEMENT_REQUIRED'
      );
      RETURN;
    END IF;
    IF v_supplied_ack IS NOT NULL AND v_supplied_ack IS DISTINCT FROM v_ack THEN
      RETURN QUERY SELECT jsonb_build_object(
        'identityKey', pricing.fee_identity_json_v1(
          p_tenant_id, p_legal_entity_id, v_fee_id
        ),
        'outcome', 'COMMERCIAL_FEE_CONFLICT',
        'reason', 'ACKNOWLEDGEMENT_STALE'
      );
      RETURN;
    END IF;

    INSERT INTO pricing.fee_revisions (
      fee_revision_id, tenant_id, legal_entity_id, fee_id,
      revision_number, amount, currency_code, previous_revision_id,
      corrected_revision_id, transition_kind, action_invocation_id, acting_principal_id, reason
    ) VALUES (
      v_new_revision_id, p_tenant_id, p_legal_entity_id, v_fee_id,
      v_new_revision_number, v_amount, v_currency, v_current_revision_id,
      NULL, 'VALUE_ONLY_CURRENT', v_action_invocation_id, v_acting_principal_id, v_reason
    );
  ELSE
    BEGIN
      v_effective_from := (p_input #>> '{effectivePeriod,effectiveFrom}')::timestamptz;
      IF p_input #> '{effectivePeriod,effectiveTo}' <> 'null'::jsonb THEN
        v_effective_to := (p_input #>> '{effectivePeriod,effectiveTo}')::timestamptz;
      END IF;
    EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
      RAISE EXCEPTION 'Pricing Commercial Fee scheduled period is invalid' USING ERRCODE = '22023';
    END;
    IF (p_input ->> 'expectedScheduleRevision')::integer IS DISTINCT FROM v_schedule_revision THEN
      RETURN QUERY SELECT jsonb_build_object(
        'identityKey', v_identity,
        'outcome', 'COMMERCIAL_FEE_CONFLICT',
        'reason', 'EXPECTED_SCHEDULE_STALE'
      );
      RETURN;
    END IF;
    IF v_effective_from IS NULL OR (v_effective_to IS NOT NULL AND v_effective_to <= v_effective_from) THEN
      RAISE EXCEPTION 'Pricing Commercial Fee scheduled period is invalid' USING ERRCODE = '22023';
    END IF;
    SELECT count(*)::integer INTO v_overlap_count
      FROM pricing.fee_schedule_entries AS entry
     WHERE entry.tenant_id = p_tenant_id
       AND entry.legal_entity_id = p_legal_entity_id
       AND entry.fee_id = v_fee_id
       AND entry.fee_schedule_revision_id = v_head_revision_id
       AND pg_catalog.tstzrange(entry.effective_from, entry.effective_to, '[)') &&
           pg_catalog.tstzrange(v_effective_from, v_effective_to, '[)');
    IF v_overlap_count > 0 THEN
      RETURN QUERY SELECT jsonb_build_object(
        'identityKey', v_identity,
        'outcome', 'COMMERCIAL_FEE_CONFLICT',
        'reason', 'OVERLAPPING_SCHEDULE'
      );
      RETURN;
    END IF;
    SELECT revision.fee_revision_id, revision.revision_number
      INTO v_previous_revision_id, v_previous_revision_number
      FROM pricing.fee_schedule_entries AS entry
      JOIN pricing.fee_revisions AS revision
        ON revision.tenant_id = entry.tenant_id
       AND revision.legal_entity_id = entry.legal_entity_id
       AND revision.fee_id = entry.fee_id
       AND revision.fee_revision_id = entry.fee_revision_id
     WHERE entry.tenant_id = p_tenant_id
       AND entry.legal_entity_id = p_legal_entity_id
       AND entry.fee_id = v_fee_id
       AND entry.fee_schedule_revision_id = v_head_revision_id
     ORDER BY entry.effective_from DESC
     LIMIT 1;
    INSERT INTO pricing.fee_revisions (
      fee_revision_id, tenant_id, legal_entity_id, fee_id,
      revision_number, amount, currency_code, previous_revision_id,
      corrected_revision_id, transition_kind, action_invocation_id, acting_principal_id, reason
    ) VALUES (
      v_new_revision_id, p_tenant_id, p_legal_entity_id, v_fee_id,
      v_new_revision_number, v_amount, v_currency, v_previous_revision_id,
      NULL, 'SCHEDULED', v_action_invocation_id, v_acting_principal_id, v_reason
    );
  END IF;

  INSERT INTO pricing.fee_schedule_revisions (
    fee_schedule_revision_id, tenant_id, legal_entity_id, fee_id,
    schedule_revision, previous_schedule_revision_id, action_invocation_id, acting_principal_id, reason
  ) VALUES (
    v_new_schedule_revision_id, p_tenant_id, p_legal_entity_id, v_fee_id,
    v_new_schedule_revision, v_head_revision_id, v_action_invocation_id, v_acting_principal_id, v_reason
  );
  INSERT INTO pricing.fee_schedule_entries (
    tenant_id, legal_entity_id, fee_id, fee_revision_id,
    fee_schedule_revision_id, schedule_revision, effective_from, effective_to
  )
  SELECT entry.tenant_id, entry.legal_entity_id, entry.fee_id,
         CASE WHEN v_intent = 'VALUE_ONLY_CURRENT'
                   AND entry.fee_schedule_entry_id = v_current_entry_id
              THEN v_new_revision_id ELSE entry.fee_revision_id END,
         v_new_schedule_revision_id, v_new_schedule_revision, entry.effective_from, entry.effective_to
    FROM pricing.fee_schedule_entries AS entry
   WHERE entry.tenant_id = p_tenant_id
     AND entry.legal_entity_id = p_legal_entity_id
     AND entry.fee_id = v_fee_id
     AND entry.fee_schedule_revision_id = v_head_revision_id;
  IF v_intent = 'SCHEDULE_REVISION' THEN
    INSERT INTO pricing.fee_schedule_entries (
      tenant_id, legal_entity_id, fee_id, fee_revision_id,
      fee_schedule_revision_id, schedule_revision, effective_from, effective_to
    ) VALUES (
      p_tenant_id, p_legal_entity_id, v_fee_id, v_new_revision_id,
      v_new_schedule_revision_id, v_new_schedule_revision, v_effective_from, v_effective_to
    );
  END IF;
  IF v_intent = 'VALUE_ONLY_CURRENT' AND v_supplied_ack IS NOT NULL THEN
    INSERT INTO pricing.fee_schedule_acknowledgements (
      tenant_id, legal_entity_id, fee_id,
      fingerprint, acknowledgement, issued_by_principal_id
    ) VALUES (
      p_tenant_id, p_legal_entity_id, v_fee_id,
      v_ack_fingerprint, v_ack, v_acting_principal_id
    );
  END IF;
  UPDATE pricing.fee_schedule_heads
     SET fee_schedule_revision_id = v_new_schedule_revision_id,
         schedule_revision = v_new_schedule_revision
   WHERE tenant_id = p_tenant_id
     AND legal_entity_id = p_legal_entity_id
     AND fee_id = v_fee_id
     AND fee_schedule_revision_id = v_head_revision_id
     AND schedule_revision = v_schedule_revision;
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count <> 1 THEN
    RAISE EXCEPTION 'Pricing Commercial Fee schedule CAS failed' USING ERRCODE = '40001';
  END IF;

  SELECT result.payload INTO v_schedule_result
    FROM pricing.read_commercial_fee_schedule_v1(
      p_tenant_id, p_legal_entity_id,
      jsonb_build_object('identityKey', v_identity, 'trustedOperationAt', p_input ->> 'trustedOperationAt')
    ) AS result;
  RETURN QUERY SELECT jsonb_build_object(
    'outcome', 'COMMERCIAL_FEE_REVISED',
    'schedule', v_schedule_result -> 'schedule'
  );
END;
$function$;

REVOKE ALL ON FUNCTION pricing.fee_identity_json_v1(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.scheduled_fee_revision_json_v1(
  uuid, uuid, uuid, uuid, timestamptz, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.fee_id_for_identity_v1(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.define_commercial_fee_v1(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.read_current_commercial_fee_v1(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.read_commercial_fee_schedule_v1(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.revise_commercial_fee_v1(uuid, uuid, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION pricing.fee_identity_json_v1(uuid, uuid, uuid) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.scheduled_fee_revision_json_v1(
  uuid, uuid, uuid, uuid, timestamptz, timestamptz
) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.fee_id_for_identity_v1(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.define_commercial_fee_v1(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.read_current_commercial_fee_v1(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.read_commercial_fee_schedule_v1(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.revise_commercial_fee_v1(uuid, uuid, jsonb) TO ontos_runtime;

GRANT SELECT, INSERT ON TABLE pricing.fees,
  pricing.fee_revisions,
  pricing.fee_schedule_revisions,
  pricing.fee_schedule_entries,
  pricing.fee_schedule_acknowledgements
TO ontos_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE pricing.fee_schedule_heads TO ontos_runtime;
