-- Custom SQL migration file, put your code below! --
-- #760 owner-private source provenance. Existing rows receive explicitly qualified
-- legacy evidence; it preserves known facts without claiming modern source authority.
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA public;

ALTER TABLE pricing.prices NO FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.prices DISABLE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_revisions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_revisions DISABLE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_source_assertions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_source_assertions DISABLE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_source_assertion_deliveries NO FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_source_assertion_deliveries DISABLE ROW LEVEL SECURITY;

DO $backfill$
DECLARE
  v_delivery_count bigint;
  v_revision_count bigint;
  v_source_count bigint;
BEGIN
  SELECT count(*) INTO v_source_count FROM pricing.price_revisions;
  CREATE TEMPORARY TABLE pricing_legacy_source_mapping ON COMMIT DROP AS
  SELECT revision.*, price.unit_ref, price.basis_quantity,
         pg_catalog.gen_random_uuid() AS source_assertion_id
    FROM pricing.price_revisions AS revision
    JOIN pricing.prices AS price
      ON price.tenant_id = revision.tenant_id
     AND price.legal_entity_id = revision.legal_entity_id
     AND price.price_id = revision.price_id;

  INSERT INTO pricing.price_source_assertions (
    source_assertion_id, tenant_id, legal_entity_id, price_id, price_revision_id,
    source_owner_module_id, source_system_ref, source_record_ref, source_record_version,
    source_change_correlation, source_authority_ref, source_authority_version,
    mapping_contract_ref, mapping_contract_version, source_fact_fingerprint,
    original_assertion, pre_tax_normalization, source_effective_at,
    owner_business_effective_at, recorded_at, imported_at, lineage_kind,
    corrected_source_assertion_id, superseded_source_assertion_id,
    lineage_acting_principal_id, lineage_reason, action_invocation_id,
    recorded_by_principal_id, request_correlation_id, stored_at
  )
  SELECT mapping.source_assertion_id, mapping.tenant_id, mapping.legal_entity_id,
         mapping.price_id, mapping.price_revision_id,
         'commerce.pricing', 'legacy:pricing-action-runtime-v1',
         'legacy:price-revision:' || mapping.price_revision_id::text,
         mapping.revision_number::text, mapping.action_invocation_id::text,
         'legacy:unverified:not-asserted', 'legacy-v1',
         'legacy:pricing-direct-write', 'legacy-v1',
         pg_catalog.encode(public.digest(pg_catalog.jsonb_build_object(
           'tenantId', mapping.tenant_id, 'priceId', mapping.price_id,
           'revisionId', mapping.price_revision_id,
           'sourceRecordRef', 'legacy:price-revision:' || mapping.price_revision_id::text,
           'sourceRecordVersion', mapping.revision_number::text,
           'sourceChangeCorrelation', mapping.action_invocation_id::text,
           'authority', 'legacy:unverified:not-asserted',
           'mapping', 'legacy:pricing-direct-write', 'amount', mapping.amount,
           'currencyCode', mapping.currency_code, 'unitRef', mapping.unit_ref,
           'basisQuantity', mapping.basis_quantity
         )::text, 'sha256'), 'hex'),
         pg_catalog.jsonb_build_object(
           'monetaryAmount', pg_catalog.jsonb_build_object(
             'amount', mapping.amount::text, 'currencyCode', mapping.currency_code
           ),
           'monetaryBoundary', 'PRE_TAX',
           'unitBasis', pg_catalog.jsonb_build_object(
             'quantity', mapping.basis_quantity::text, 'unitRef', mapping.unit_ref
           )
         ),
         NULL, mapping.effective_from, mapping.effective_from,
         mapping.recorded_at, mapping.recorded_at,
         CASE WHEN mapping.transition_kind = 'INITIAL' THEN 'INITIAL'
              WHEN mapping.transition_kind = 'CORRECTION' THEN 'CORRECTION'
              ELSE 'SUPERSESSION' END,
         CASE WHEN mapping.transition_kind = 'CORRECTION' THEN corrected.source_assertion_id END,
         CASE WHEN mapping.transition_kind NOT IN ('INITIAL', 'CORRECTION')
              THEN previous.source_assertion_id END,
         CASE WHEN mapping.transition_kind = 'INITIAL' THEN NULL ELSE mapping.acting_principal_id END,
         CASE WHEN mapping.transition_kind = 'INITIAL' THEN NULL ELSE mapping.reason END,
         mapping.action_invocation_id, mapping.acting_principal_id,
         'legacy-action:' || mapping.action_invocation_id::text, mapping.recorded_at
    FROM pricing_legacy_source_mapping AS mapping
    LEFT JOIN pricing_legacy_source_mapping AS corrected
      ON corrected.tenant_id = mapping.tenant_id
     AND corrected.legal_entity_id = mapping.legal_entity_id
     AND corrected.price_id = mapping.price_id
     AND corrected.price_revision_id = mapping.corrected_revision_id
    LEFT JOIN pricing_legacy_source_mapping AS previous
      ON previous.tenant_id = mapping.tenant_id
     AND previous.legal_entity_id = mapping.legal_entity_id
     AND previous.price_id = mapping.price_id
     AND previous.price_revision_id = mapping.previous_revision_id;
  GET DIAGNOSTICS v_revision_count = ROW_COUNT;

  INSERT INTO pricing.price_source_assertion_deliveries (
    source_assertion_delivery_id, tenant_id, legal_entity_id, price_id,
    source_assertion_id, delivered_source_assertion_id, delivered_evidence,
    action_invocation_id, recorded_by_principal_id, recorded_at, imported_at,
    request_correlation_id, stored_at
  )
  SELECT pg_catalog.gen_random_uuid(), assertion.tenant_id, assertion.legal_entity_id,
         assertion.price_id, assertion.source_assertion_id, assertion.source_assertion_id,
         pg_catalog.jsonb_build_object(
           'sourceFactFingerprint', assertion.source_fact_fingerprint,
           'legacyQualified', true
         ), assertion.action_invocation_id, assertion.recorded_by_principal_id,
         assertion.recorded_at, assertion.imported_at,
         assertion.request_correlation_id, assertion.stored_at
    FROM pricing.price_source_assertions AS assertion;
  GET DIAGNOSTICS v_delivery_count = ROW_COUNT;
  IF v_revision_count <> v_source_count OR v_delivery_count <> v_source_count THEN
    RAISE EXCEPTION 'Pricing source provenance legacy backfill was incomplete' USING ERRCODE = '55000';
  END IF;
END;
$backfill$;

ALTER TABLE pricing.prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing.prices FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_source_assertions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_source_assertions FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_source_assertion_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing.price_source_assertion_deliveries FORCE ROW LEVEL SECURITY;

CREATE FUNCTION pricing.price_source_provenance_json_v1(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_price_id uuid,
  p_price_revision_id uuid
) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'canonicalLink', pg_catalog.jsonb_build_object(
      'effectiveFrom', pg_catalog.to_char(
        revision.effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'identityKey', pg_catalog.jsonb_build_object(
        'catalogSelection', price.catalog_selection,
        'commercialScope', pg_catalog.jsonb_build_object(
          'channelId', price.channel_id,
          'marketId', price.market_id,
          'sellingLegalEntityId', price.legal_entity_id
        ),
        'currencyCode', price.currency_code,
        'priceGroupSelector', price.price_group_selector,
        'unitBasis', pg_catalog.jsonb_build_object(
          'quantity', price.basis_quantity::text,
          'unitRef', price.unit_ref
        )
      ),
      'monetaryAmount', pg_catalog.jsonb_build_object(
        'amount', revision.amount::text,
        'currencyCode', revision.currency_code
      ),
      'monetaryBoundary', 'PRE_TAX',
      'priceRef', pg_catalog.jsonb_build_object(
        'moduleId', 'commerce.pricing',
        'resourceId', price.price_id,
        'resourceType', 'commerce.pricing.price',
        'tenantId', price.tenant_id
      ),
      'revision', revision.revision_number,
      'revisionId', revision.price_revision_id
    ),
    'evidence', pg_catalog.jsonb_build_object(
      'lineage', CASE assertion.lineage_kind
        WHEN 'INITIAL' THEN pg_catalog.jsonb_build_object('kind', 'INITIAL')
        WHEN 'CORRECTION' THEN pg_catalog.jsonb_build_object(
          'actingPrincipalId', assertion.lineage_acting_principal_id,
          'correctedSourceAssertionId', assertion.corrected_source_assertion_id,
          'kind', 'CORRECTION',
          'reason', assertion.lineage_reason
        )
        ELSE pg_catalog.jsonb_build_object(
          'actingPrincipalId', assertion.lineage_acting_principal_id,
          'kind', 'SUPERSESSION',
          'reason', assertion.lineage_reason,
          'supersededSourceAssertionId', assertion.superseded_source_assertion_id
        ) END,
      'recordedAt', pg_catalog.to_char(
        assertion.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'sourceAssertion', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'lineage', CASE assertion.lineage_kind
          WHEN 'INITIAL' THEN pg_catalog.jsonb_build_object('kind', 'INITIAL')
          WHEN 'CORRECTION' THEN pg_catalog.jsonb_build_object(
            'correctedSourceAssertionId', assertion.corrected_source_assertion_id,
            'kind', 'CORRECTION',
            'reason', assertion.lineage_reason
          )
          ELSE pg_catalog.jsonb_build_object(
            'kind', 'SUPERSESSION',
            'reason', assertion.lineage_reason,
            'supersededSourceAssertionId', assertion.superseded_source_assertion_id
          ) END,
        'mapping', pg_catalog.jsonb_build_object(
          'mappingContractRef', assertion.mapping_contract_ref,
          'mappingContractVersion', assertion.mapping_contract_version
        ),
        'originalAssertion', assertion.original_assertion,
        'preTaxNormalization', assertion.pre_tax_normalization,
        'sourceAssertionId', assertion.source_assertion_id,
        'sourceAuthority', pg_catalog.jsonb_build_object(
          'sourceAuthorityRef', assertion.source_authority_ref,
          'sourceAuthorityVersion', assertion.source_authority_version
        ),
        'sourceRecord', pg_catalog.jsonb_build_object(
          'sourceChangeCorrelation', assertion.source_change_correlation,
          'sourceRecordRef', assertion.source_record_ref,
          'sourceRecordVersion', assertion.source_record_version,
          'sourceSystem', pg_catalog.jsonb_build_object(
            'ownerModuleId', assertion.source_owner_module_id,
            'sourceSystemRef', assertion.source_system_ref
          )
        ),
        'timing', pg_catalog.jsonb_build_object(
          'importedAt', pg_catalog.to_char(
            assertion.imported_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ),
          'ownerBusinessEffectiveAt', pg_catalog.to_char(
            assertion.owner_business_effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ),
          'sourceEffectiveAt', pg_catalog.to_char(
            assertion.source_effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          )
        )
      )),
      'sourceFactFingerprint', assertion.source_fact_fingerprint,
      'tenantId', assertion.tenant_id
    ),
    'provenanceRef', assertion.source_assertion_id
  )
    FROM pricing.price_source_assertions AS assertion
    JOIN pricing.price_revisions AS revision
      ON revision.tenant_id = assertion.tenant_id
     AND revision.legal_entity_id = assertion.legal_entity_id
     AND revision.price_id = assertion.price_id
     AND revision.price_revision_id = assertion.price_revision_id
    JOIN pricing.prices AS price
      ON price.tenant_id = revision.tenant_id
     AND price.legal_entity_id = revision.legal_entity_id
     AND price.price_id = revision.price_id
   WHERE assertion.tenant_id = p_tenant_id
     AND assertion.legal_entity_id = p_legal_entity_id
     AND assertion.price_id = p_price_id
     AND assertion.price_revision_id = p_price_revision_id;
$function$;

CREATE FUNCTION pricing.bind_price_retirement_provenance_v1(
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
  v_action_id uuid := (p_input ->> 'actionInvocationId')::uuid;
  v_assertion_id uuid := pg_catalog.gen_random_uuid();
  v_at timestamptz := (p_input ->> 'trustedOperationAt')::timestamptz;
  v_basis jsonb;
  v_evidence jsonb;
  v_predecessor uuid;
  v_price pricing.prices%ROWTYPE;
  v_revision pricing.price_revisions%ROWTYPE;
BEGIN
  SELECT revision.* INTO STRICT v_revision
    FROM pricing.price_revisions AS revision
   WHERE revision.tenant_id = p_tenant_id AND revision.legal_entity_id = p_legal_entity_id
     AND revision.price_id = p_price_id AND revision.price_revision_id = p_price_revision_id
     AND revision.transition_kind = 'RETIREMENT';
  SELECT price.* INTO STRICT v_price FROM pricing.prices AS price
   WHERE price.tenant_id = p_tenant_id AND price.legal_entity_id = p_legal_entity_id
     AND price.price_id = p_price_id;
  SELECT assertion.source_assertion_id INTO STRICT v_predecessor
    FROM pricing.price_source_assertions AS assertion
   WHERE assertion.tenant_id = p_tenant_id AND assertion.legal_entity_id = p_legal_entity_id
     AND assertion.price_id = p_price_id
     AND assertion.price_revision_id = v_revision.previous_revision_id;

  v_basis := pg_catalog.jsonb_build_object(
    'mapping', pg_catalog.jsonb_build_object(
      'mappingContractRef', 'commerce.pricing:retirement', 'mappingContractVersion', 'v2'
    ),
    'originalAssertion', pg_catalog.jsonb_build_object(
      'monetaryAmount', pg_catalog.jsonb_build_object(
        'amount', v_revision.amount::text, 'currencyCode', v_revision.currency_code
      ),
      'monetaryBoundary', 'PRE_TAX',
      'unitBasis', pg_catalog.jsonb_build_object(
        'quantity', v_price.basis_quantity::text, 'unitRef', v_price.unit_ref
      )
    ),
    'sourceAuthority', pg_catalog.jsonb_build_object(
      'sourceAuthorityRef', 'commerce.pricing:owner-operation', 'sourceAuthorityVersion', 'v2'
    ),
    'sourceRecord', pg_catalog.jsonb_build_object(
      'sourceChangeCorrelation', v_action_id::text,
      'sourceRecordRef', 'pricing-action:' || v_action_id::text,
      'sourceRecordVersion', 'retirement-v2',
      'sourceSystem', pg_catalog.jsonb_build_object(
        'ownerModuleId', 'commerce.pricing', 'sourceSystemRef', 'commerce.pricing:owner-actions'
      )
    ),
    'timing', pg_catalog.jsonb_build_object(
      'ownerBusinessEffectiveAt', v_revision.effective_from,
      'sourceEffectiveAt', v_revision.effective_from
    )
  );
  v_evidence := pg_catalog.jsonb_build_object(
    'lineage', pg_catalog.jsonb_build_object(
      'actingPrincipalId', p_input ->> 'actingPrincipalId',
      'kind', 'SUPERSESSION',
      'reason', p_input ->> 'reason',
      'supersededSourceAssertionId', v_predecessor
    ),
    'recordedAt', v_at,
    'sourceAssertion', pg_catalog.jsonb_build_object(
      'lineage', pg_catalog.jsonb_build_object(
        'kind', 'SUPERSESSION',
        'reason', p_input ->> 'reason',
        'supersededSourceAssertionId', v_predecessor
      ),
      'mapping', v_basis -> 'mapping',
      'originalAssertion', v_basis -> 'originalAssertion',
      'sourceAssertionId', v_assertion_id,
      'sourceAuthority', v_basis -> 'sourceAuthority',
      'sourceRecord', v_basis -> 'sourceRecord',
      'timing', pg_catalog.jsonb_build_object(
        'importedAt', v_at,
        'ownerBusinessEffectiveAt', v_revision.effective_from,
        'sourceEffectiveAt', v_revision.effective_from
      )
    ),
    'sourceFactFingerprint', pg_catalog.encode(public.digest(v_basis::text, 'sha256'), 'hex'),
    'tenantId', p_tenant_id
  );
  RETURN pricing.bind_price_source_provenance_v1(
    p_tenant_id, p_legal_entity_id, p_price_id, p_price_revision_id,
    p_input || pg_catalog.jsonb_build_object('sourceEvidence', v_evidence)
  );
EXCEPTION WHEN no_data_found THEN
  RETURN pg_catalog.jsonb_build_object('outcome', 'CONFLICT', 'reason', 'SOURCE_LINEAGE_INVALID');
END;
$function$;

CREATE FUNCTION pricing.define_price_v2(
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
  v_binding jsonb;
  v_failure jsonb;
  v_price_id uuid;
  v_price_revision_id uuid;
  v_result jsonb;
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
  RETURN QUERY SELECT v_result;
END;
$function$;

CREATE FUNCTION pricing.revise_price_v2(
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
  v_binding jsonb;
  v_failure jsonb;
  v_price_id uuid;
  v_price_revision_id uuid;
  v_result jsonb;
BEGIN
  BEGIN
    SELECT legacy.payload INTO v_result
      FROM pricing.revise_price_v1(p_tenant_id, p_legal_entity_id, p_input) AS legacy;
    IF v_result ->> 'outcome' IN ('REVISED', 'UNCHANGED') THEN
      v_price_id := (v_result #>> '{revision,definition,priceRef,resourceId}')::uuid;
      v_price_revision_id := (v_result #>> '{revision,definition,revision,revisionId}')::uuid;
      v_binding := CASE WHEN p_input ->> 'intent' = 'RETIRE_CURRENT'
        THEN pricing.bind_price_retirement_provenance_v1(
          p_tenant_id, p_legal_entity_id, v_price_id, v_price_revision_id, p_input
        )
        ELSE pricing.bind_price_source_provenance_v1(
          p_tenant_id, p_legal_entity_id, v_price_id, v_price_revision_id, p_input
        ) END;
      IF v_binding ->> 'outcome' NOT IN ('RECORDED', 'REUSED') THEN
        v_failure := v_binding;
        RAISE EXCEPTION 'Pricing source provenance rejected' USING ERRCODE = 'P7601';
      END IF;
      v_result := v_result || pg_catalog.jsonb_build_object('provenance', v_binding -> 'provenance');
    END IF;
  EXCEPTION WHEN SQLSTATE 'P7601' THEN
    v_result := v_failure;
  END;
  RETURN QUERY SELECT v_result;
END;
$function$;

REVOKE ALL ON FUNCTION pricing.price_source_provenance_json_v1(uuid, uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.bind_price_retirement_provenance_v1(uuid, uuid, uuid, uuid, jsonb) FROM PUBLIC, ontos_runtime;
REVOKE ALL ON FUNCTION pricing.define_price_v2(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.revise_price_v2(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pricing.price_source_provenance_json_v1(uuid, uuid, uuid, uuid) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.define_price_v2(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.revise_price_v2(uuid, uuid, jsonb) TO ontos_runtime;

CREATE FUNCTION pricing.bind_price_source_provenance_v1(
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

  IF (v_canonical.transition_kind = 'INITIAL' AND v_trusted_lineage ->> 'kind' <> 'INITIAL')
    OR (v_canonical.transition_kind = 'CORRECTION' AND v_trusted_lineage ->> 'kind' <> 'CORRECTION')
    OR (v_canonical.transition_kind NOT IN ('INITIAL', 'CORRECTION')
        AND v_trusted_lineage ->> 'kind' <> 'SUPERSESSION')
  THEN
    RETURN pg_catalog.jsonb_build_object('outcome', 'CONFLICT', 'reason', 'SOURCE_LINEAGE_INVALID');
  END IF;
  IF v_trusted_lineage ->> 'kind' = 'CORRECTION' AND NOT EXISTS (
    SELECT 1 FROM pricing.price_source_assertions AS predecessor
     WHERE predecessor.tenant_id = p_tenant_id AND predecessor.legal_entity_id = p_legal_entity_id
       AND predecessor.price_id = p_price_id
       AND predecessor.source_assertion_id = (v_trusted_lineage ->> 'correctedSourceAssertionId')::uuid
       AND predecessor.price_revision_id = v_canonical.corrected_revision_id
  ) THEN
    RETURN pg_catalog.jsonb_build_object('outcome', 'CONFLICT', 'reason', 'SOURCE_LINEAGE_INVALID');
  END IF;
  IF v_trusted_lineage ->> 'kind' = 'SUPERSESSION' AND NOT EXISTS (
    SELECT 1 FROM pricing.price_source_assertions AS predecessor
     WHERE predecessor.tenant_id = p_tenant_id AND predecessor.legal_entity_id = p_legal_entity_id
       AND predecessor.price_id = p_price_id
       AND predecessor.source_assertion_id = (v_trusted_lineage ->> 'supersededSourceAssertionId')::uuid
       AND predecessor.price_revision_id = v_canonical.previous_revision_id
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
FROM PUBLIC, ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.bind_price_source_provenance_v1(uuid, uuid, uuid, uuid, jsonb)
TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.bind_price_retirement_provenance_v1(uuid, uuid, uuid, uuid, jsonb)
TO ontos_runtime;
