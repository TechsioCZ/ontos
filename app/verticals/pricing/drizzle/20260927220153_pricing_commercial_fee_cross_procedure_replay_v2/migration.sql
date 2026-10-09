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
  v_trusted_at timestamptz;
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
  v_catalog_evidence jsonb := p_input -> 'catalogTargetEvidence';
  v_catalog_captured_at timestamptz;
  v_product_ref jsonb;
  v_variant_ref jsonb;
  v_unit_ref jsonb;
  v_channel_id text;
  v_market_id text;
  v_reason text;
  v_request_correlation text;
  v_command jsonb;
  v_command_fingerprint text;
  v_existing record;
  v_receipt record;
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
    v_trusted_at := (p_input ->> 'trustedOperationAt')::timestamptz;
    v_catalog_captured_at := (p_input #>> '{catalogTargetEvidence,capturedAt}')::timestamptz;
    v_effective_from := (p_input #>> '{effectivePeriod,effectiveFrom}')::timestamptz;
    IF p_input #> '{effectivePeriod,effectiveTo}' <> 'null'::jsonb THEN
      v_effective_to := (p_input #>> '{effectivePeriod,effectiveTo}')::timestamptz;
    END IF;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Pricing Commercial Fee write input is invalid' USING ERRCODE = '22023';
  END;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_tenant_id::text || ':commercial-fee-action:' || v_action_invocation_id::text,
      0
    )
  );
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
  v_product_ref := v_catalog_evidence -> 'productRef';
  v_variant_ref := v_identity #> '{target,variantRef}';
  v_unit_ref := v_identity #> '{calculationBasis,unitBasis,unitRef}';
  v_channel_id := v_identity #>> '{commercialScope,channelId}';
  v_market_id := v_identity #>> '{commercialScope,marketId}';
  v_reason := p_input ->> 'reason';
  v_request_correlation := p_input ->> 'requestCorrelationId';

  IF v_action_invocation_id IS NULL OR v_acting_principal_id IS NULL OR v_trusted_at IS NULL OR v_amount < 0
    OR v_effective_from IS NULL OR (v_effective_to IS NOT NULL AND v_effective_to <= v_effective_from)
    OR v_currency !~ '^[A-Z]{3}$' OR v_identity ->> 'currencyCode' !~ '^[A-Z]{3}$'
    OR v_family NOT IN ('RECYCLING_FEE', 'COPYRIGHT_FEE')
    OR v_identity ->> 'monetaryBoundary' <> 'PRE_TAX'
    OR v_identity #>> '{commercialScope,sellingLegalEntityId}' <> p_legal_entity_id::text
    OR v_channel_id NOT IN ('B2C', 'B2B')
    OR v_market_id IS NULL OR v_market_id <> btrim(v_market_id)
    OR length(v_market_id) NOT BETWEEN 1 AND 300 OR v_market_id = '*'
    OR jsonb_typeof(v_catalog_evidence) <> 'object'
    OR jsonb_typeof(v_product_ref) <> 'object' OR jsonb_typeof(v_variant_ref) <> 'object'
    OR v_catalog_captured_at IS NULL
    OR v_catalog_evidence ->> 'catalogOwnerRevision' IS NULL
    OR v_catalog_evidence ->> 'catalogOwnerRevision' <> btrim(v_catalog_evidence ->> 'catalogOwnerRevision')
    OR length(v_catalog_evidence ->> 'catalogOwnerRevision') NOT BETWEEN 1 AND 300
    OR v_catalog_evidence ->> 'snapshotId' IS NULL
    OR v_catalog_evidence ->> 'snapshotId' <> btrim(v_catalog_evidence ->> 'snapshotId')
    OR length(v_catalog_evidence ->> 'snapshotId') NOT BETWEEN 1 AND 300
    OR v_catalog_evidence ->> 'targetId' IS NULL
    OR v_catalog_evidence ->> 'targetId' <> btrim(v_catalog_evidence ->> 'targetId')
    OR length(v_catalog_evidence ->> 'targetId') NOT BETWEEN 1 AND 300
    OR v_basis_kind NOT IN ('FIXED_PER_LINE', 'FIXED_PER_UNIT')
    OR (v_basis_kind = 'FIXED_PER_LINE' AND (v_basis_quantity IS NOT NULL OR v_unit_ref IS NOT NULL))
    OR (v_basis_kind = 'FIXED_PER_UNIT' AND (v_basis_quantity <= 0 OR jsonb_typeof(v_unit_ref) <> 'object'))
    OR v_reason IS NULL OR v_reason <> btrim(v_reason) OR length(v_reason) NOT BETWEEN 1 AND 1000
    OR v_request_correlation IS NULL OR v_request_correlation <> btrim(v_request_correlation)
    OR length(v_request_correlation) NOT BETWEEN 1 AND 500
  THEN
    RAISE EXCEPTION 'Pricing Commercial Fee write input is invalid' USING ERRCODE = '22023';
  END IF;
  BEGIN
    IF v_product_ref IS DISTINCT FROM jsonb_build_object(
         'moduleId', 'commerce.catalog',
         'resourceId', ((v_product_ref ->> 'resourceId')::uuid)::text,
         'resourceType', 'commerce.catalog.product',
         'tenantId', p_tenant_id::text
       )
      OR v_variant_ref IS DISTINCT FROM jsonb_build_object(
         'moduleId', 'commerce.catalog',
         'resourceId', ((v_variant_ref ->> 'resourceId')::uuid)::text,
         'resourceType', 'commerce.catalog.variant',
         'tenantId', p_tenant_id::text
       )
      OR v_catalog_evidence -> 'variantRef' IS DISTINCT FROM v_variant_ref
      OR (v_basis_kind = 'FIXED_PER_UNIT' AND v_unit_ref IS DISTINCT FROM jsonb_build_object(
         'moduleId', 'commerce.catalog',
         'resourceId', ((v_unit_ref ->> 'resourceId')::uuid)::text,
         'resourceType', 'commerce.catalog.product-unit',
         'tenantId', p_tenant_id::text
       ))
    THEN
      RAISE EXCEPTION 'Pricing Commercial Fee ResourceRef is not canonical' USING ERRCODE = '22023';
    END IF;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Pricing Commercial Fee ResourceRef is not canonical' USING ERRCODE = '22023';
  END;
  IF v_currency IS DISTINCT FROM v_identity ->> 'currencyCode' THEN
    RETURN QUERY SELECT jsonb_build_object(
      'identityKey', v_identity,
      'outcome', 'COMMERCIAL_FEE_CONFLICT',
      'reason', 'IDENTITY_MISMATCH'
    );
    RETURN;
  END IF;

  v_command := jsonb_build_object(
    'acknowledgement', NULL,
    'actingPrincipalId', v_acting_principal_id::text,
    'catalogTargetEvidence', jsonb_build_object(
      'capturedAt', to_jsonb(v_catalog_captured_at),
      'catalogOwnerRevision', v_catalog_evidence ->> 'catalogOwnerRevision',
      'productRef', v_product_ref,
      'snapshotId', v_catalog_evidence ->> 'snapshotId',
      'targetId', v_catalog_evidence ->> 'targetId',
      'variantRef', v_variant_ref
    ),
    'configuredAmount', jsonb_build_object('amount', v_amount::text, 'currencyCode', v_currency),
    'effectivePeriod', jsonb_build_object('effectiveFrom', to_jsonb(v_effective_from), 'effectiveTo', to_jsonb(v_effective_to)),
    'expectedCurrent', NULL,
    'expectedScheduleRevision', NULL,
    'identityKey', jsonb_build_object(
      'calculationBasis', CASE WHEN v_basis_kind = 'FIXED_PER_LINE'
        THEN jsonb_build_object('kind', 'FIXED_PER_LINE')
        ELSE jsonb_build_object('kind', 'FIXED_PER_UNIT', 'unitBasis', jsonb_build_object(
          'quantity', v_basis_quantity::text, 'unitRef', v_unit_ref
        )) END,
      'commercialScope', jsonb_build_object(
        'sellingLegalEntityId', p_legal_entity_id::text, 'channelId', v_channel_id, 'marketId', v_market_id
      ),
      'currencyCode', v_currency,
      'family', v_family,
      'monetaryBoundary', 'PRE_TAX',
      'target', jsonb_build_object('variantRef', v_variant_ref)
    ),
    'intent', 'DEFINE',
    'reason', v_reason,
    'requestCorrelationId', v_request_correlation,
    'trustedOperationAt', to_jsonb(v_trusted_at)
  );
  v_command_fingerprint := pg_catalog.encode(
    public.digest(pg_catalog.convert_to(v_command::text, 'UTF8'), 'sha256'), 'hex'
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_tenant_id::text || ':' || p_legal_entity_id::text || ':' || v_family || ':' ||
      v_variant_ref::text || ':' || v_channel_id || ':' || v_market_id || ':' || v_basis_kind || ':' ||
      coalesce(v_basis_quantity::text, '') || ':' || coalesce(v_unit_ref::text, '') || ':' || v_currency,
      0
    )
  );
  v_fee_id := pricing.fee_id_for_identity_v1(p_tenant_id, p_legal_entity_id, v_identity);
  SELECT receipt.fee_id, receipt.command_fingerprint
    INTO v_receipt
    FROM pricing.fee_action_invocation_receipts AS receipt
   WHERE receipt.tenant_id = p_tenant_id
     AND receipt.action_invocation_id = v_action_invocation_id;
  IF FOUND THEN
    RETURN QUERY SELECT jsonb_build_object(
      'identityKey', v_identity,
      'outcome', 'COMMERCIAL_FEE_CONFLICT',
      'reason', 'IDENTITY_MISMATCH'
    );
    RETURN;
  END IF;

  SELECT schedule_revision.fee_id,
         schedule_revision.command_fingerprint,
         revision.fee_revision_id,
         entry.effective_from,
         entry.effective_to
    INTO v_existing
    FROM pricing.fee_schedule_revisions AS schedule_revision
    JOIN pricing.fee_revisions AS revision
      ON revision.tenant_id = schedule_revision.tenant_id
     AND revision.legal_entity_id = schedule_revision.legal_entity_id
     AND revision.fee_id = schedule_revision.fee_id
     AND revision.action_invocation_id = schedule_revision.action_invocation_id
    JOIN pricing.fee_schedule_entries AS entry
      ON entry.tenant_id = schedule_revision.tenant_id
     AND entry.legal_entity_id = schedule_revision.legal_entity_id
     AND entry.fee_id = schedule_revision.fee_id
     AND entry.fee_schedule_revision_id = schedule_revision.fee_schedule_revision_id
     AND entry.fee_revision_id = revision.fee_revision_id
   WHERE schedule_revision.tenant_id = p_tenant_id
     AND schedule_revision.action_invocation_id = v_action_invocation_id;
  IF FOUND THEN
    IF v_existing.fee_id IS DISTINCT FROM v_fee_id
      OR v_existing.command_fingerprint IS DISTINCT FROM v_command_fingerprint
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
  IF v_fee_id IS NOT NULL THEN
    RETURN QUERY SELECT jsonb_build_object(
      'identityKey', pricing.fee_identity_json_v1(p_tenant_id, p_legal_entity_id, v_fee_id),
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
    revision_number, amount, currency_code, catalog_target_evidence, previous_revision_id,
    corrected_revision_id, transition_kind, action_invocation_id, acting_principal_id, reason
  ) VALUES (
    v_fee_revision_id, p_tenant_id, p_legal_entity_id, v_fee_id,
    1, v_amount, v_currency, v_command -> 'catalogTargetEvidence', NULL, NULL, 'INITIAL',
    v_action_invocation_id, v_acting_principal_id, v_reason
  );
  INSERT INTO pricing.fee_schedule_revisions (
    fee_schedule_revision_id, tenant_id, legal_entity_id, fee_id,
    schedule_revision, previous_schedule_revision_id, action_invocation_id,
    command_fingerprint, acting_principal_id, reason
  ) VALUES (
    v_fee_schedule_revision_id, p_tenant_id, p_legal_entity_id, v_fee_id,
    1, NULL, v_action_invocation_id, v_command_fingerprint, v_acting_principal_id, v_reason
  );
  INSERT INTO pricing.fee_schedule_entries (
    tenant_id, legal_entity_id, fee_id, fee_revision_id,
    fee_schedule_revision_id, schedule_revision, effective_from, effective_to
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_fee_id, v_fee_revision_id,
    v_fee_schedule_revision_id, 1, v_effective_from, v_effective_to
  );
  INSERT INTO pricing.fee_schedule_heads (
    tenant_id, legal_entity_id, fee_id, fee_schedule_revision_id, schedule_revision
  ) VALUES (
    p_tenant_id, p_legal_entity_id, v_fee_id, v_fee_schedule_revision_id, 1
  );
  v_definition := pricing.scheduled_fee_revision_json_v1(
    p_tenant_id, p_legal_entity_id, v_fee_id,
    v_fee_revision_id, v_effective_from, v_effective_to
  ) -> 'definition';
  RETURN QUERY SELECT jsonb_build_object('definition', v_definition, 'outcome', 'COMMERCIAL_FEE_CREATED');
END;
$function$;

REVOKE ALL ON FUNCTION pricing.define_commercial_fee_v1(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pricing.define_commercial_fee_v1(uuid, uuid, jsonb) TO ontos_runtime;
