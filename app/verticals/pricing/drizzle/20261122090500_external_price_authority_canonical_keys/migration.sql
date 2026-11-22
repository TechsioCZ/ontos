-- Earlier supported stores accepted these exact literal references. Keep immutable historical
-- evidence unchanged, while enforcing the restriction on every future insert or update.
ALTER TABLE "pricing"."external_price_source_authority_grants" ADD CONSTRAINT "pricing_external_price_authority_exact_refs_ck" CHECK ("source_authority_ref" <> '*' and "source_authority_version" <> '*' and "mapping_contract_ref" <> '*' and "mapping_contract_version" <> '*') NOT VALID;--> statement-breakpoint
-- Older policy stores accepted references trimmed with ordinary-space btrim. Preserve those
-- immutable rows as well; the stricter reference check still applies to every future write.
ALTER TABLE "pricing"."external_price_source_policies" ADD CONSTRAINT "pricing_external_price_policies_verification_ref_ck" CHECK ("verification_ref" = btrim("verification_ref", U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') and length("verification_ref") + regexp_count("verification_ref" collate "C", U&'[\+010000-\+10FFFF]') <= 300) NOT VALID;
--> statement-breakpoint
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
  v_key_count integer := 0;
  canonical_uuid CONSTANT text := '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$';
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
    OR ((v_identity #>> '{unitBasis,unitRef,resourceId}') COLLATE "C" ~ canonical_uuid) IS NOT TRUE
    OR (v_identity #>> '{priceGroupSelector,kind}' = 'PRICE_GROUP' AND (
      v_identity #>> '{priceGroupSelector,priceGroupRef,tenantId}' IS DISTINCT FROM p_tenant_id::text
      OR ((v_identity #>> '{priceGroupSelector,priceGroupRef,resourceId}') COLLATE "C" ~ canonical_uuid) IS NOT TRUE))
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

  -- Stored JSON is immutable evidence. Fold only the two UUID resource IDs: never tenant,
  -- scope, source, mapping, or arbitrary JSON text. Do not merge or pick a historic row.
  -- A key has one numeric quantity, independent of the JSON spelling. Count all grants for
  -- that key before filtering for eligibility: multiple receipts remain ambiguous even if
  -- only one is eligible, and even an ineligible grant precludes a policy.
  SELECT count(*)::integer, (count(*) FILTER (WHERE matching.eligible))::integer,
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
               'exactIdentityKey', projected.key,
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
           ) FILTER (WHERE matching.eligible),
           '[]'::jsonb
         )
    INTO v_key_count, v_match_count, v_grants
    FROM pricing.external_price_source_authority_grants AS authority
   CROSS JOIN LATERAL (SELECT pg_catalog.jsonb_set(authority.exact_identity_key, '{unitBasis,unitRef,resourceId}',
     pg_catalog.to_jsonb(pg_catalog.translate(authority.exact_identity_key #>> '{unitBasis,unitRef,resourceId}', 'ABCDEF', 'abcdef')), false) AS key) AS unit
   CROSS JOIN LATERAL (SELECT CASE WHEN unit.key #>> '{priceGroupSelector,kind}' = 'PRICE_GROUP'
     THEN pg_catalog.jsonb_set(unit.key, '{priceGroupSelector,priceGroupRef,resourceId}',
       pg_catalog.to_jsonb(pg_catalog.translate(authority.exact_identity_key #>> '{priceGroupSelector,priceGroupRef,resourceId}', 'ABCDEF', 'abcdef')), false)
     ELSE unit.key END AS key) AS projected
   CROSS JOIN LATERAL (SELECT authority.source_authority_ref = v_source_authority_ref
     AND authority.source_authority_version = v_source_authority_version
     AND authority.mapping_contract_ref = v_mapping_contract_ref
     AND authority.mapping_contract_version = v_mapping_contract_version
     AND authority.effective_from <= v_effective_at
     AND (authority.effective_to IS NULL OR v_effective_at < authority.effective_to)
     AND authority.verified_at <= v_trusted_operation_at AS eligible) AS matching
   WHERE authority.tenant_id = p_tenant_id
     AND authority.legal_entity_id = p_legal_entity_id
     AND CASE WHEN authority.exact_identity_key #>> '{unitBasis,quantity}' ~ '^(0|[1-9][0-9]{0,28})(\.[0-9]{1,9})?$'
           THEN (projected.key #- '{unitBasis,quantity}') = (v_identity #- '{unitBasis,quantity}')
             AND (authority.exact_identity_key #>> '{unitBasis,quantity}')::numeric =
                 (v_identity #>> '{unitBasis,quantity}')::numeric
           ELSE false
         END;

  IF v_key_count = 1 AND v_match_count = 1 THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      'grant', v_grants -> 0,
      'outcome', 'AUTHORITY_GRANTED'
    );
    RETURN;
  END IF;

  -- Only when no exact-key grant exists does a standing source policy apply. It covers the key when its
  -- authority, mapping, commercial scope, currency and unit basis are exactly the key's and its Price Group
  -- coverage names the key's selector, at the asserted effective time. Store refuses overlapping policies, so
  -- more than one match is ambiguity and stays unresolved.
  IF v_key_count = 0 THEN
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
                 AND policy.price_group_id::text = v_identity #>> '{priceGroupSelector,priceGroupRef,resourceId}')
             ELSE false
           END
       AND policy.effective_from <= v_effective_at
       -- Match the projected MS timestamp's half-open end, including historical fractional cutoffs.
       AND (LEAST(policy.effective_to, policy_end.effective_to) IS NULL
         OR v_effective_at < pg_catalog.date_trunc('milliseconds', LEAST(policy.effective_to, policy_end.effective_to)))
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
CREATE OR REPLACE FUNCTION pricing.store_external_price_source_authority_grant_v1(
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
  v_identity jsonb := p_input -> 'exactIdentityKey';
  v_source_authority_ref text := p_input #>> '{authority,sourceAuthorityRef}';
  v_source_authority_version text := p_input #>> '{authority,sourceAuthorityVersion}';
  v_mapping_contract_ref text := p_input #>> '{mapping,mappingContractRef}';
  v_mapping_contract_version text := p_input #>> '{mapping,mappingContractVersion}';
  v_effective_from_text text := p_input #>> '{effectivePeriod,effectiveFrom}';
  v_effective_to_text text := p_input #>> '{effectivePeriod,effectiveTo}';
  v_verified_at_text text := p_input ->> 'verifiedAt';
  v_verification_ref text := p_input ->> 'verificationRef';
  v_effective_from timestamptz;
  v_effective_to timestamptz;
  v_verified_at timestamptz;
  v_submitted_key jsonb := v_identity;
  v_same_terms boolean;
  canonical_uuid CONSTANT text := '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$';
  v_inserted boolean := false;
  v_existing record;
BEGIN
  IF p_tenant_id::text IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')
    OR p_legal_entity_id::text IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')
  THEN
    RAISE EXCEPTION 'Pricing external Price Source Authority scope mismatch' USING ERRCODE = '42501';
  END IF;

  IF p_input IS NULL
    OR pg_catalog.jsonb_typeof(p_input) <> 'object'
    OR pg_catalog.jsonb_typeof(v_identity) <> 'object'
    OR p_input ->> 'family' IS DISTINCT FROM 'PRICE'
    OR p_input ->> 'ownerModuleId' IS DISTINCT FROM 'commerce.pricing'
    OR p_input ->> 'schemaVersion' IS DISTINCT FROM '1'
    OR v_identity #>> '{catalogSelection,productRef,tenantId}' IS DISTINCT FROM p_tenant_id::text
    OR v_identity #>> '{catalogSelection,variantRef,tenantId}' IS DISTINCT FROM p_tenant_id::text
    OR v_identity #>> '{unitBasis,unitRef,tenantId}' IS DISTINCT FROM p_tenant_id::text
    OR v_identity #>> '{commercialScope,sellingLegalEntityId}' IS DISTINCT FROM p_legal_entity_id::text
    OR v_identity #>> '{catalogSelection,productRef,moduleId}' IS DISTINCT FROM 'commerce.catalog'
    OR v_identity #>> '{catalogSelection,productRef,resourceType}' IS DISTINCT FROM 'commerce.catalog.product'
    OR v_identity #>> '{catalogSelection,variantRef,moduleId}' IS DISTINCT FROM 'commerce.catalog'
    OR v_identity #>> '{catalogSelection,variantRef,resourceType}' IS DISTINCT FROM 'commerce.catalog.variant'
    OR v_identity #>> '{unitBasis,unitRef,moduleId}' IS DISTINCT FROM 'commerce.catalog'
    OR v_identity #>> '{unitBasis,unitRef,resourceType}' IS DISTINCT FROM 'commerce.catalog.product-unit'
    OR p_input #> '{effectivePeriod,effectiveTo}' = 'null'::jsonb
  THEN
    RAISE EXCEPTION 'Pricing external Price Source Authority grant is invalid' USING ERRCODE = '22023';
  END IF;

  IF v_source_authority_ref IS NULL
    OR v_source_authority_ref IS DISTINCT FROM pg_catalog.btrim(v_source_authority_ref)
    OR pg_catalog.length(v_source_authority_ref) NOT BETWEEN 1 AND 300
    OR v_source_authority_version IS NULL
    OR v_source_authority_version IS DISTINCT FROM pg_catalog.btrim(v_source_authority_version)
    OR pg_catalog.length(v_source_authority_version) NOT BETWEEN 1 AND 100
    OR v_mapping_contract_ref IS NULL
    OR v_mapping_contract_ref IS DISTINCT FROM pg_catalog.btrim(v_mapping_contract_ref)
    OR pg_catalog.length(v_mapping_contract_ref) NOT BETWEEN 1 AND 300
    OR v_mapping_contract_version IS NULL
    OR v_mapping_contract_version IS DISTINCT FROM pg_catalog.btrim(v_mapping_contract_version)
    OR pg_catalog.length(v_mapping_contract_version) NOT BETWEEN 1 AND 100
    OR v_verification_ref IS NULL
    OR v_verification_ref IS DISTINCT FROM pg_catalog.btrim(v_verification_ref)
    OR pg_catalog.length(v_verification_ref) NOT BETWEEN 1 AND 300
    OR v_effective_from_text IS NULL
    OR v_effective_from_text !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
    OR (v_effective_to_text IS NOT NULL AND v_effective_to_text !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$')
    OR v_verified_at_text IS NULL
    OR v_verified_at_text !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
  THEN
    RAISE EXCEPTION 'Pricing external Price Source Authority grant is invalid' USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_effective_from := v_effective_from_text::timestamptz;
    v_effective_to := v_effective_to_text::timestamptz;
    v_verified_at := v_verified_at_text::timestamptz;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Pricing external Price Source Authority grant is invalid' USING ERRCODE = '22023';
  END;
  IF v_effective_to IS NOT NULL AND v_effective_to <= v_effective_from THEN
    RAISE EXCEPTION 'Pricing external Price Source Authority grant period is invalid' USING ERRCODE = '22023';
  END IF;

  -- Preserve historical receipt identity, including its quantity spelling. Newly enrolled
  -- grants use canonical UUIDs; the old unique constraint still arbitrates concurrent inserts.
  v_identity := pg_catalog.jsonb_set(v_identity, '{unitBasis,unitRef,resourceId}',
    pg_catalog.to_jsonb(pg_catalog.translate(v_identity #>> '{unitBasis,unitRef,resourceId}', 'ABCDEF', 'abcdef')), false);
  IF v_identity #>> '{priceGroupSelector,kind}' = 'PRICE_GROUP' THEN
    v_identity := pg_catalog.jsonb_set(v_identity, '{priceGroupSelector,priceGroupRef,resourceId}',
      pg_catalog.to_jsonb(pg_catalog.translate(v_identity #>> '{priceGroupSelector,priceGroupRef,resourceId}', 'ABCDEF', 'abcdef')), false);
  END IF;
  IF ((v_identity #>> '{unitBasis,unitRef,resourceId}') COLLATE "C" ~ canonical_uuid) IS NOT TRUE OR
    (CASE v_identity #>> '{priceGroupSelector,kind}' WHEN 'NO_GROUP' THEN true WHEN 'PRICE_GROUP' THEN
      (v_identity #>> '{priceGroupSelector,priceGroupRef,resourceId}') COLLATE "C" ~ canonical_uuid
      AND v_identity #>> '{priceGroupSelector,priceGroupRef,tenantId}' = p_tenant_id::text ELSE false END) IS NOT TRUE THEN
    RAISE EXCEPTION 'Invalid Pricing grant resource identity' USING ERRCODE = '22023';
  END IF;

  -- An exact historical replay must still resolve its own receipt. Without that spelling,
  -- reuse only if *all* corresponding receipts agree with the submitted verification data.
  SELECT coalesce(bool_and(receipt.same_terms) FILTER (WHERE authority.exact_identity_key = v_submitted_key),
                  bool_and(receipt.same_terms)) INTO v_same_terms
    FROM pricing.external_price_source_authority_grants AS authority
   CROSS JOIN LATERAL (SELECT pg_catalog.jsonb_set(authority.exact_identity_key, '{unitBasis,unitRef,resourceId}',
     pg_catalog.to_jsonb(pg_catalog.translate(authority.exact_identity_key #>> '{unitBasis,unitRef,resourceId}', 'ABCDEF', 'abcdef')), false) AS key) AS unit
   CROSS JOIN LATERAL (SELECT CASE WHEN unit.key #>> '{priceGroupSelector,kind}' = 'PRICE_GROUP'
     THEN pg_catalog.jsonb_set(unit.key, '{priceGroupSelector,priceGroupRef,resourceId}',
       pg_catalog.to_jsonb(pg_catalog.translate(authority.exact_identity_key #>> '{priceGroupSelector,priceGroupRef,resourceId}', 'ABCDEF', 'abcdef')), false)
     ELSE unit.key END AS key) AS projected
   CROSS JOIN LATERAL (SELECT authority.effective_to IS NOT DISTINCT FROM v_effective_to
     AND authority.verified_at = v_verified_at AND authority.verification_ref = v_verification_ref AS same_terms) AS receipt
   WHERE authority.tenant_id = p_tenant_id AND authority.legal_entity_id = p_legal_entity_id
     AND authority.source_authority_ref = v_source_authority_ref AND authority.source_authority_version = v_source_authority_version
     AND authority.mapping_contract_ref = v_mapping_contract_ref AND authority.mapping_contract_version = v_mapping_contract_version
     AND authority.effective_from = v_effective_from AND projected.key = v_identity;
  IF v_same_terms IS NOT NULL THEN
    RETURN QUERY SELECT CASE WHEN v_same_terms THEN jsonb_build_object('outcome', 'REUSED')
      ELSE jsonb_build_object('outcome', 'CONFLICT', 'reason', 'GRANT_IDENTITY_ALREADY_BOUND') END;
    RETURN;
  END IF;

  INSERT INTO pricing.external_price_source_authority_grants (
    tenant_id,
    legal_entity_id,
    source_authority_ref,
    source_authority_version,
    mapping_contract_ref,
    mapping_contract_version,
    exact_identity_key,
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
    v_identity,
    v_effective_from,
    v_effective_to,
    v_verification_ref,
    v_verified_at
  )
  ON CONFLICT ON CONSTRAINT pricing_external_price_authority_identity_uk DO NOTHING
  RETURNING true INTO v_inserted;

  IF v_inserted THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object('outcome', 'STORED');
    RETURN;
  END IF;

  SELECT authority.effective_to,
         authority.verification_ref,
         authority.verified_at
    INTO v_existing
    FROM pricing.external_price_source_authority_grants AS authority
   WHERE authority.tenant_id = p_tenant_id
     AND authority.legal_entity_id = p_legal_entity_id
     AND authority.source_authority_ref = v_source_authority_ref
     AND authority.source_authority_version = v_source_authority_version
     AND authority.mapping_contract_ref = v_mapping_contract_ref
     AND authority.mapping_contract_version = v_mapping_contract_version
     AND authority.exact_identity_key = v_identity
     AND authority.effective_from = v_effective_from;

  IF FOUND
    AND v_existing.effective_to IS NOT DISTINCT FROM v_effective_to
    AND v_existing.verification_ref = v_verification_ref
    AND v_existing.verified_at = v_verified_at
  THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object('outcome', 'REUSED');
  ELSE
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      'outcome', 'CONFLICT',
      'reason', 'GRANT_IDENTITY_ALREADY_BOUND'
    );
  END IF;
END
$function$;
