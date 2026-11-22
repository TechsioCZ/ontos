ALTER TABLE "pricing"."external_price_source_authority_grants" ADD CONSTRAINT "pricing_external_price_authority_exact_refs_ck" CHECK ("source_authority_ref" <> '*' and "source_authority_version" <> '*' and "mapping_contract_ref" <> '*' and "mapping_contract_version" <> '*');--> statement-breakpoint
ALTER TABLE "pricing"."external_price_source_authority_grants" ADD CONSTRAINT "pricing_external_price_authority_resource_ids_ck" CHECK ((("exact_identity_key"#>>'{unitBasis,unitRef,resourceId}') collate "C" ~ '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$' and case "exact_identity_key"#>>'{priceGroupSelector,kind}' when 'NO_GROUP' then true when 'PRICE_GROUP' then ("exact_identity_key"#>>'{priceGroupSelector,priceGroupRef,resourceId}') collate "C" ~ '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$' else false end) is true);--> statement-breakpoint
ALTER TABLE "pricing"."external_price_source_policies" ADD CONSTRAINT "pricing_external_price_policies_verification_ref_ck" CHECK ("verification_ref" = btrim("verification_ref", U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') and length("verification_ref") + regexp_count("verification_ref" collate "C", U&'[\+010000-\+10FFFF]') <= 300);
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
  v_has_key boolean;
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

  -- A key has one numeric quantity, independent of the JSON spelling. Count all grants for
  -- that key before filtering for eligibility: even an ineligible grant precludes a policy.
  SELECT count(*) > 0, (count(*) FILTER (WHERE matching.eligible))::integer,
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
           ) FILTER (WHERE matching.eligible),
           '[]'::jsonb
         )
    INTO v_has_key, v_match_count, v_grants
    FROM pricing.external_price_source_authority_grants AS authority
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
           THEN (authority.exact_identity_key #- '{unitBasis,quantity}') = (v_identity #- '{unitBasis,quantity}')
             AND (authority.exact_identity_key #>> '{unitBasis,quantity}')::numeric =
                 (v_identity #>> '{unitBasis,quantity}')::numeric
           ELSE false
         END;

  IF v_match_count = 1 THEN
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
  IF NOT v_has_key THEN
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
