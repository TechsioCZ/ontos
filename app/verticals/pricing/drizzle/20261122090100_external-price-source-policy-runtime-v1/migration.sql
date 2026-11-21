-- Standing external Price source policies. One verified policy names the source authority and mapping contract
-- that may assert every Price key of one commercial scope, currency and unit basis whose Price Group selector it
-- covers, so a new ERP item no longer needs its own exact-key grant. Pricing resolves the policy itself when a
-- source Price is defined or revised; the routines run as the scoped runtime role under forced RLS.
ALTER TABLE pricing.external_price_source_policies FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pricing.external_price_source_policy_ends FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION pricing.store_external_price_source_policy_v1(
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
  v_source_authority_ref text := p_input #>> '{authority,sourceAuthorityRef}';
  v_source_authority_version text := p_input #>> '{authority,sourceAuthorityVersion}';
  v_mapping_contract_ref text := p_input #>> '{mapping,mappingContractRef}';
  v_mapping_contract_version text := p_input #>> '{mapping,mappingContractVersion}';
  v_channel_id text := p_input #>> '{commercialScope,channelId}';
  v_market_id text := p_input #>> '{commercialScope,marketId}';
  v_currency_code text := p_input ->> 'currencyCode';
  v_unit_id_text text := p_input #>> '{unitBasis,unitRef,resourceId}';
  v_unit_quantity_text text := p_input #>> '{unitBasis,quantity}';
  v_coverage text := p_input #>> '{priceGroupCoverage,kind}';
  v_price_group_id_text text := p_input #>> '{priceGroupCoverage,priceGroupRef,resourceId}';
  v_effective_from_text text := p_input #>> '{effectivePeriod,effectiveFrom}';
  v_effective_to_text text := p_input #>> '{effectivePeriod,effectiveTo}';
  v_verification_ref text := p_input ->> 'verificationRef';
  v_verified_at_text text := p_input ->> 'verifiedAt';
  v_unit_id uuid;
  v_unit_quantity numeric(38,9);
  v_price_group_id uuid;
  v_effective_from timestamptz;
  v_effective_to timestamptz;
  v_verified_at timestamptz;
  v_existing record;
  v_policy_id uuid;
BEGIN
  IF p_tenant_id::text IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')
    OR p_legal_entity_id::text IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')
  THEN
    RAISE EXCEPTION 'Pricing external Price source policy scope mismatch' USING ERRCODE = '42501';
  END IF;

  IF p_input IS NULL
    OR pg_catalog.jsonb_typeof(p_input) <> 'object'
    OR p_input ->> 'family' IS DISTINCT FROM 'PRICE'
    OR p_input ->> 'ownerModuleId' IS DISTINCT FROM 'commerce.pricing'
    OR p_input ->> 'schemaVersion' IS DISTINCT FROM '1'
    OR p_input #>> '{commercialScope,sellingLegalEntityId}' IS DISTINCT FROM p_legal_entity_id::text
    OR p_input #>> '{unitBasis,unitRef,tenantId}' IS DISTINCT FROM p_tenant_id::text
    OR p_input #>> '{unitBasis,unitRef,moduleId}' IS DISTINCT FROM 'commerce.catalog'
    OR p_input #>> '{unitBasis,unitRef,resourceType}' IS DISTINCT FROM 'commerce.catalog.product-unit'
    OR v_unit_id_text IS NULL
    OR v_unit_id_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR v_unit_quantity_text IS NULL
    OR v_unit_quantity_text !~ '^(0|[1-9][0-9]{0,28})(\.[0-9]{1,9})?$'
    OR v_channel_id IS NULL
    OR v_channel_id NOT IN ('B2C', 'B2B')
    OR v_market_id IS NULL
    OR v_currency_code IS NULL
    OR v_currency_code !~ '^[A-Z]{3}$'
    OR v_coverage IS NULL
    OR v_coverage NOT IN ('NO_GROUP', 'PRICE_GROUP', 'ANY_PRICE_GROUP')
    OR (v_coverage = 'PRICE_GROUP' AND (
      p_input #>> '{priceGroupCoverage,priceGroupRef,tenantId}' IS DISTINCT FROM p_tenant_id::text
      OR p_input #>> '{priceGroupCoverage,priceGroupRef,moduleId}' IS DISTINCT FROM 'pricing.price-group-catalog'
      OR p_input #>> '{priceGroupCoverage,priceGroupRef,resourceType}'
        IS DISTINCT FROM 'pricing.price-group-catalog.price-group'
      OR v_price_group_id_text IS NULL
      OR v_price_group_id_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ))
    OR (v_coverage <> 'PRICE_GROUP' AND p_input #> '{priceGroupCoverage,priceGroupRef}' IS NOT NULL)
    OR v_source_authority_ref IS NULL
    OR v_source_authority_version IS NULL
    OR v_mapping_contract_ref IS NULL
    OR v_mapping_contract_version IS NULL
    OR v_verification_ref IS NULL
    OR p_input #> '{effectivePeriod,effectiveTo}' = 'null'::jsonb
    OR v_effective_from_text IS NULL
    OR v_effective_from_text !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
    OR (v_effective_to_text IS NOT NULL AND v_effective_to_text !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$')
    OR v_verified_at_text IS NULL
    OR v_verified_at_text !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
  THEN
    RAISE EXCEPTION 'Pricing external Price source policy is invalid' USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_unit_id := v_unit_id_text::uuid;
    v_unit_quantity := v_unit_quantity_text::numeric(38,9);
    v_price_group_id := CASE WHEN v_coverage = 'PRICE_GROUP' THEN v_price_group_id_text::uuid END;
    v_effective_from := v_effective_from_text::timestamptz;
    v_effective_to := v_effective_to_text::timestamptz;
    v_verified_at := v_verified_at_text::timestamptz;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'Pricing external Price source policy is invalid' USING ERRCODE = '22023';
  END;
  IF v_unit_quantity <= 0 OR (v_effective_to IS NOT NULL AND v_effective_to <= v_effective_from) THEN
    RAISE EXCEPTION 'Pricing external Price source policy is invalid' USING ERRCODE = '22023';
  END IF;

  -- Every policy of one commercial scope, currency and unit is decided under one lock, so two concurrent
  -- operators cannot both store overlapping coverage.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'pricing.external-price-source-policy:' || p_tenant_id::text || ':' || p_legal_entity_id::text || ':'
        || v_channel_id || ':' || v_market_id || ':' || v_currency_code || ':' || v_unit_id::text,
      0
    )
  );

  SELECT policy.policy_id,
         to_char(policy.verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS verified_at
    INTO v_existing
    FROM pricing.external_price_source_policies AS policy
   WHERE policy.tenant_id = p_tenant_id
     AND policy.legal_entity_id = p_legal_entity_id
     AND policy.source_authority_ref = v_source_authority_ref
     AND policy.source_authority_version = v_source_authority_version
     AND policy.mapping_contract_ref = v_mapping_contract_ref
     AND policy.mapping_contract_version = v_mapping_contract_version
     AND policy.channel_id = v_channel_id
     AND policy.market_id = v_market_id
     AND policy.currency_code = v_currency_code
     AND policy.unit_id = v_unit_id
     AND policy.unit_quantity = v_unit_quantity
     AND policy.price_group_coverage = v_coverage
     AND policy.price_group_id IS NOT DISTINCT FROM v_price_group_id
     AND policy.effective_from = v_effective_from
     AND policy.effective_to IS NOT DISTINCT FROM v_effective_to
     AND policy.verification_ref = v_verification_ref
     AND NOT EXISTS (
       SELECT 1
         FROM pricing.external_price_source_policy_ends AS policy_end
        WHERE policy_end.tenant_id = policy.tenant_id
          AND policy_end.legal_entity_id = policy.legal_entity_id
          AND policy_end.policy_id = policy.policy_id
     );
  IF FOUND THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      'outcome', 'REUSED',
      'policyId', v_existing.policy_id::text,
      'verifiedAt', v_existing.verified_at
    );
    RETURN;
  END IF;

  -- Two policies overlap when some Price key and instant fall under both, whatever their authority or mapping:
  -- a key has at most one standing source at a time.
  IF EXISTS (
    SELECT 1
      FROM pricing.external_price_source_policies AS policy
      LEFT JOIN pricing.external_price_source_policy_ends AS policy_end
        ON policy_end.tenant_id = policy.tenant_id
       AND policy_end.legal_entity_id = policy.legal_entity_id
       AND policy_end.policy_id = policy.policy_id
     WHERE policy.tenant_id = p_tenant_id
       AND policy.legal_entity_id = p_legal_entity_id
       AND policy.channel_id = v_channel_id
       AND policy.market_id = v_market_id
       AND policy.currency_code = v_currency_code
       AND policy.unit_id = v_unit_id
       AND policy.unit_quantity = v_unit_quantity
       AND CASE v_coverage
             WHEN 'NO_GROUP' THEN policy.price_group_coverage = 'NO_GROUP'
             WHEN 'PRICE_GROUP' THEN policy.price_group_coverage = 'ANY_PRICE_GROUP'
               OR (policy.price_group_coverage = 'PRICE_GROUP' AND policy.price_group_id = v_price_group_id)
             ELSE policy.price_group_coverage IN ('PRICE_GROUP', 'ANY_PRICE_GROUP')
           END
       AND policy.effective_from < coalesce(v_effective_to, 'infinity'::timestamptz)
       AND v_effective_from < coalesce(LEAST(policy.effective_to, policy_end.effective_to), 'infinity'::timestamptz)
  ) THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object('outcome', 'CONFLICT', 'reason', 'POLICY_OVERLAP');
    RETURN;
  END IF;

  INSERT INTO pricing.external_price_source_policies (
    tenant_id,
    legal_entity_id,
    source_authority_ref,
    source_authority_version,
    mapping_contract_ref,
    mapping_contract_version,
    channel_id,
    market_id,
    currency_code,
    unit_id,
    unit_quantity,
    price_group_coverage,
    price_group_id,
    effective_from,
    effective_to,
    verification_ref,
    verified_at
  ) VALUES (
    p_tenant_id,
    p_legal_entity_id,
    v_source_authority_ref,
    v_source_authority_version,
    v_mapping_contract_ref,
    v_mapping_contract_version,
    v_channel_id,
    v_market_id,
    v_currency_code,
    v_unit_id,
    v_unit_quantity,
    v_coverage,
    v_price_group_id,
    v_effective_from,
    v_effective_to,
    v_verification_ref,
    v_verified_at
  )
  RETURNING policy_id INTO v_policy_id;

  RETURN QUERY SELECT pg_catalog.jsonb_build_object(
    'outcome', 'STORED',
    'policyId', v_policy_id::text,
    'verifiedAt', v_verified_at_text
  );
END
$function$;
--> statement-breakpoint
CREATE FUNCTION pricing.end_external_price_source_policy_v1(
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
  v_policy_id_text text := p_input ->> 'policyId';
  v_effective_to_text text := p_input ->> 'effectiveTo';
  v_ended_at_text text := p_input ->> 'endedAt';
  v_verification_ref text := p_input ->> 'verificationRef';
  v_policy_id uuid;
  v_effective_to timestamptz;
  v_ended_at timestamptz;
  v_policy record;
  v_end record;
BEGIN
  IF p_tenant_id::text IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')
    OR p_legal_entity_id::text IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')
  THEN
    RAISE EXCEPTION 'Pricing external Price source policy scope mismatch' USING ERRCODE = '42501';
  END IF;

  IF p_input IS NULL
    OR pg_catalog.jsonb_typeof(p_input) <> 'object'
    OR v_policy_id_text IS NULL
    OR v_policy_id_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR v_verification_ref IS NULL
    OR v_effective_to_text IS NULL
    OR v_effective_to_text !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
    OR v_ended_at_text IS NULL
    OR v_ended_at_text !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
  THEN
    RAISE EXCEPTION 'Pricing external Price source policy end is invalid' USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_policy_id := v_policy_id_text::uuid;
    v_effective_to := v_effective_to_text::timestamptz;
    v_ended_at := v_ended_at_text::timestamptz;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Pricing external Price source policy end is invalid' USING ERRCODE = '22023';
  END;

  SELECT policy.channel_id, policy.market_id, policy.currency_code, policy.unit_id,
         policy.effective_from, policy.effective_to
    INTO v_policy
    FROM pricing.external_price_source_policies AS policy
   WHERE policy.tenant_id = p_tenant_id
     AND policy.legal_entity_id = p_legal_entity_id
     AND policy.policy_id = v_policy_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object('outcome', 'NOT_FOUND');
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'pricing.external-price-source-policy:' || p_tenant_id::text || ':' || p_legal_entity_id::text || ':'
        || v_policy.channel_id || ':' || v_policy.market_id || ':' || v_policy.currency_code || ':' || v_policy.unit_id::text,
      0
    )
  );

  SELECT policy_end.effective_to, policy_end.verification_ref
    INTO v_end
    FROM pricing.external_price_source_policy_ends AS policy_end
   WHERE policy_end.tenant_id = p_tenant_id
     AND policy_end.legal_entity_id = p_legal_entity_id
     AND policy_end.policy_id = v_policy_id;
  IF FOUND THEN
    IF v_end.effective_to = v_effective_to AND v_end.verification_ref = v_verification_ref THEN
      RETURN QUERY SELECT pg_catalog.jsonb_build_object(
        'effectiveTo', to_char(v_end.effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'outcome', 'REUSED'
      );
    ELSE
      RETURN QUERY SELECT pg_catalog.jsonb_build_object('outcome', 'CONFLICT', 'reason', 'POLICY_ALREADY_ENDED');
    END IF;
    RETURN;
  END IF;

  -- An end never reaches into the past, where the policy may already have authorized accepted Prices, and only
  -- shortens the period: it must fall after the start and before any end the policy was stored with.
  IF v_effective_to < v_ended_at
    OR v_effective_to <= v_policy.effective_from
    OR (v_policy.effective_to IS NOT NULL AND v_effective_to >= v_policy.effective_to)
  THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object('outcome', 'REJECTED', 'reason', 'END_OUTSIDE_PERIOD');
    RETURN;
  END IF;

  INSERT INTO pricing.external_price_source_policy_ends (
    tenant_id,
    legal_entity_id,
    policy_id,
    effective_to,
    verification_ref,
    ended_at
  ) VALUES (
    p_tenant_id,
    p_legal_entity_id,
    v_policy_id,
    v_effective_to,
    v_verification_ref,
    v_ended_at
  );

  RETURN QUERY SELECT pg_catalog.jsonb_build_object('effectiveTo', v_effective_to_text, 'outcome', 'ENDED');
END
$function$;
--> statement-breakpoint
-- The authority lookup keeps deciding by exact-key grant first, unchanged; only when none exists does it resolve a
-- standing policy that covers the key.
CREATE OR REPLACE FUNCTION pricing.assess_external_price_source_authority_v1(
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
  v_identity jsonb := p_input -> 'exactIdentityKey';
  v_source_authority_ref text := p_input #>> '{sourceAssertion,sourceAuthority,sourceAuthorityRef}';
  v_source_authority_version text := p_input #>> '{sourceAssertion,sourceAuthority,sourceAuthorityVersion}';
  v_mapping_contract_ref text := p_input #>> '{sourceAssertion,mapping,mappingContractRef}';
  v_mapping_contract_version text := p_input #>> '{sourceAssertion,mapping,mappingContractVersion}';
  v_effective_at_text text := p_input #>> '{sourceAssertion,timing,ownerBusinessEffectiveAt}';
  v_trusted_operation_at_text text := p_input ->> 'trustedOperationAt';
  v_effective_at timestamptz;
  v_trusted_operation_at timestamptz;
  v_grants jsonb := '[]'::jsonb;
  v_match_count integer := 0;
  v_pass integer;
  v_policies jsonb := '[]'::jsonb;
  v_policy_count integer := 0;
BEGIN
  IF p_tenant_id::text IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')
    OR p_legal_entity_id::text IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')
  THEN
    RAISE EXCEPTION 'Pricing external Price Source Authority scope mismatch' USING ERRCODE = '42501';
  END IF;

  IF p_input IS NULL
    OR pg_catalog.jsonb_typeof(p_input) <> 'object'
    OR p_input ->> 'tenantId' IS DISTINCT FROM p_tenant_id::text
    OR pg_catalog.jsonb_typeof(v_identity) <> 'object'
    OR v_identity #>> '{catalogSelection,productRef,tenantId}' IS DISTINCT FROM p_tenant_id::text
    OR v_identity #>> '{catalogSelection,variantRef,tenantId}' IS DISTINCT FROM p_tenant_id::text
    OR v_identity #>> '{unitBasis,unitRef,tenantId}' IS DISTINCT FROM p_tenant_id::text
    OR v_identity #>> '{unitBasis,quantity}' IS NULL
    OR v_identity #>> '{unitBasis,quantity}' !~ '^(0|[1-9][0-9]{0,28})(\.[0-9]{1,9})?$'
    OR v_identity #>> '{commercialScope,sellingLegalEntityId}' IS DISTINCT FROM p_legal_entity_id::text
    OR v_source_authority_ref IS NULL
    OR v_source_authority_version IS NULL
    OR v_mapping_contract_ref IS NULL
    OR v_mapping_contract_version IS NULL
    OR v_effective_at_text IS NULL
    OR v_effective_at_text !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
    OR v_trusted_operation_at_text IS NULL
    OR v_trusted_operation_at_text !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
  THEN
    RAISE EXCEPTION 'Pricing external Price Source Authority assessment is invalid' USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_effective_at := v_effective_at_text::timestamptz;
    v_trusted_operation_at := v_trusted_operation_at_text::timestamptz;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Pricing external Price Source Authority assessment is invalid' USING ERRCODE = '22023';
  END;

  -- Pass 1 is the exact stored key. Only when no grant is stored for it does pass 2 compare the unit quantity as
  -- a number: Pricing reads a quantity back with nine decimals ("1.000000000"), so a grant stored as "1" names the
  -- same key. Every other part stays exact, and a grant stored for the exact key always decides on its own.
  FOR v_pass IN 1..2 LOOP
    SELECT count(*)::integer,
           coalesce(
             pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'authority', pg_catalog.jsonb_build_object(
                   'sourceAuthorityRef', authority.source_authority_ref,
                   'sourceAuthorityVersion', authority.source_authority_version
                 ),
                 'effectivePeriod', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                   'effectiveFrom', pg_catalog.to_char(
                     authority.effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                   ),
                   'effectiveTo', CASE WHEN authority.effective_to IS NULL THEN NULL ELSE pg_catalog.to_char(
                     authority.effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                   ) END
                 )),
                 'exactIdentityKey', authority.exact_identity_key,
                 'family', 'PRICE',
                 'mapping', pg_catalog.jsonb_build_object(
                   'mappingContractRef', authority.mapping_contract_ref,
                   'mappingContractVersion', authority.mapping_contract_version
                 ),
                 'ownerModuleId', 'commerce.pricing',
                 'schemaVersion', '1',
                 'verificationRef', authority.verification_ref,
                 'verifiedAt', pg_catalog.to_char(
                   authority.verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                 )
               ) ORDER BY authority.effective_from, authority.grant_id
             ),
             '[]'::jsonb
           )
      INTO v_match_count, v_grants
      FROM pricing.external_price_source_authority_grants AS authority
     WHERE authority.tenant_id = p_tenant_id
       AND authority.legal_entity_id = p_legal_entity_id
       AND authority.source_authority_ref = v_source_authority_ref
       AND authority.source_authority_version = v_source_authority_version
       AND authority.mapping_contract_ref = v_mapping_contract_ref
       AND authority.mapping_contract_version = v_mapping_contract_version
       AND CASE WHEN v_pass = 1
             THEN authority.exact_identity_key = v_identity
             ELSE pg_catalog.jsonb_set(
                    authority.exact_identity_key,
                    '{unitBasis,quantity}',
                    pg_catalog.to_jsonb(((authority.exact_identity_key #>> '{unitBasis,quantity}')::numeric(38,9))::text)
                  ) = pg_catalog.jsonb_set(
                    v_identity,
                    '{unitBasis,quantity}',
                    pg_catalog.to_jsonb(((v_identity #>> '{unitBasis,quantity}')::numeric(38,9))::text)
                  )
           END
       AND authority.effective_from <= v_effective_at
       AND (authority.effective_to IS NULL OR v_effective_at < authority.effective_to)
       AND authority.verified_at <= v_trusted_operation_at;
    EXIT WHEN v_match_count > 0;
  END LOOP;

  IF v_match_count = 1 THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      'grant', v_grants -> 0,
      'outcome', 'AUTHORITY_GRANTED'
    );
    RETURN;
  END IF;

  -- Only when no exact-key grant decides does a standing source policy apply. It covers the key when its
  -- authority, mapping, commercial scope, currency and unit basis are exactly the key's and its Price Group
  -- coverage names the key's selector, at the asserted effective time. Store refuses overlapping policies, so
  -- more than one match is ambiguity and stays unresolved.
  IF v_match_count = 0 THEN
    SELECT count(*)::integer,
           coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'authority', pg_catalog.jsonb_build_object(
        'sourceAuthorityRef', policy.source_authority_ref,
        'sourceAuthorityVersion', policy.source_authority_version
      ),
      'commercialScope', pg_catalog.jsonb_build_object(
        'channelId', policy.channel_id,
        'marketId', policy.market_id,
        'sellingLegalEntityId', policy.legal_entity_id::text
      ),
      'currencyCode', policy.currency_code,
      'effectivePeriod', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'effectiveFrom', pg_catalog.to_char(policy.effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'effectiveTo', CASE WHEN LEAST(policy.effective_to, policy_end.effective_to) IS NULL THEN NULL ELSE pg_catalog.to_char(
          LEAST(policy.effective_to, policy_end.effective_to) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) END
      )),
      'family', 'PRICE',
      'mapping', pg_catalog.jsonb_build_object(
        'mappingContractRef', policy.mapping_contract_ref,
        'mappingContractVersion', policy.mapping_contract_version
      ),
      'ownerModuleId', 'commerce.pricing',
      'policyId', policy.policy_id::text,
      'priceGroupCoverage', CASE policy.price_group_coverage
        WHEN 'PRICE_GROUP' THEN pg_catalog.jsonb_build_object(
          'kind', 'PRICE_GROUP',
          'priceGroupRef', pg_catalog.jsonb_build_object(
            'moduleId', 'pricing.price-group-catalog',
            'resourceId', policy.price_group_id::text,
            'resourceType', 'pricing.price-group-catalog.price-group',
            'tenantId', policy.tenant_id::text
          )
        )
        ELSE pg_catalog.jsonb_build_object('kind', policy.price_group_coverage)
      END,
      'schemaVersion', '1',
      'unitBasis', pg_catalog.jsonb_build_object(
        'quantity', policy.unit_quantity::text,
        'unitRef', pg_catalog.jsonb_build_object(
          'moduleId', 'commerce.catalog',
          'resourceId', policy.unit_id::text,
          'resourceType', 'commerce.catalog.product-unit',
          'tenantId', policy.tenant_id::text
        )
      ),
      'verificationRef', policy.verification_ref,
      'verifiedAt', pg_catalog.to_char(policy.verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ) ORDER BY policy.effective_from, policy.policy_id), '[]'::jsonb)
      INTO v_policy_count, v_policies
      FROM pricing.external_price_source_policies AS policy
      LEFT JOIN pricing.external_price_source_policy_ends AS policy_end
        ON policy_end.tenant_id = policy.tenant_id
       AND policy_end.legal_entity_id = policy.legal_entity_id
       AND policy_end.policy_id = policy.policy_id
     WHERE policy.tenant_id = p_tenant_id
       AND policy.legal_entity_id = p_legal_entity_id
       AND policy.source_authority_ref = v_source_authority_ref
       AND policy.source_authority_version = v_source_authority_version
       AND policy.mapping_contract_ref = v_mapping_contract_ref
       AND policy.mapping_contract_version = v_mapping_contract_version
       AND policy.channel_id = v_identity #>> '{commercialScope,channelId}'
       AND policy.market_id = v_identity #>> '{commercialScope,marketId}'
       AND policy.currency_code = v_identity ->> 'currencyCode'
       AND policy.unit_id::text = v_identity #>> '{unitBasis,unitRef,resourceId}'
       AND policy.unit_quantity = (v_identity #>> '{unitBasis,quantity}')::numeric(38,9)
       AND CASE v_identity #>> '{priceGroupSelector,kind}'
             WHEN 'NO_GROUP' THEN policy.price_group_coverage = 'NO_GROUP'
             WHEN 'PRICE_GROUP' THEN policy.price_group_coverage = 'ANY_PRICE_GROUP'
               OR (policy.price_group_coverage = 'PRICE_GROUP'
                 AND policy.price_group_id::text = v_identity #>> '{priceGroupSelector,priceGroupRef,resourceId}'
                 AND v_identity #>> '{priceGroupSelector,priceGroupRef,tenantId}' = p_tenant_id::text)
             ELSE false
           END
       AND policy.effective_from <= v_effective_at
       AND (LEAST(policy.effective_to, policy_end.effective_to) IS NULL
         OR v_effective_at < LEAST(policy.effective_to, policy_end.effective_to))
       AND policy.verified_at <= v_trusted_operation_at;

    IF v_policy_count = 1 THEN
      RETURN QUERY SELECT pg_catalog.jsonb_build_object(
        'outcome', 'AUTHORITY_COVERED_BY_POLICY',
        'policy', v_policies -> 0
      );
      RETURN;
    END IF;
  END IF;

  -- Absence and ambiguity are held for owner resolution; neither is fabricated rejection.
  RETURN QUERY SELECT pg_catalog.jsonb_build_object(
    'outcome', 'AUTHORITY_UNRESOLVED',
    'reason', 'AUTHORITY'
  );
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION pricing.store_external_price_source_policy_v1(uuid, uuid, jsonb) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION pricing.end_external_price_source_policy_v1(uuid, uuid, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION pricing.store_external_price_source_policy_v1(uuid, uuid, jsonb) TO ontos_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION pricing.end_external_price_source_policy_v1(uuid, uuid, jsonb) TO ontos_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE pricing.external_price_source_policies TO ontos_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE pricing.external_price_source_policy_ends TO ontos_runtime;
