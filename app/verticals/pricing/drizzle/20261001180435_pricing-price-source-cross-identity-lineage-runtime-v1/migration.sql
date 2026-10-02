CREATE OR REPLACE FUNCTION pricing.bind_price_source_provenance_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_price_id uuid,
  p_price_revision_id uuid,
  p_input jsonb
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_action_invocation_id uuid;
  v_acting_principal_id uuid;
  v_assertion jsonb := p_input #> '{sourceEvidence,sourceAssertion}';
  v_assertion_lineage jsonb;
  v_authority jsonb;
  v_canonical pricing.price_revisions%ROWTYPE;
  v_created boolean := false;
  v_delivery pricing.price_source_assertion_deliveries%ROWTYPE;
  v_delivered_assertion_id uuid;
  v_evidence jsonb := p_input -> 'sourceEvidence';
  v_existing pricing.price_source_assertions%ROWTYPE;
  v_imported_at timestamptz;
  v_mapping jsonb;
  v_match_count integer;
  v_normalization jsonb;
  v_original jsonb;
  v_owner_business_at timestamptz;
  v_price pricing.prices%ROWTYPE;
  v_recorded_at timestamptz;
  v_request_correlation text := p_input ->> 'requestCorrelationId';
  v_source_effective_at timestamptz;
  v_source_record jsonb;
  v_trusted_lineage jsonb := p_input #> '{sourceEvidence,lineage}';
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Pricing source provenance scope mismatch' USING ERRCODE = '42501';
  END IF;

  v_source_record := v_assertion -> 'sourceRecord';
  v_authority := v_assertion -> 'sourceAuthority';
  v_mapping := v_assertion -> 'mapping';
  v_original := v_assertion -> 'originalAssertion';
  v_normalization := v_assertion -> 'preTaxNormalization';
  v_assertion_lineage := v_assertion -> 'lineage';
  BEGIN
    v_action_invocation_id := (p_input ->> 'actionInvocationId')::uuid;
    v_acting_principal_id := (p_input ->> 'actingPrincipalId')::uuid;
    v_delivered_assertion_id := (v_assertion ->> 'sourceAssertionId')::uuid;
    v_recorded_at := (v_evidence ->> 'recordedAt')::timestamptz;
    v_imported_at := (v_assertion #>> '{timing,importedAt}')::timestamptz;
    v_source_effective_at := (v_assertion #>> '{timing,sourceEffectiveAt}')::timestamptz;
    v_owner_business_at := (v_assertion #>> '{timing,ownerBusinessEffectiveAt}')::timestamptz;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    RETURN pg_catalog.jsonb_build_object('outcome', 'CONFLICT', 'reason', 'SOURCE_PROVENANCE_INVALID');
  END;

  IF v_evidence IS NULL OR v_assertion IS NULL
    OR v_evidence ->> 'tenantId' IS DISTINCT FROM p_tenant_id::text
    OR (v_evidence ->> 'sourceFactFingerprint') !~ '^[0-9a-f]{64}$'
    OR v_request_correlation IS NULL
    OR v_request_correlation IS DISTINCT FROM pg_catalog.btrim(v_request_correlation)
    OR pg_catalog.length(v_request_correlation) NOT BETWEEN 1 AND 500
    OR v_assertion ? 'storefrontId' OR v_source_record ? 'storefrontId'
    OR pg_catalog.jsonb_path_exists(v_evidence, '$.**.storefrontId')
    OR v_assertion_lineage ->> 'kind' IS DISTINCT FROM v_trusted_lineage ->> 'kind'
    OR v_assertion_lineage ->> 'reason' IS DISTINCT FROM v_trusted_lineage ->> 'reason'
    OR v_assertion_lineage ->> 'correctedSourceAssertionId'
         IS DISTINCT FROM v_trusted_lineage ->> 'correctedSourceAssertionId'
    OR v_assertion_lineage ->> 'supersededSourceAssertionId'
         IS DISTINCT FROM v_trusted_lineage ->> 'supersededSourceAssertionId'
    OR (
      v_trusted_lineage ->> 'kind' IS DISTINCT FROM 'INITIAL'
      AND v_trusted_lineage ->> 'actingPrincipalId' IS DISTINCT FROM v_acting_principal_id::text
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('outcome', 'CONFLICT', 'reason', 'SOURCE_PROVENANCE_INVALID');
  END IF;

  SELECT revision.* INTO v_canonical
    FROM pricing.price_revisions AS revision
   WHERE revision.tenant_id = p_tenant_id
     AND revision.legal_entity_id = p_legal_entity_id
     AND revision.price_id = p_price_id
     AND revision.price_revision_id = p_price_revision_id;
  SELECT price.* INTO v_price
    FROM pricing.prices AS price
   WHERE price.tenant_id = p_tenant_id
     AND price.legal_entity_id = p_legal_entity_id
     AND price.price_id = p_price_id;
  IF v_canonical.price_revision_id IS NULL OR v_price.price_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('outcome', 'ABSENT');
  END IF;

  IF v_owner_business_at IS DISTINCT FROM v_canonical.effective_from
    OR v_original #>> '{monetaryAmount,currencyCode}' IS DISTINCT FROM v_price.currency_code
    OR v_original #> '{unitBasis,unitRef}' IS DISTINCT FROM v_price.unit_ref
    OR (v_original #>> '{unitBasis,quantity}')::numeric IS DISTINCT FROM v_price.basis_quantity
    OR (v_original ->> 'monetaryBoundary' = 'PRE_TAX' AND (
      v_normalization IS NOT NULL
      OR (v_original #>> '{monetaryAmount,amount}')::numeric IS DISTINCT FROM v_canonical.amount
    ))
    OR (v_original ->> 'monetaryBoundary' = 'TAX_INCLUSIVE' AND (
      v_normalization IS NULL
      OR v_normalization #>> '{authority,sourceAuthorityRef}'
           IS DISTINCT FROM v_authority ->> 'sourceAuthorityRef'
      OR v_normalization #>> '{authority,sourceAuthorityVersion}'
           IS DISTINCT FROM v_authority ->> 'sourceAuthorityVersion'
      OR v_normalization #>> '{normalizedMonetaryAmount,currencyCode}' IS DISTINCT FROM v_canonical.currency_code
      OR (v_normalization #>> '{normalizedMonetaryAmount,amount}')::numeric IS DISTINCT FROM v_canonical.amount
    ))
    OR v_original ->> 'monetaryBoundary' NOT IN ('PRE_TAX', 'TAX_INCLUSIVE')
  THEN
    RETURN pg_catalog.jsonb_build_object('outcome', 'CONFLICT', 'reason', 'CANONICAL_LINK_MISMATCH');
  END IF;

  -- The first revision of a replacement exact Price is canonically INITIAL, while its source
  -- fact may still correct or supersede a source fact attached to the previous Price identity.
  IF (v_canonical.transition_kind = 'CORRECTION' AND v_trusted_lineage ->> 'kind' <> 'CORRECTION')
    OR (v_canonical.transition_kind NOT IN ('INITIAL', 'CORRECTION')
        AND v_trusted_lineage ->> 'kind' <> 'SUPERSESSION')
  THEN
    RETURN pg_catalog.jsonb_build_object('outcome', 'CONFLICT', 'reason', 'SOURCE_LINEAGE_INVALID');
  END IF;
  IF v_trusted_lineage ->> 'kind' = 'CORRECTION' AND NOT EXISTS (
    SELECT 1 FROM pricing.price_source_assertions AS predecessor
     WHERE predecessor.tenant_id = p_tenant_id AND predecessor.legal_entity_id = p_legal_entity_id
       AND predecessor.source_assertion_id = (v_trusted_lineage ->> 'correctedSourceAssertionId')::uuid
       AND (
         v_canonical.transition_kind = 'INITIAL'
         OR (
           predecessor.price_id = p_price_id
           AND predecessor.price_revision_id = v_canonical.corrected_revision_id
         )
       )
  ) THEN
    RETURN pg_catalog.jsonb_build_object('outcome', 'CONFLICT', 'reason', 'SOURCE_LINEAGE_INVALID');
  END IF;
  IF v_trusted_lineage ->> 'kind' = 'SUPERSESSION' AND NOT EXISTS (
    SELECT 1 FROM pricing.price_source_assertions AS predecessor
     WHERE predecessor.tenant_id = p_tenant_id AND predecessor.legal_entity_id = p_legal_entity_id
       AND predecessor.source_assertion_id = (v_trusted_lineage ->> 'supersededSourceAssertionId')::uuid
       AND (
         v_canonical.transition_kind = 'INITIAL'
         OR (
           predecessor.price_id = p_price_id
           AND predecessor.price_revision_id = v_canonical.previous_revision_id
         )
       )
  ) THEN
    RETURN pg_catalog.jsonb_build_object('outcome', 'CONFLICT', 'reason', 'SOURCE_LINEAGE_INVALID');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_tenant_id::text || ':price-source:' || p_price_id::text || ':' || p_price_revision_id::text, 0
  ));
  SELECT count(*)::integer INTO v_match_count
    FROM pricing.price_source_assertions AS provenance
   WHERE provenance.tenant_id = p_tenant_id AND provenance.legal_entity_id = p_legal_entity_id
     AND (provenance.price_revision_id = p_price_revision_id
       OR provenance.source_assertion_id = v_delivered_assertion_id
       OR provenance.source_fact_fingerprint = v_evidence ->> 'sourceFactFingerprint'
       OR (provenance.source_owner_module_id = v_source_record #>> '{sourceSystem,ownerModuleId}'
         AND provenance.source_system_ref = v_source_record #>> '{sourceSystem,sourceSystemRef}'
         AND provenance.source_record_ref = v_source_record ->> 'sourceRecordRef'
         AND provenance.source_record_version = v_source_record ->> 'sourceRecordVersion'
         AND provenance.source_change_correlation = v_source_record ->> 'sourceChangeCorrelation'
         AND provenance.mapping_contract_ref = v_mapping ->> 'mappingContractRef'
         AND provenance.mapping_contract_version = v_mapping ->> 'mappingContractVersion'));
  IF v_match_count > 1 THEN
    RETURN pg_catalog.jsonb_build_object('outcome', 'CONFLICT', 'reason', 'SOURCE_FACT_CONFLICT');
  END IF;
  IF v_match_count = 1 THEN
    SELECT provenance.* INTO v_existing
     FROM pricing.price_source_assertions AS provenance
     WHERE provenance.tenant_id = p_tenant_id AND provenance.legal_entity_id = p_legal_entity_id
       AND (provenance.price_revision_id = p_price_revision_id
         OR provenance.source_assertion_id = v_delivered_assertion_id
         OR provenance.source_fact_fingerprint = v_evidence ->> 'sourceFactFingerprint'
         OR (provenance.source_owner_module_id = v_source_record #>> '{sourceSystem,ownerModuleId}'
           AND provenance.source_system_ref = v_source_record #>> '{sourceSystem,sourceSystemRef}'
           AND provenance.source_record_ref = v_source_record ->> 'sourceRecordRef'
           AND provenance.source_record_version = v_source_record ->> 'sourceRecordVersion'
           AND provenance.source_change_correlation = v_source_record ->> 'sourceChangeCorrelation'
           AND provenance.mapping_contract_ref = v_mapping ->> 'mappingContractRef'
           AND provenance.mapping_contract_version = v_mapping ->> 'mappingContractVersion'))
     LIMIT 1;
    IF v_existing.price_revision_id IS DISTINCT FROM p_price_revision_id
      OR v_existing.source_fact_fingerprint IS DISTINCT FROM v_evidence ->> 'sourceFactFingerprint'
      OR v_existing.source_owner_module_id IS DISTINCT FROM v_source_record #>> '{sourceSystem,ownerModuleId}'
      OR v_existing.source_system_ref IS DISTINCT FROM v_source_record #>> '{sourceSystem,sourceSystemRef}'
      OR v_existing.source_record_ref IS DISTINCT FROM v_source_record ->> 'sourceRecordRef'
      OR v_existing.source_record_version IS DISTINCT FROM v_source_record ->> 'sourceRecordVersion'
      OR v_existing.source_change_correlation IS DISTINCT FROM v_source_record ->> 'sourceChangeCorrelation'
      OR v_existing.source_authority_ref IS DISTINCT FROM v_authority ->> 'sourceAuthorityRef'
      OR v_existing.source_authority_version IS DISTINCT FROM v_authority ->> 'sourceAuthorityVersion'
      OR v_existing.mapping_contract_ref IS DISTINCT FROM v_mapping ->> 'mappingContractRef'
      OR v_existing.mapping_contract_version IS DISTINCT FROM v_mapping ->> 'mappingContractVersion'
      OR v_existing.original_assertion IS DISTINCT FROM v_original
      OR v_existing.pre_tax_normalization IS DISTINCT FROM v_normalization
      OR v_existing.source_effective_at IS DISTINCT FROM v_source_effective_at
      OR v_existing.owner_business_effective_at IS DISTINCT FROM v_owner_business_at
    THEN
      RETURN pg_catalog.jsonb_build_object('outcome', 'CONFLICT', 'reason', 'SOURCE_FACT_CONFLICT');
    END IF;
  ELSE
    INSERT INTO pricing.price_source_assertions (
      source_assertion_id, tenant_id, legal_entity_id, price_id, price_revision_id,
      source_owner_module_id, source_system_ref, source_record_ref, source_record_version,
      source_change_correlation, source_authority_ref, source_authority_version,
      mapping_contract_ref, mapping_contract_version, source_fact_fingerprint,
      original_assertion, pre_tax_normalization, source_effective_at,
      owner_business_effective_at, recorded_at, imported_at, lineage_kind,
      corrected_source_assertion_id, superseded_source_assertion_id,
      lineage_acting_principal_id, lineage_reason, action_invocation_id,
      recorded_by_principal_id, request_correlation_id
    ) VALUES (
      v_delivered_assertion_id, p_tenant_id, p_legal_entity_id, p_price_id, p_price_revision_id,
      v_source_record #>> '{sourceSystem,ownerModuleId}', v_source_record #>> '{sourceSystem,sourceSystemRef}',
      v_source_record ->> 'sourceRecordRef', v_source_record ->> 'sourceRecordVersion',
      v_source_record ->> 'sourceChangeCorrelation', v_authority ->> 'sourceAuthorityRef',
      v_authority ->> 'sourceAuthorityVersion', v_mapping ->> 'mappingContractRef',
      v_mapping ->> 'mappingContractVersion', v_evidence ->> 'sourceFactFingerprint',
      v_original, v_normalization, v_source_effective_at, v_owner_business_at,
      v_recorded_at, v_imported_at, v_trusted_lineage ->> 'kind',
      (v_trusted_lineage ->> 'correctedSourceAssertionId')::uuid,
      (v_trusted_lineage ->> 'supersededSourceAssertionId')::uuid,
      (v_trusted_lineage ->> 'actingPrincipalId')::uuid, v_trusted_lineage ->> 'reason',
      v_action_invocation_id, v_acting_principal_id, v_request_correlation
    );
    SELECT provenance.* INTO v_existing FROM pricing.price_source_assertions AS provenance
     WHERE provenance.source_assertion_id = v_delivered_assertion_id;
    v_created := true;
  END IF;

  SELECT delivery.* INTO v_delivery FROM pricing.price_source_assertion_deliveries AS delivery
   WHERE delivery.tenant_id = p_tenant_id AND delivery.legal_entity_id = p_legal_entity_id
     AND delivery.price_id = p_price_id AND delivery.action_invocation_id = v_action_invocation_id;
  IF FOUND THEN
    IF v_delivery.source_assertion_id IS DISTINCT FROM v_existing.source_assertion_id
      OR v_delivery.delivered_source_assertion_id IS DISTINCT FROM v_delivered_assertion_id
      OR v_delivery.delivered_evidence IS DISTINCT FROM v_evidence
      OR v_delivery.recorded_by_principal_id IS DISTINCT FROM v_acting_principal_id
      OR v_delivery.request_correlation_id IS DISTINCT FROM v_request_correlation
    THEN
      RETURN pg_catalog.jsonb_build_object('outcome', 'CONFLICT', 'reason', 'IDEMPOTENCY_CONFLICT');
    END IF;
  ELSE
    INSERT INTO pricing.price_source_assertion_deliveries (
      source_assertion_delivery_id, tenant_id, legal_entity_id, price_id,
      source_assertion_id, delivered_source_assertion_id, delivered_evidence,
      action_invocation_id, recorded_by_principal_id, recorded_at, imported_at,
      request_correlation_id
    ) VALUES (
      pg_catalog.gen_random_uuid(), p_tenant_id, p_legal_entity_id, p_price_id,
      v_existing.source_assertion_id, v_delivered_assertion_id, v_evidence,
      v_action_invocation_id, v_acting_principal_id, v_recorded_at, v_imported_at,
      v_request_correlation
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'outcome', CASE WHEN v_created THEN 'RECORDED' ELSE 'REUSED' END,
    'provenance', pricing.price_source_provenance_json_v1(
      p_tenant_id, p_legal_entity_id, p_price_id, p_price_revision_id
    )
  );
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range
  OR check_violation OR foreign_key_violation OR unique_violation THEN
  RETURN pg_catalog.jsonb_build_object('outcome', 'CONFLICT', 'reason', 'SOURCE_PROVENANCE_INVALID');
END;
$function$;

REVOKE ALL ON FUNCTION pricing.bind_price_source_provenance_v1(uuid, uuid, uuid, uuid, jsonb)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pricing.bind_price_source_provenance_v1(uuid, uuid, uuid, uuid, jsonb)
TO ontos_runtime;
