-- #803/#805 Pricing-owned external Price Source Authority resolution. These routines run as the
-- scoped runtime role, remain subject to the table's forced RLS policies, and never infer an
-- authority or mapping from delivery metadata.
ALTER TABLE pricing.external_price_source_authority_grants FORCE ROW LEVEL SECURITY;

CREATE FUNCTION pricing.store_external_price_source_authority_grant_v1(
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

CREATE FUNCTION pricing.assess_external_price_source_authority_v1(
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
     AND authority.exact_identity_key = v_identity
     AND authority.effective_from <= v_effective_at
     AND (authority.effective_to IS NULL OR v_effective_at < authority.effective_to)
     AND authority.verified_at <= v_trusted_operation_at;

  IF v_match_count = 1 THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      'grant', v_grants -> 0,
      'outcome', 'AUTHORITY_GRANTED'
    );
  ELSE
    -- Absence and ambiguity are held for owner resolution; neither is fabricated rejection.
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      'outcome', 'AUTHORITY_UNRESOLVED',
      'reason', 'AUTHORITY'
    );
  END IF;
END
$function$;

REVOKE ALL ON FUNCTION pricing.store_external_price_source_authority_grant_v1(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.assess_external_price_source_authority_v1(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pricing.store_external_price_source_authority_grant_v1(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.assess_external_price_source_authority_v1(uuid, uuid, jsonb) TO ontos_runtime;
GRANT SELECT, INSERT ON TABLE pricing.external_price_source_authority_grants TO ontos_runtime;
