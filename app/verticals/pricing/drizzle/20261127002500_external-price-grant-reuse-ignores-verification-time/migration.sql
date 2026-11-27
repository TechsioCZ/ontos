-- A repeated grant of the same exact Price key, source authority, mapping and start with the same end and verification
-- reference is the grant Pricing already holds (REUSED). The reuse test also compared the stored verification time
-- with the new one, but Pricing stamps that time itself with each call's operation time, so a second grant could never
-- match and answered CONFLICT (409 external_price_source_authority_already_granted) on every staff ERP editor save.
-- The stored receipt keeps its original verification time; a different end or verification reference still conflicts.
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
    OR v_identity #>> '{unitBasis,quantity}' IS NULL
    OR v_identity #>> '{unitBasis,quantity}' !~ '^(0|[1-9][0-9]{0,28})(\.[0-9]{1,9})?$'
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
  -- grants use canonical UUIDs and numeric quantities, so the existing exact-key unique
  -- constraint also arbitrates concurrent first enrollments with equivalent spellings.
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
  v_identity := pg_catalog.jsonb_set(v_identity, '{unitBasis,quantity}',
    pg_catalog.to_jsonb(pg_catalog.trim_scale((v_identity #>> '{unitBasis,quantity}')::numeric)::text), false);

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
     AND authority.verification_ref = v_verification_ref AS same_terms) AS receipt
   WHERE authority.tenant_id = p_tenant_id AND authority.legal_entity_id = p_legal_entity_id
     AND authority.source_authority_ref = v_source_authority_ref AND authority.source_authority_version = v_source_authority_version
     AND authority.mapping_contract_ref = v_mapping_contract_ref AND authority.mapping_contract_version = v_mapping_contract_version
     AND authority.effective_from = v_effective_from
     AND CASE WHEN authority.exact_identity_key #>> '{unitBasis,quantity}' ~ '^(0|[1-9][0-9]{0,28})(\.[0-9]{1,9})?$'
           THEN (projected.key #- '{unitBasis,quantity}') = (v_identity #- '{unitBasis,quantity}')
             AND (authority.exact_identity_key #>> '{unitBasis,quantity}')::numeric =
                 (v_identity #>> '{unitBasis,quantity}')::numeric
           ELSE false
         END;
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
         authority.verification_ref
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
