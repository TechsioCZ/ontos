-- #766 Quantity Tier runtime. Stable Tier identities are Price-owned; only schedule heads mutate.
CREATE EXTENSION IF NOT EXISTS "btree_gist" WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA public;

ALTER TABLE pricing.quantity_tiers FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.quantity_tier_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.quantity_tier_schedule_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.quantity_tier_schedule_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.quantity_tier_schedule_acknowledgements FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.quantity_tier_schedule_heads FORCE ROW LEVEL SECURITY;

ALTER TABLE pricing.quantity_tier_schedule_entries
  ADD CONSTRAINT pricing_quantity_tier_schedule_entries_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    legal_entity_id WITH =,
    quantity_tier_id WITH =,
    quantity_tier_schedule_revision_id WITH =,
    pg_catalog.tstzrange(effective_from, effective_to, '[)') WITH &&
  );

CREATE FUNCTION pricing.quantity_tier_identity_json_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_quantity_tier_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT jsonb_build_object(
    'priceRef', jsonb_build_object(
      'moduleId', 'commerce.pricing',
      'resourceId', tier.price_id::text,
      'resourceType', 'commerce.pricing.price',
      'tenantId', tier.tenant_id::text
    ),
    'quantityBasis', jsonb_build_object(
      'catalogQuantityBasis', tier.catalog_quantity_basis,
      'priceUnitBasis', jsonb_build_object(
        'quantity', tier.price_basis_quantity::text,
        'unitRef', tier.price_unit_ref
      )
    ),
    'thresholdQuantity', tier.threshold_quantity::text
  )
    FROM pricing.quantity_tiers AS tier
   WHERE tier.tenant_id = p_tenant_id
     AND tier.legal_entity_id = p_legal_entity_id
     AND tier.quantity_tier_id = p_quantity_tier_id
$function$;

CREATE OR REPLACE FUNCTION pricing.define_quantity_tier_v1(
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
  v_price_id uuid;
  v_quantity_tier_id uuid;
  v_quantity_tier_revision_id uuid;
  v_quantity_tier_schedule_revision_id uuid;
  v_threshold_text text;
  v_threshold numeric(38,9);
  v_price_basis_text text;
  v_price_basis numeric(38,9);
  v_amount_text text;
  v_amount numeric(38,9);
  v_effective_from timestamptz;
  v_effective_to timestamptz;
  v_currency text;
  v_catalog_basis jsonb;
  v_unit_ref jsonb;
  v_reason text;
  v_request_correlation text;
  v_price record;
  v_existing record;
  v_definition jsonb;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Pricing Quantity Tier write scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_input IS NULL OR jsonb_typeof(p_input) <> 'object' OR jsonb_typeof(v_identity) <> 'object' THEN
    RAISE EXCEPTION 'Pricing Quantity Tier write input is invalid' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_action_invocation_id := (p_input ->> 'actionInvocationId')::uuid;
    v_acting_principal_id := (p_input ->> 'actingPrincipalId')::uuid;
    v_price_id := (v_identity #>> '{priceRef,resourceId}')::uuid;
    v_effective_from := (p_input #>> '{effectivePeriod,effectiveFrom}')::timestamptz;
    IF p_input #> '{effectivePeriod,effectiveTo}' <> 'null'::jsonb THEN
      v_effective_to := (p_input #>> '{effectivePeriod,effectiveTo}')::timestamptz;
    END IF;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Pricing Quantity Tier write input is invalid' USING ERRCODE = '22023';
  END;
  v_threshold_text := v_identity ->> 'thresholdQuantity';
  v_price_basis_text := v_identity #>> '{quantityBasis,priceUnitBasis,quantity}';
  v_amount_text := p_input #>> '{resultingUnitPrice,amount}';
  IF v_threshold_text IS NULL OR v_threshold_text !~ '^(0|[1-9][0-9]{0,28})(\.[0-9]{1,9})?$'
    OR v_price_basis_text IS NULL OR v_price_basis_text !~ '^(0|[1-9][0-9]{0,28})(\.[0-9]{1,9})?$'
    OR v_amount_text IS NULL OR v_amount_text !~ '^(0|[1-9][0-9]{0,28})(\.[0-9]{1,9})?$'
  THEN
    RAISE EXCEPTION 'Pricing Quantity Tier decimal input is invalid' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_threshold := v_threshold_text::numeric(38,9);
    v_price_basis := v_price_basis_text::numeric(38,9);
    v_amount := v_amount_text::numeric(38,9);
  EXCEPTION WHEN numeric_value_out_of_range THEN
    RAISE EXCEPTION 'Pricing Quantity Tier decimal input is invalid' USING ERRCODE = '22023';
  END;
  v_currency := p_input #>> '{resultingUnitPrice,currencyCode}';
  v_catalog_basis := v_identity #> '{quantityBasis,catalogQuantityBasis}';
  v_unit_ref := v_identity #> '{quantityBasis,priceUnitBasis,unitRef}';
  v_reason := p_input ->> 'reason';
  v_request_correlation := p_input ->> 'requestCorrelationId';

  IF v_action_invocation_id IS NULL OR v_acting_principal_id IS NULL OR v_price_id IS NULL
    OR v_threshold <= 0 OR v_price_basis <= 0 OR v_amount < 0
    OR v_effective_from IS NULL OR (v_effective_to IS NOT NULL AND v_effective_to <= v_effective_from)
    OR v_currency !~ '^[A-Z]{3}$'
    OR jsonb_typeof(v_catalog_basis) <> 'object' OR jsonb_typeof(v_unit_ref) <> 'object'
    OR v_catalog_basis -> 'unitRef' IS DISTINCT FROM v_unit_ref
    OR v_identity #>> '{priceRef,moduleId}' <> 'commerce.pricing'
    OR v_identity #>> '{priceRef,resourceType}' <> 'commerce.pricing.price'
    OR v_identity #>> '{priceRef,tenantId}' <> p_tenant_id::text
    OR v_catalog_basis #>> '{targetRef,tenantId}' <> p_tenant_id::text
    OR v_catalog_basis #>> '{unitRef,tenantId}' <> p_tenant_id::text
    OR v_reason IS NULL OR v_reason <> btrim(v_reason) OR length(v_reason) NOT BETWEEN 1 AND 1000
    OR v_request_correlation IS NULL OR v_request_correlation <> btrim(v_request_correlation)
    OR length(v_request_correlation) NOT BETWEEN 1 AND 500
  THEN
    RAISE EXCEPTION 'Pricing Quantity Tier write input is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT price.currency_code,
         price.basis_quantity,
         price.unit_ref,
         COALESCE(
           price.catalog_selection #> '{packageOption,optionRef}',
           price.catalog_selection -> 'variantRef'
         ) AS catalog_target_ref
    INTO v_price
    FROM pricing.prices AS price
   WHERE price.tenant_id = p_tenant_id
     AND price.legal_entity_id = p_legal_entity_id
     AND price.price_id = v_price_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT jsonb_build_object(
      'identityKey', v_identity,
      'outcome', 'QUANTITY_TIER_CONFLICT',
      'reason', 'PRICE_NOT_FOUND'
    );
    RETURN;
  END IF;
  IF v_price.currency_code IS DISTINCT FROM v_currency
    OR v_price.basis_quantity IS DISTINCT FROM v_price_basis
    OR v_price.unit_ref IS DISTINCT FROM v_unit_ref
    OR v_price.catalog_target_ref IS DISTINCT FROM (v_catalog_basis -> 'targetRef')
  THEN
    RETURN QUERY SELECT jsonb_build_object(
      'identityKey', v_identity,
      'outcome', 'QUANTITY_TIER_CONFLICT',
      'reason', 'IDENTITY_MISMATCH'
    );
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_tenant_id::text || ':' || p_legal_entity_id::text || ':' || v_identity::text, 0)
  );
  SELECT tier.quantity_tier_id,
         revision.quantity_tier_revision_id,
         revision.resulting_amount,
         revision.currency_code,
         entry.effective_from,
         entry.effective_to
    INTO v_existing
    FROM pricing.quantity_tiers AS tier
    JOIN pricing.quantity_tier_revisions AS revision
      ON revision.tenant_id = tier.tenant_id
     AND revision.legal_entity_id = tier.legal_entity_id
     AND revision.quantity_tier_id = tier.quantity_tier_id
    JOIN pricing.quantity_tier_schedule_entries AS entry
      ON entry.tenant_id = revision.tenant_id
     AND entry.legal_entity_id = revision.legal_entity_id
     AND entry.quantity_tier_id = revision.quantity_tier_id
     AND entry.quantity_tier_revision_id = revision.quantity_tier_revision_id
   WHERE tier.tenant_id = p_tenant_id
     AND tier.legal_entity_id = p_legal_entity_id
     AND tier.price_id = v_price_id
     AND tier.threshold_quantity = v_threshold
     AND tier.catalog_quantity_basis = v_catalog_basis
     AND tier.price_basis_quantity = v_price_basis
     AND tier.price_unit_ref = v_unit_ref
     AND revision.action_invocation_id = v_action_invocation_id;
  IF FOUND THEN
    IF v_existing.resulting_amount IS DISTINCT FROM v_amount
      OR v_existing.currency_code IS DISTINCT FROM v_currency
      OR v_existing.effective_from IS DISTINCT FROM v_effective_from
      OR v_existing.effective_to IS DISTINCT FROM v_effective_to
    THEN
      RETURN QUERY SELECT jsonb_build_object(
        'identityKey', v_identity,
        'outcome', 'QUANTITY_TIER_CONFLICT',
        'reason', 'IDENTITY_MISMATCH'
      );
      RETURN;
    END IF;
    v_definition := pricing.scheduled_quantity_tier_revision_json_v1(
      p_tenant_id, p_legal_entity_id, v_existing.quantity_tier_id,
      v_existing.quantity_tier_revision_id, v_existing.effective_from, v_existing.effective_to
    ) -> 'definition';
    RETURN QUERY SELECT jsonb_build_object('definition', v_definition, 'outcome', 'QUANTITY_TIER_REUSED');
    RETURN;
  END IF;
  IF pricing.quantity_tier_id_for_identity_v1(p_tenant_id, p_legal_entity_id, v_identity) IS NOT NULL THEN
    RETURN QUERY SELECT jsonb_build_object(
      'identityKey', pricing.quantity_tier_identity_json_v1(
        p_tenant_id,
        p_legal_entity_id,
        pricing.quantity_tier_id_for_identity_v1(p_tenant_id, p_legal_entity_id, v_identity)
      ),
      'outcome', 'QUANTITY_TIER_CONFLICT',
      'reason', 'IDENTITY_MISMATCH'
    );
    RETURN;
  END IF;

  v_quantity_tier_id := pg_catalog.gen_random_uuid();
  v_quantity_tier_revision_id := pg_catalog.gen_random_uuid();
  v_quantity_tier_schedule_revision_id := pg_catalog.gen_random_uuid();
  INSERT INTO pricing.quantity_tiers (
    quantity_tier_id, tenant_id, legal_entity_id, price_id, threshold_quantity,
    catalog_quantity_basis, price_currency_code, price_basis_quantity, price_unit_ref,
    created_by_action_invocation_id, created_by_principal_id
  ) VALUES (
    v_quantity_tier_id, p_tenant_id, p_legal_entity_id, v_price_id, v_threshold,
    v_catalog_basis, v_currency, v_price_basis, v_unit_ref,
    v_action_invocation_id, v_acting_principal_id
  );
  INSERT INTO pricing.quantity_tier_revisions (
    quantity_tier_revision_id, tenant_id, legal_entity_id, price_id, quantity_tier_id,
    revision_number, resulting_amount, currency_code, previous_revision_id,
    corrected_revision_id, transition_kind, action_invocation_id, acting_principal_id, reason
  ) VALUES (
    v_quantity_tier_revision_id, p_tenant_id, p_legal_entity_id, v_price_id, v_quantity_tier_id,
    1, v_amount, v_currency, NULL, NULL, 'INITIAL',
    v_action_invocation_id, v_acting_principal_id, v_reason
  );
  INSERT INTO pricing.quantity_tier_schedule_revisions (
    quantity_tier_schedule_revision_id, tenant_id, legal_entity_id, price_id, quantity_tier_id,
    schedule_revision, previous_schedule_revision_id, action_invocation_id, acting_principal_id, reason
  ) VALUES (
    v_quantity_tier_schedule_revision_id, p_tenant_id, p_legal_entity_id, v_price_id, v_quantity_tier_id,
    1, NULL, v_action_invocation_id, v_acting_principal_id, v_reason
  );
  INSERT INTO pricing.quantity_tier_schedule_entries (
    tenant_id, legal_entity_id, price_id, quantity_tier_id, quantity_tier_revision_id,
    quantity_tier_schedule_revision_id, schedule_revision, effective_from, effective_to
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_price_id, v_quantity_tier_id, v_quantity_tier_revision_id,
    v_quantity_tier_schedule_revision_id, 1, v_effective_from, v_effective_to
  );
  INSERT INTO pricing.quantity_tier_schedule_heads (
    tenant_id, legal_entity_id, price_id, quantity_tier_id,
    quantity_tier_schedule_revision_id, schedule_revision
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_price_id, v_quantity_tier_id,
    v_quantity_tier_schedule_revision_id, 1
  );
  v_definition := pricing.scheduled_quantity_tier_revision_json_v1(
    p_tenant_id, p_legal_entity_id, v_quantity_tier_id,
    v_quantity_tier_revision_id, v_effective_from, v_effective_to
  ) -> 'definition';
  RETURN QUERY SELECT jsonb_build_object('definition', v_definition, 'outcome', 'QUANTITY_TIER_CREATED');
END;
$function$;

CREATE FUNCTION pricing.scheduled_quantity_tier_revision_json_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_quantity_tier_id uuid,
  p_quantity_tier_revision_id uuid,
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
      'identityKey', pricing.quantity_tier_identity_json_v1(
        p_tenant_id, p_legal_entity_id, p_quantity_tier_id
      ),
      'revision', jsonb_build_object(
        'effectiveFrom', to_char(p_effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'monetaryBoundary', 'PRE_TAX',
        'resultingUnitPrice', jsonb_build_object(
          'amount', revision.resulting_amount::text,
          'currencyCode', revision.currency_code
        ),
        'revision', revision.revision_number,
        'revisionId', revision.quantity_tier_revision_id::text
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
    FROM pricing.quantity_tier_revisions AS revision
   WHERE revision.tenant_id = p_tenant_id
     AND revision.legal_entity_id = p_legal_entity_id
     AND revision.quantity_tier_id = p_quantity_tier_id
     AND revision.quantity_tier_revision_id = p_quantity_tier_revision_id
$function$;

CREATE FUNCTION pricing.quantity_tier_id_for_identity_v1(
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
  SELECT tier.quantity_tier_id
    FROM pricing.quantity_tiers AS tier
   WHERE tier.tenant_id = p_tenant_id
     AND tier.legal_entity_id = p_legal_entity_id
     AND tier.price_id = (p_identity #>> '{priceRef,resourceId}')::uuid
     AND tier.threshold_quantity = (p_identity ->> 'thresholdQuantity')::numeric(38,9)
     AND tier.catalog_quantity_basis = p_identity #> '{quantityBasis,catalogQuantityBasis}'
     AND tier.price_basis_quantity = (p_identity #>> '{quantityBasis,priceUnitBasis,quantity}')::numeric(38,9)
     AND tier.price_unit_ref = p_identity #> '{quantityBasis,priceUnitBasis,unitRef}'
$function$;

CREATE OR REPLACE FUNCTION pricing.read_quantity_tier_schedule_v1(
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
  v_quantity_tier_id uuid;
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
    RAISE EXCEPTION 'Pricing Quantity Tier read scope mismatch' USING ERRCODE = '42501';
  END IF;
  BEGIN
    v_observed_at := (p_input ->> 'trustedOperationAt')::timestamptz;
    v_quantity_tier_id := pricing.quantity_tier_id_for_identity_v1(
      p_tenant_id, p_legal_entity_id, v_identity
    );
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Pricing Quantity Tier read input is invalid' USING ERRCODE = '22023';
  END;
  IF v_observed_at IS NULL OR jsonb_typeof(v_identity) <> 'object' THEN
    RAISE EXCEPTION 'Pricing Quantity Tier read input is invalid' USING ERRCODE = '22023';
  END IF;
  IF v_quantity_tier_id IS NULL THEN
    RETURN QUERY SELECT jsonb_build_object(
      'identityKey', v_identity,
      'outcome', 'QUANTITY_TIER_SCHEDULE_ABSENT'
    );
    RETURN;
  END IF;

  SELECT head.quantity_tier_schedule_revision_id, head.schedule_revision
    INTO v_head_revision_id, v_schedule_revision
    FROM pricing.quantity_tier_schedule_heads AS head
   WHERE head.tenant_id = p_tenant_id
     AND head.legal_entity_id = p_legal_entity_id
     AND head.quantity_tier_id = v_quantity_tier_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT jsonb_build_object(
      'identityKey', pricing.quantity_tier_identity_json_v1(
        p_tenant_id, p_legal_entity_id, v_quantity_tier_id
      ),
      'outcome', 'QUANTITY_TIER_SCHEDULE_ABSENT'
    );
    RETURN;
  END IF;

  SELECT count(*)::integer,
         coalesce(jsonb_agg(entry.quantity_tier_revision_id::text ORDER BY entry.effective_from), '[]'::jsonb),
         min(pricing.scheduled_quantity_tier_revision_json_v1(
           p_tenant_id, p_legal_entity_id, v_quantity_tier_id,
           entry.quantity_tier_revision_id, entry.effective_from, entry.effective_to
         )::text)::jsonb
    INTO v_current_count, v_candidate_ids, v_current
    FROM pricing.quantity_tier_schedule_entries AS entry
   WHERE entry.tenant_id = p_tenant_id
     AND entry.legal_entity_id = p_legal_entity_id
     AND entry.quantity_tier_id = v_quantity_tier_id
     AND entry.quantity_tier_schedule_revision_id = v_head_revision_id
     AND entry.effective_from <= v_observed_at
     AND (entry.effective_to IS NULL OR v_observed_at < entry.effective_to);
  IF v_current_count > 1 THEN
    RETURN QUERY SELECT jsonb_build_object(
      'candidateRevisionIds', v_candidate_ids,
      'identityKey', pricing.quantity_tier_identity_json_v1(
        p_tenant_id, p_legal_entity_id, v_quantity_tier_id
      ),
      'outcome', 'QUANTITY_TIER_SCHEDULE_CONFLICT'
    );
    RETURN;
  END IF;

  SELECT coalesce(jsonb_agg(
           pricing.scheduled_quantity_tier_revision_json_v1(
             p_tenant_id, p_legal_entity_id, v_quantity_tier_id,
             entry.quantity_tier_revision_id, entry.effective_from, entry.effective_to
           ) ORDER BY entry.effective_from, entry.quantity_tier_revision_id
         ), '[]'::jsonb),
         coalesce(jsonb_agg(
           pricing.scheduled_quantity_tier_revision_json_v1(
             p_tenant_id, p_legal_entity_id, v_quantity_tier_id,
             entry.quantity_tier_revision_id, entry.effective_from, entry.effective_to
           ) ORDER BY entry.effective_from, entry.quantity_tier_revision_id
         ) FILTER (WHERE entry.effective_from > v_observed_at), '[]'::jsonb)
    INTO v_revisions, v_future
    FROM pricing.quantity_tier_schedule_entries AS entry
   WHERE entry.tenant_id = p_tenant_id
     AND entry.legal_entity_id = p_legal_entity_id
     AND entry.quantity_tier_id = v_quantity_tier_id
     AND entry.quantity_tier_schedule_revision_id = v_head_revision_id;

  RETURN QUERY SELECT jsonb_build_object(
    'outcome', CASE WHEN v_current_count = 1 THEN
      'QUANTITY_TIER_SCHEDULE_CURRENT' ELSE 'QUANTITY_TIER_SCHEDULE_GAP' END,
    'schedule', jsonb_build_object(
      'future', v_future,
      'identityKey', pricing.quantity_tier_identity_json_v1(
        p_tenant_id, p_legal_entity_id, v_quantity_tier_id
      ),
      'observedAt', to_char(v_observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'revisions', v_revisions,
      'scheduleRevision', v_schedule_revision
    ) || CASE WHEN v_current_count = 1 THEN jsonb_build_object('current', v_current) ELSE '{}'::jsonb END
  );
END;
$function$;

CREATE OR REPLACE FUNCTION pricing.read_current_quantity_tier_v1(
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
    RAISE EXCEPTION 'Pricing Quantity Tier Current input is invalid' USING ERRCODE = '22023';
  END;
  SELECT result.payload INTO v_schedule
    FROM pricing.read_quantity_tier_schedule_v1(
      p_tenant_id,
      p_legal_entity_id,
      jsonb_build_object('identityKey', p_input -> 'identityKey', 'trustedOperationAt', p_input ->> 'effectiveAt')
    ) AS result;
  IF v_schedule ->> 'outcome' = 'QUANTITY_TIER_SCHEDULE_CURRENT' THEN
    RETURN QUERY SELECT jsonb_build_object(
      'current', v_schedule #> '{schedule,current}',
      'observedAt', to_char(v_effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'outcome', 'QUANTITY_TIER_CURRENT',
      'scheduleRevision', v_schedule #> '{schedule,scheduleRevision}'
    );
  ELSIF v_schedule ->> 'outcome' = 'QUANTITY_TIER_SCHEDULE_CONFLICT' THEN
    RETURN QUERY SELECT jsonb_build_object(
      'candidateRevisionIds', v_schedule -> 'candidateRevisionIds',
      'identityKey', v_schedule -> 'identityKey',
      'outcome', 'QUANTITY_TIER_CONFLICT',
      'reason', 'MULTIPLE_CURRENT_REVISIONS'
    );
  ELSE
    RETURN QUERY SELECT jsonb_build_object(
      'identityKey', coalesce(v_schedule #> '{schedule,identityKey}', v_schedule -> 'identityKey', p_input -> 'identityKey'),
      'outcome', 'QUANTITY_TIER_ABSENT'
    );
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION pricing.revise_quantity_tier_v1(
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
  v_quantity_tier_id uuid;
  v_price_id uuid;
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
    RAISE EXCEPTION 'Pricing Quantity Tier revision scope mismatch' USING ERRCODE = '42501';
  END IF;
  BEGIN
    v_action_invocation_id := (p_input ->> 'actionInvocationId')::uuid;
    v_acting_principal_id := (p_input ->> 'actingPrincipalId')::uuid;
    v_trusted_at := (p_input ->> 'trustedOperationAt')::timestamptz;
    v_price_id := (v_identity #>> '{priceRef,resourceId}')::uuid;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Pricing Quantity Tier revision input is invalid' USING ERRCODE = '22023';
  END;
  v_amount_text := p_input #>> '{resultingUnitPrice,amount}';
  IF v_amount_text IS NULL OR v_amount_text !~ '^(0|[1-9][0-9]{0,28})(\.[0-9]{1,9})?$' THEN
    RAISE EXCEPTION 'Pricing Quantity Tier revision amount is invalid' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_amount := v_amount_text::numeric(38,9);
  EXCEPTION WHEN numeric_value_out_of_range THEN
    RAISE EXCEPTION 'Pricing Quantity Tier revision amount is invalid' USING ERRCODE = '22023';
  END;
  v_currency := p_input #>> '{resultingUnitPrice,currencyCode}';
  v_reason := p_input ->> 'reason';
  v_request_correlation := p_input ->> 'requestCorrelationId';
  IF v_action_invocation_id IS NULL OR v_acting_principal_id IS NULL OR v_trusted_at IS NULL
    OR v_price_id IS NULL OR v_amount < 0 OR v_currency !~ '^[A-Z]{3}$'
    OR v_intent NOT IN ('VALUE_ONLY_CURRENT', 'SCHEDULE_REVISION')
    OR v_reason IS NULL OR v_reason <> btrim(v_reason) OR length(v_reason) NOT BETWEEN 1 AND 1000
    OR v_request_correlation IS NULL OR v_request_correlation <> btrim(v_request_correlation)
    OR length(v_request_correlation) NOT BETWEEN 1 AND 500
  THEN
    RAISE EXCEPTION 'Pricing Quantity Tier revision input is invalid' USING ERRCODE = '22023';
  END IF;

  v_quantity_tier_id := pricing.quantity_tier_id_for_identity_v1(
    p_tenant_id, p_legal_entity_id, v_identity
  );
  IF v_quantity_tier_id IS NULL THEN
    RETURN QUERY SELECT jsonb_build_object(
      'identityKey', v_identity,
      'outcome', 'QUANTITY_TIER_CONFLICT',
      'reason', 'IDENTITY_MISMATCH'
    );
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pricing.quantity_tiers AS tier
     WHERE tier.tenant_id = p_tenant_id
       AND tier.legal_entity_id = p_legal_entity_id
       AND tier.quantity_tier_id = v_quantity_tier_id
       AND tier.price_currency_code = v_currency
  ) THEN
    RETURN QUERY SELECT jsonb_build_object(
      'identityKey', pricing.quantity_tier_identity_json_v1(
        p_tenant_id, p_legal_entity_id, v_quantity_tier_id
      ),
      'outcome', 'QUANTITY_TIER_CONFLICT',
      'reason', 'IDENTITY_MISMATCH'
    );
    RETURN;
  END IF;

  SELECT head.quantity_tier_schedule_revision_id, head.schedule_revision
    INTO v_head_revision_id, v_schedule_revision
    FROM pricing.quantity_tier_schedule_heads AS head
   WHERE head.tenant_id = p_tenant_id
     AND head.legal_entity_id = p_legal_entity_id
     AND head.quantity_tier_id = v_quantity_tier_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT jsonb_build_object(
      'identityKey', v_identity,
      'outcome', 'QUANTITY_TIER_CONFLICT',
      'reason', 'IDENTITY_MISMATCH'
    );
    RETURN;
  END IF;
  v_new_schedule_revision := v_schedule_revision + 1;
  SELECT max(revision.revision_number) + 1
    INTO v_new_revision_number
    FROM pricing.quantity_tier_revisions AS revision
   WHERE revision.tenant_id = p_tenant_id
     AND revision.legal_entity_id = p_legal_entity_id
     AND revision.quantity_tier_id = v_quantity_tier_id;

  IF EXISTS (
    SELECT 1 FROM pricing.quantity_tier_revisions AS revision
     WHERE revision.tenant_id = p_tenant_id
       AND revision.action_invocation_id = v_action_invocation_id
  ) THEN
    SELECT result.payload INTO v_schedule_result
      FROM pricing.read_quantity_tier_schedule_v1(
        p_tenant_id, p_legal_entity_id,
        jsonb_build_object('identityKey', v_identity, 'trustedOperationAt', p_input ->> 'trustedOperationAt')
      ) AS result;
    RETURN QUERY SELECT jsonb_build_object(
      'outcome', 'QUANTITY_TIER_UNCHANGED',
      'schedule', v_schedule_result -> 'schedule'
    );
    RETURN;
  END IF;

  IF v_intent = 'VALUE_ONLY_CURRENT' THEN
    SELECT count(*)::integer,
           min(entry.quantity_tier_schedule_entry_id::text)::uuid,
           min(entry.quantity_tier_revision_id::text)::uuid,
           min(revision.revision_number), min(revision.resulting_amount), min(revision.currency_code),
           min(entry.effective_from), min(entry.effective_to)
      INTO v_current_count, v_current_entry_id, v_current_revision_id, v_current_revision_number,
           v_current_amount, v_current_currency, v_current_from, v_current_to
      FROM pricing.quantity_tier_schedule_entries AS entry
      JOIN pricing.quantity_tier_revisions AS revision
        ON revision.tenant_id = entry.tenant_id
       AND revision.legal_entity_id = entry.legal_entity_id
       AND revision.quantity_tier_id = entry.quantity_tier_id
       AND revision.quantity_tier_revision_id = entry.quantity_tier_revision_id
     WHERE entry.tenant_id = p_tenant_id
       AND entry.legal_entity_id = p_legal_entity_id
       AND entry.quantity_tier_id = v_quantity_tier_id
       AND entry.quantity_tier_schedule_revision_id = v_head_revision_id
       AND entry.effective_from <= v_trusted_at
       AND (entry.effective_to IS NULL OR v_trusted_at < entry.effective_to);
    IF v_current_count <> 1 THEN
      RETURN QUERY SELECT jsonb_build_object(
        'identityKey', v_identity,
        'outcome', 'QUANTITY_TIER_CONFLICT',
        'reason', 'EFFECTIVE_BOUNDARY_STALE'
      );
      RETURN;
    END IF;
    IF (p_input #>> '{expectedCurrent,scheduleRevision}')::integer IS DISTINCT FROM v_schedule_revision
      OR (p_input #>> '{expectedCurrent,revision}')::integer IS DISTINCT FROM v_current_revision_number
      OR (p_input #>> '{expectedCurrent,revisionId}')::uuid IS DISTINCT FROM v_current_revision_id
      OR (p_input #>> '{expectedCurrent,effectivePeriod,effectiveFrom}')::timestamptz IS DISTINCT FROM v_current_from
      OR (CASE WHEN p_input #> '{expectedCurrent,effectivePeriod,effectiveTo}' = 'null'::jsonb THEN NULL ELSE
            (p_input #>> '{expectedCurrent,effectivePeriod,effectiveTo}')::timestamptz END) IS DISTINCT FROM v_current_to
      OR pricing.quantity_tier_id_for_identity_v1(
           p_tenant_id, p_legal_entity_id, p_input #> '{expectedCurrent,identityKey}'
         ) IS DISTINCT FROM v_quantity_tier_id
    THEN
      RETURN QUERY SELECT jsonb_build_object(
        'identityKey', pricing.quantity_tier_identity_json_v1(
          p_tenant_id, p_legal_entity_id, v_quantity_tier_id
        ),
        'outcome', 'QUANTITY_TIER_CONFLICT',
        'reason', 'EXPECTED_CURRENT_STALE'
      );
      RETURN;
    END IF;
    SELECT coalesce(jsonb_agg(
             pricing.scheduled_quantity_tier_revision_json_v1(
               p_tenant_id, p_legal_entity_id, v_quantity_tier_id,
               entry.quantity_tier_revision_id, entry.effective_from, entry.effective_to
             ) ORDER BY entry.effective_from, entry.quantity_tier_revision_id
           ), '[]'::jsonb)
      INTO v_future
      FROM pricing.quantity_tier_schedule_entries AS entry
     WHERE entry.tenant_id = p_tenant_id
       AND entry.legal_entity_id = p_legal_entity_id
       AND entry.quantity_tier_id = v_quantity_tier_id
       AND entry.quantity_tier_schedule_revision_id = v_head_revision_id
       AND entry.effective_from > v_trusted_at;

    IF v_current_amount = v_amount AND v_current_currency = v_currency THEN
      SELECT result.payload INTO v_schedule_result
        FROM pricing.read_quantity_tier_schedule_v1(
          p_tenant_id, p_legal_entity_id,
          jsonb_build_object('identityKey', v_identity, 'trustedOperationAt', p_input ->> 'trustedOperationAt')
        ) AS result;
      RETURN QUERY SELECT jsonb_build_object(
        'outcome', 'QUANTITY_TIER_UNCHANGED',
        'schedule', v_schedule_result -> 'schedule'
      );
      RETURN;
    END IF;

    v_ack_body := jsonb_build_object(
      'actingPrincipalId', v_acting_principal_id::text,
      'identityKey', pricing.quantity_tier_identity_json_v1(
        p_tenant_id, p_legal_entity_id, v_quantity_tier_id
      ),
      'intendedEffectivePeriod', jsonb_build_object(
        'effectiveFrom', to_char(v_current_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'effectiveTo', CASE WHEN v_current_to IS NULL THEN NULL ELSE
          to_char(v_current_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
      ),
      'intendedResultingUnitPrice', jsonb_build_object(
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
        'outcome', 'QUANTITY_TIER_ACKNOWLEDGEMENT_REQUIRED'
      );
      RETURN;
    END IF;
    IF v_supplied_ack IS NOT NULL AND v_supplied_ack IS DISTINCT FROM v_ack THEN
      RETURN QUERY SELECT jsonb_build_object(
        'identityKey', pricing.quantity_tier_identity_json_v1(
          p_tenant_id, p_legal_entity_id, v_quantity_tier_id
        ),
        'outcome', 'QUANTITY_TIER_CONFLICT',
        'reason', 'ACKNOWLEDGEMENT_STALE'
      );
      RETURN;
    END IF;

    INSERT INTO pricing.quantity_tier_revisions (
      quantity_tier_revision_id, tenant_id, legal_entity_id, price_id, quantity_tier_id,
      revision_number, resulting_amount, currency_code, previous_revision_id,
      corrected_revision_id, transition_kind, action_invocation_id, acting_principal_id, reason
    ) VALUES (
      v_new_revision_id, p_tenant_id, p_legal_entity_id, v_price_id, v_quantity_tier_id,
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
      RAISE EXCEPTION 'Pricing Quantity Tier scheduled period is invalid' USING ERRCODE = '22023';
    END;
    IF (p_input ->> 'expectedScheduleRevision')::integer IS DISTINCT FROM v_schedule_revision THEN
      RETURN QUERY SELECT jsonb_build_object(
        'identityKey', v_identity,
        'outcome', 'QUANTITY_TIER_CONFLICT',
        'reason', 'EXPECTED_SCHEDULE_STALE'
      );
      RETURN;
    END IF;
    IF v_effective_from IS NULL OR (v_effective_to IS NOT NULL AND v_effective_to <= v_effective_from) THEN
      RAISE EXCEPTION 'Pricing Quantity Tier scheduled period is invalid' USING ERRCODE = '22023';
    END IF;
    SELECT count(*)::integer INTO v_overlap_count
      FROM pricing.quantity_tier_schedule_entries AS entry
     WHERE entry.tenant_id = p_tenant_id
       AND entry.legal_entity_id = p_legal_entity_id
       AND entry.quantity_tier_id = v_quantity_tier_id
       AND entry.quantity_tier_schedule_revision_id = v_head_revision_id
       AND pg_catalog.tstzrange(entry.effective_from, entry.effective_to, '[)') &&
           pg_catalog.tstzrange(v_effective_from, v_effective_to, '[)');
    IF v_overlap_count > 0 THEN
      RETURN QUERY SELECT jsonb_build_object(
        'identityKey', v_identity,
        'outcome', 'QUANTITY_TIER_CONFLICT',
        'reason', 'OVERLAPPING_SCHEDULE'
      );
      RETURN;
    END IF;
    SELECT revision.quantity_tier_revision_id, revision.revision_number
      INTO v_previous_revision_id, v_previous_revision_number
      FROM pricing.quantity_tier_schedule_entries AS entry
      JOIN pricing.quantity_tier_revisions AS revision
        ON revision.tenant_id = entry.tenant_id
       AND revision.legal_entity_id = entry.legal_entity_id
       AND revision.quantity_tier_id = entry.quantity_tier_id
       AND revision.quantity_tier_revision_id = entry.quantity_tier_revision_id
     WHERE entry.tenant_id = p_tenant_id
       AND entry.legal_entity_id = p_legal_entity_id
       AND entry.quantity_tier_id = v_quantity_tier_id
       AND entry.quantity_tier_schedule_revision_id = v_head_revision_id
     ORDER BY entry.effective_from DESC
     LIMIT 1;
    INSERT INTO pricing.quantity_tier_revisions (
      quantity_tier_revision_id, tenant_id, legal_entity_id, price_id, quantity_tier_id,
      revision_number, resulting_amount, currency_code, previous_revision_id,
      corrected_revision_id, transition_kind, action_invocation_id, acting_principal_id, reason
    ) VALUES (
      v_new_revision_id, p_tenant_id, p_legal_entity_id, v_price_id, v_quantity_tier_id,
      v_new_revision_number, v_amount, v_currency, v_previous_revision_id,
      NULL, 'SCHEDULED', v_action_invocation_id, v_acting_principal_id, v_reason
    );
  END IF;

  INSERT INTO pricing.quantity_tier_schedule_revisions (
    quantity_tier_schedule_revision_id, tenant_id, legal_entity_id, price_id, quantity_tier_id,
    schedule_revision, previous_schedule_revision_id, action_invocation_id, acting_principal_id, reason
  ) VALUES (
    v_new_schedule_revision_id, p_tenant_id, p_legal_entity_id, v_price_id, v_quantity_tier_id,
    v_new_schedule_revision, v_head_revision_id, v_action_invocation_id, v_acting_principal_id, v_reason
  );
  INSERT INTO pricing.quantity_tier_schedule_entries (
    tenant_id, legal_entity_id, price_id, quantity_tier_id, quantity_tier_revision_id,
    quantity_tier_schedule_revision_id, schedule_revision, effective_from, effective_to
  )
  SELECT entry.tenant_id, entry.legal_entity_id, entry.price_id, entry.quantity_tier_id,
         CASE WHEN v_intent = 'VALUE_ONLY_CURRENT'
                   AND entry.quantity_tier_schedule_entry_id = v_current_entry_id
              THEN v_new_revision_id ELSE entry.quantity_tier_revision_id END,
         v_new_schedule_revision_id, v_new_schedule_revision, entry.effective_from, entry.effective_to
    FROM pricing.quantity_tier_schedule_entries AS entry
   WHERE entry.tenant_id = p_tenant_id
     AND entry.legal_entity_id = p_legal_entity_id
     AND entry.quantity_tier_id = v_quantity_tier_id
     AND entry.quantity_tier_schedule_revision_id = v_head_revision_id;
  IF v_intent = 'SCHEDULE_REVISION' THEN
    INSERT INTO pricing.quantity_tier_schedule_entries (
      tenant_id, legal_entity_id, price_id, quantity_tier_id, quantity_tier_revision_id,
      quantity_tier_schedule_revision_id, schedule_revision, effective_from, effective_to
    ) VALUES (
      p_tenant_id, p_legal_entity_id, v_price_id, v_quantity_tier_id, v_new_revision_id,
      v_new_schedule_revision_id, v_new_schedule_revision, v_effective_from, v_effective_to
    );
  END IF;
  IF v_intent = 'VALUE_ONLY_CURRENT' AND v_supplied_ack IS NOT NULL THEN
    INSERT INTO pricing.quantity_tier_schedule_acknowledgements (
      tenant_id, legal_entity_id, price_id, quantity_tier_id,
      fingerprint, acknowledgement, issued_by_principal_id
    ) VALUES (
      p_tenant_id, p_legal_entity_id, v_price_id, v_quantity_tier_id,
      v_ack_fingerprint, v_ack, v_acting_principal_id
    );
  END IF;
  UPDATE pricing.quantity_tier_schedule_heads
     SET quantity_tier_schedule_revision_id = v_new_schedule_revision_id,
         schedule_revision = v_new_schedule_revision
   WHERE tenant_id = p_tenant_id
     AND legal_entity_id = p_legal_entity_id
     AND quantity_tier_id = v_quantity_tier_id
     AND quantity_tier_schedule_revision_id = v_head_revision_id
     AND schedule_revision = v_schedule_revision;
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count <> 1 THEN
    RAISE EXCEPTION 'Pricing Quantity Tier schedule CAS failed' USING ERRCODE = '40001';
  END IF;

  SELECT result.payload INTO v_schedule_result
    FROM pricing.read_quantity_tier_schedule_v1(
      p_tenant_id, p_legal_entity_id,
      jsonb_build_object('identityKey', v_identity, 'trustedOperationAt', p_input ->> 'trustedOperationAt')
    ) AS result;
  RETURN QUERY SELECT jsonb_build_object(
    'outcome', 'QUANTITY_TIER_REVISED',
    'schedule', v_schedule_result -> 'schedule'
  );
END;
$function$;

REVOKE ALL ON FUNCTION pricing.quantity_tier_identity_json_v1(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.scheduled_quantity_tier_revision_json_v1(
  uuid, uuid, uuid, uuid, timestamptz, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.quantity_tier_id_for_identity_v1(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.define_quantity_tier_v1(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.read_current_quantity_tier_v1(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.read_quantity_tier_schedule_v1(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.revise_quantity_tier_v1(uuid, uuid, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION pricing.quantity_tier_identity_json_v1(uuid, uuid, uuid) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.scheduled_quantity_tier_revision_json_v1(
  uuid, uuid, uuid, uuid, timestamptz, timestamptz
) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.quantity_tier_id_for_identity_v1(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.define_quantity_tier_v1(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.read_current_quantity_tier_v1(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.read_quantity_tier_schedule_v1(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.revise_quantity_tier_v1(uuid, uuid, jsonb) TO ontos_runtime;

GRANT SELECT, INSERT ON TABLE pricing.quantity_tiers,
  pricing.quantity_tier_revisions,
  pricing.quantity_tier_schedule_revisions,
  pricing.quantity_tier_schedule_entries,
  pricing.quantity_tier_schedule_acknowledgements
TO ontos_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE pricing.quantity_tier_schedule_heads TO ontos_runtime;
