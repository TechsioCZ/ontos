ALTER TABLE pricing.fee_action_invocation_receipts FORCE ROW LEVEL SECURITY;

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
  v_catalog_evidence jsonb := p_input -> 'catalogTargetEvidence';
  v_catalog_captured_at timestamptz;
  v_product_ref jsonb;
  v_variant_ref jsonb;
  v_unit_ref jsonb;
  v_basis_kind text;
  v_basis_quantity numeric(38,9);
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
  v_command jsonb;
  v_command_fingerprint text;
  v_replay record;
  v_receipt record;
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
    v_catalog_captured_at := (p_input #>> '{catalogTargetEvidence,capturedAt}')::timestamptz;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Pricing Commercial Fee revision input is invalid' USING ERRCODE = '22023';
  END;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_tenant_id::text || ':commercial-fee-action:' || v_action_invocation_id::text,
      0
    )
  );
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
  v_product_ref := v_catalog_evidence -> 'productRef';
  v_variant_ref := v_identity #> '{target,variantRef}';
  v_unit_ref := v_identity #> '{calculationBasis,unitBasis,unitRef}';
  v_basis_kind := v_identity #>> '{calculationBasis,kind}';
  IF v_basis_kind = 'FIXED_PER_UNIT' THEN
    BEGIN
      v_basis_quantity := (v_identity #>> '{calculationBasis,unitBasis,quantity}')::numeric(38,9);
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Pricing Commercial Fee revision input is invalid' USING ERRCODE = '22023';
    END;
  END IF;
  IF v_action_invocation_id IS NULL OR v_acting_principal_id IS NULL OR v_trusted_at IS NULL
    OR v_amount < 0 OR v_currency !~ '^[A-Z]{3}$' OR v_identity ->> 'currencyCode' !~ '^[A-Z]{3}$'
    OR v_identity #>> '{commercialScope,sellingLegalEntityId}' <> p_legal_entity_id::text
    OR v_identity ->> 'family' NOT IN ('RECYCLING_FEE', 'COPYRIGHT_FEE')
    OR v_identity ->> 'monetaryBoundary' <> 'PRE_TAX'
    OR v_identity #>> '{commercialScope,channelId}' NOT IN ('B2C', 'B2B')
    OR v_identity #>> '{commercialScope,marketId}' IS NULL
    OR v_identity #>> '{commercialScope,marketId}' <> btrim(v_identity #>> '{commercialScope,marketId}')
    OR length(v_identity #>> '{commercialScope,marketId}') NOT BETWEEN 1 AND 300
    OR v_identity #>> '{commercialScope,marketId}' = '*'
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
    OR v_intent NOT IN ('VALUE_ONLY_CURRENT', 'SCHEDULE_REVISION')
    OR v_reason IS NULL OR v_reason <> btrim(v_reason) OR length(v_reason) NOT BETWEEN 1 AND 1000
    OR v_request_correlation IS NULL OR v_request_correlation <> btrim(v_request_correlation)
    OR length(v_request_correlation) NOT BETWEEN 1 AND 500
  THEN
    RAISE EXCEPTION 'Pricing Commercial Fee revision input is invalid' USING ERRCODE = '22023';
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
  IF v_intent = 'SCHEDULE_REVISION' THEN
    BEGIN
      v_effective_from := (p_input #>> '{effectivePeriod,effectiveFrom}')::timestamptz;
      IF p_input #> '{effectivePeriod,effectiveTo}' <> 'null'::jsonb THEN
        v_effective_to := (p_input #>> '{effectivePeriod,effectiveTo}')::timestamptz;
      END IF;
    EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
      RAISE EXCEPTION 'Pricing Commercial Fee scheduled period is invalid' USING ERRCODE = '22023';
    END;
  END IF;
  v_command := jsonb_build_object(
    'acknowledgement', v_supplied_ack,
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
    'effectivePeriod', CASE WHEN v_intent = 'SCHEDULE_REVISION' THEN jsonb_build_object(
      'effectiveFrom', to_jsonb(v_effective_from), 'effectiveTo', to_jsonb(v_effective_to)
    ) ELSE NULL END,
    'expectedCurrent', CASE WHEN v_intent = 'VALUE_ONLY_CURRENT' THEN p_input -> 'expectedCurrent' ELSE NULL END,
    'expectedScheduleRevision', CASE WHEN v_intent = 'SCHEDULE_REVISION'
      THEN to_jsonb((p_input ->> 'expectedScheduleRevision')::integer) ELSE NULL END,
    'identityKey', pricing.fee_identity_json_v1(p_tenant_id, p_legal_entity_id, v_fee_id),
    'intent', v_intent,
    'reason', v_reason,
    'requestCorrelationId', v_request_correlation,
    'trustedOperationAt', to_jsonb(v_trusted_at)
  );
  v_command_fingerprint := pg_catalog.encode(
    public.digest(pg_catalog.convert_to(v_command::text, 'UTF8'), 'sha256'), 'hex'
  );
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

  SELECT receipt.fee_id, receipt.command_fingerprint, receipt.result_schedule_revision
    INTO v_receipt
    FROM pricing.fee_action_invocation_receipts AS receipt
   WHERE receipt.tenant_id = p_tenant_id
     AND receipt.action_invocation_id = v_action_invocation_id;
  IF FOUND THEN
    IF v_receipt.fee_id IS DISTINCT FROM v_fee_id
      OR v_receipt.command_fingerprint IS DISTINCT FROM v_command_fingerprint
    THEN
      RETURN QUERY SELECT jsonb_build_object(
        'identityKey', v_identity,
        'outcome', 'COMMERCIAL_FEE_CONFLICT',
        'reason', 'IDENTITY_MISMATCH'
      );
      RETURN;
    END IF;
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

  SELECT revision.fee_id, revision.command_fingerprint
    INTO v_replay
    FROM pricing.fee_schedule_revisions AS revision
   WHERE revision.tenant_id = p_tenant_id
     AND revision.action_invocation_id = v_action_invocation_id;
  IF FOUND THEN
    IF v_replay.fee_id IS DISTINCT FROM v_fee_id
      OR v_replay.command_fingerprint IS DISTINCT FROM v_command_fingerprint
    THEN
      RETURN QUERY SELECT jsonb_build_object(
        'identityKey', v_identity,
        'outcome', 'COMMERCIAL_FEE_CONFLICT',
        'reason', 'IDENTITY_MISMATCH'
      );
      RETURN;
    END IF;
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
      INSERT INTO pricing.fee_action_invocation_receipts (
        tenant_id, legal_entity_id, fee_id, action_invocation_id,
        command_fingerprint, outcome, result_schedule_revision, acting_principal_id
      ) VALUES (
        p_tenant_id, p_legal_entity_id, v_fee_id, v_action_invocation_id,
        v_command_fingerprint, 'COMMERCIAL_FEE_UNCHANGED', v_schedule_revision, v_acting_principal_id
      );
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
      revision_number, amount, currency_code, catalog_target_evidence, previous_revision_id,
      corrected_revision_id, transition_kind, action_invocation_id, acting_principal_id, reason
    ) VALUES (
      v_new_revision_id, p_tenant_id, p_legal_entity_id, v_fee_id,
      v_new_revision_number, v_amount, v_currency, v_command -> 'catalogTargetEvidence', v_current_revision_id,
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
      revision_number, amount, currency_code, catalog_target_evidence, previous_revision_id,
      corrected_revision_id, transition_kind, action_invocation_id, acting_principal_id, reason
    ) VALUES (
      v_new_revision_id, p_tenant_id, p_legal_entity_id, v_fee_id,
      v_new_revision_number, v_amount, v_currency, v_command -> 'catalogTargetEvidence', v_previous_revision_id,
      NULL, 'SCHEDULED', v_action_invocation_id, v_acting_principal_id, v_reason
    );
  END IF;

  INSERT INTO pricing.fee_schedule_revisions (
    fee_schedule_revision_id, tenant_id, legal_entity_id, fee_id,
    schedule_revision, previous_schedule_revision_id, action_invocation_id,
    command_fingerprint, acting_principal_id, reason
  ) VALUES (
    v_new_schedule_revision_id, p_tenant_id, p_legal_entity_id, v_fee_id,
    v_new_schedule_revision, v_head_revision_id, v_action_invocation_id,
    v_command_fingerprint, v_acting_principal_id, v_reason
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

REVOKE ALL ON FUNCTION pricing.revise_commercial_fee_v1(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pricing.revise_commercial_fee_v1(uuid, uuid, jsonb) TO ontos_runtime;
GRANT SELECT, INSERT ON TABLE pricing.fee_action_invocation_receipts TO ontos_runtime;
