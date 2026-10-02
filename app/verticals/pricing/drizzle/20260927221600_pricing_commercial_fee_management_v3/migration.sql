-- #797 Commercial Fee management intents not covered by the #773 fact runtime.
-- Existing DEFINE, VALUE_ONLY_CURRENT, and SCHEDULE_REVISION semantics stay on
-- revise_commercial_fee_v1. This routine owns immutable correction and explicit
-- Current retirement while retaining the same invocation registry and schedule CAS.
CREATE OR REPLACE FUNCTION pricing.manage_commercial_fee_revision_v1(
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
  v_canonical_identity jsonb;
  v_intent text := p_input ->> 'intent';
  v_action_invocation_id uuid;
  v_acting_principal_id uuid;
  v_trusted_at timestamptz;
  v_reason text := p_input ->> 'reason';
  v_request_correlation text := p_input ->> 'requestCorrelationId';
  v_fee_id uuid;
  v_head_revision_id uuid;
  v_schedule_revision integer;
  v_new_schedule_revision integer;
  v_new_schedule_revision_id uuid := pg_catalog.gen_random_uuid();
  v_new_revision_id uuid := pg_catalog.gen_random_uuid();
  v_new_revision_number integer;
  v_command jsonb;
  v_command_fingerprint text;
  v_receipt record;
  v_replay record;
  v_schedule_result jsonb;
  v_updated_count integer;

  v_catalog_evidence jsonb := p_input -> 'catalogTargetEvidence';
  v_normalized_catalog_evidence jsonb;
  v_catalog_captured_at timestamptz;
  v_product_ref jsonb;
  v_variant_ref jsonb;
  v_amount_text text;
  v_amount numeric(38,9);
  v_currency text;
  v_expected_schedule_revision integer;
  v_target_revision_id uuid;
  v_target_expected_from timestamptz;
  v_target_expected_to timestamptz;
  v_target_count integer;
  v_target_entry_id uuid;
  v_target_revision_number integer;
  v_target_amount numeric(38,9);
  v_target_currency text;
  v_target_catalog_evidence jsonb;
  v_target_from timestamptz;
  v_target_to timestamptz;

  v_current_count integer;
  v_current_entry_id uuid;
  v_current_revision_id uuid;
  v_current_revision_number integer;
  v_current_amount numeric(38,9);
  v_current_currency text;
  v_current_catalog_evidence jsonb;
  v_current_from timestamptz;
  v_current_to timestamptz;
  v_future jsonb;
  v_ack_body jsonb;
  v_ack jsonb;
  v_ack_fingerprint text;
  v_supplied_ack jsonb := p_input -> 'acknowledgement';
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Pricing Commercial Fee management scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_input IS NULL OR jsonb_typeof(p_input) <> 'object' OR jsonb_typeof(v_identity) <> 'object'
    OR v_intent NOT IN ('CORRECT_REVISION', 'RETIRE_CURRENT')
    OR v_reason IS NULL OR v_reason <> btrim(v_reason) OR length(v_reason) NOT BETWEEN 1 AND 1000
    OR v_request_correlation IS NULL OR v_request_correlation <> btrim(v_request_correlation)
    OR length(v_request_correlation) NOT BETWEEN 1 AND 500
  THEN
    RAISE EXCEPTION 'Pricing Commercial Fee management input is invalid' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_action_invocation_id := (p_input ->> 'actionInvocationId')::uuid;
    v_acting_principal_id := (p_input ->> 'actingPrincipalId')::uuid;
    v_trusted_at := (p_input ->> 'trustedOperationAt')::timestamptz;
    v_fee_id := pricing.fee_id_for_identity_v1(p_tenant_id, p_legal_entity_id, v_identity);
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Pricing Commercial Fee management input is invalid' USING ERRCODE = '22023';
  END;
  IF v_action_invocation_id IS NULL OR v_acting_principal_id IS NULL OR v_trusted_at IS NULL THEN
    RAISE EXCEPTION 'Pricing Commercial Fee management input is invalid' USING ERRCODE = '22023';
  END IF;
  IF v_fee_id IS NULL THEN
    RETURN QUERY SELECT jsonb_build_object(
      'identityKey', v_identity,
      'outcome', 'COMMERCIAL_FEE_CONFLICT',
      'reason', 'IDENTITY_MISMATCH'
    );
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_tenant_id::text || ':commercial-fee-action:' || v_action_invocation_id::text,
      0
    )
  );
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
  v_canonical_identity := pricing.fee_identity_json_v1(p_tenant_id, p_legal_entity_id, v_fee_id);

  IF v_intent = 'CORRECT_REVISION' THEN
    v_amount_text := p_input #>> '{configuredAmount,amount}';
    IF v_amount_text IS NULL OR v_amount_text !~ '^(0|[1-9][0-9]{0,28})(\.[0-9]{1,9})?$' THEN
      RAISE EXCEPTION 'Pricing Commercial Fee correction amount is invalid' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_amount := v_amount_text::numeric(38,9);
      v_currency := p_input #>> '{configuredAmount,currencyCode}';
      v_expected_schedule_revision := (p_input ->> 'expectedScheduleRevision')::integer;
      v_target_revision_id := (p_input ->> 'targetRevisionId')::uuid;
      v_target_expected_from := (p_input #>> '{targetEffectivePeriod,effectiveFrom}')::timestamptz;
      IF p_input #> '{targetEffectivePeriod,effectiveTo}' <> 'null'::jsonb THEN
        v_target_expected_to := (p_input #>> '{targetEffectivePeriod,effectiveTo}')::timestamptz;
      END IF;
      v_catalog_captured_at := (p_input #>> '{catalogTargetEvidence,capturedAt}')::timestamptz;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN
      RAISE EXCEPTION 'Pricing Commercial Fee correction input is invalid' USING ERRCODE = '22023';
    END;
    v_product_ref := v_catalog_evidence -> 'productRef';
    v_variant_ref := v_catalog_evidence -> 'variantRef';
    IF v_amount < 0 OR v_currency IS DISTINCT FROM v_canonical_identity ->> 'currencyCode'
      OR v_expected_schedule_revision IS NULL OR v_expected_schedule_revision < 1
      OR v_target_revision_id IS NULL OR jsonb_typeof(v_catalog_evidence) <> 'object'
      OR v_target_expected_from IS NULL
      OR (v_target_expected_to IS NOT NULL AND v_target_expected_to <= v_target_expected_from)
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
    THEN
      RAISE EXCEPTION 'Pricing Commercial Fee correction input is invalid' USING ERRCODE = '22023';
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
        OR v_variant_ref IS DISTINCT FROM v_canonical_identity #> '{target,variantRef}'
      THEN
        RAISE EXCEPTION 'Pricing Commercial Fee correction evidence is not canonical' USING ERRCODE = '22023';
      END IF;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Pricing Commercial Fee correction evidence is not canonical' USING ERRCODE = '22023';
    END;
    v_normalized_catalog_evidence := jsonb_build_object(
      'capturedAt', to_jsonb(v_catalog_captured_at),
      'catalogOwnerRevision', v_catalog_evidence ->> 'catalogOwnerRevision',
      'productRef', v_product_ref,
      'snapshotId', v_catalog_evidence ->> 'snapshotId',
      'targetId', v_catalog_evidence ->> 'targetId',
      'variantRef', v_variant_ref
    );
  ELSE
    IF p_input ? 'configuredAmount' OR p_input ? 'catalogTargetEvidence'
      OR p_input ? 'expectedScheduleRevision' OR p_input ? 'targetRevisionId'
    THEN
      RAISE EXCEPTION 'Pricing Commercial Fee retirement input is invalid' USING ERRCODE = '22023';
    END IF;
  END IF;

  v_command := jsonb_build_object(
    'acknowledgement', CASE WHEN v_intent = 'RETIRE_CURRENT' THEN v_supplied_ack ELSE NULL END,
    'actingPrincipalId', v_acting_principal_id::text,
    'catalogTargetEvidence', CASE WHEN v_intent = 'CORRECT_REVISION' THEN v_normalized_catalog_evidence ELSE NULL END,
    'configuredAmount', CASE WHEN v_intent = 'CORRECT_REVISION' THEN
      jsonb_build_object('amount', v_amount::text, 'currencyCode', v_currency) ELSE NULL END,
    'effectivePeriod', NULL,
    'expectedCurrent', CASE WHEN v_intent = 'RETIRE_CURRENT' THEN p_input -> 'expectedCurrent' ELSE NULL END,
    'expectedScheduleRevision', CASE WHEN v_intent = 'CORRECT_REVISION'
      THEN to_jsonb(v_expected_schedule_revision) ELSE NULL END,
    'identityKey', v_canonical_identity,
    'intent', v_intent,
    'reason', v_reason,
    'requestCorrelationId', v_request_correlation,
    'targetRevisionId', CASE WHEN v_intent = 'CORRECT_REVISION'
      THEN to_jsonb(v_target_revision_id::text) ELSE NULL END,
    'targetEffectivePeriod', CASE WHEN v_intent = 'CORRECT_REVISION' THEN jsonb_build_object(
      'effectiveFrom', to_jsonb(v_target_expected_from),
      'effectiveTo', to_jsonb(v_target_expected_to)
    ) ELSE NULL END,
    'trustedOperationAt', to_jsonb(v_trusted_at)
  );
  v_command_fingerprint := pg_catalog.encode(
    public.digest(pg_catalog.convert_to(v_command::text, 'UTF8'), 'sha256'), 'hex'
  );

  SELECT receipt.fee_id, receipt.command_fingerprint
    INTO v_receipt
    FROM pricing.fee_action_invocation_receipts AS receipt
   WHERE receipt.tenant_id = p_tenant_id
     AND receipt.action_invocation_id = v_action_invocation_id;
  IF FOUND THEN
    IF v_receipt.fee_id IS DISTINCT FROM v_fee_id
      OR v_receipt.command_fingerprint IS DISTINCT FROM v_command_fingerprint
    THEN
      RETURN QUERY SELECT jsonb_build_object(
        'identityKey', v_canonical_identity,
        'outcome', 'COMMERCIAL_FEE_CONFLICT',
        'reason', 'IDENTITY_MISMATCH'
      );
      RETURN;
    END IF;
    SELECT result.payload INTO v_schedule_result
      FROM pricing.read_commercial_fee_schedule_v1(
        p_tenant_id, p_legal_entity_id,
        jsonb_build_object('identityKey', v_canonical_identity, 'trustedOperationAt', p_input ->> 'trustedOperationAt')
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
        'identityKey', v_canonical_identity,
        'outcome', 'COMMERCIAL_FEE_CONFLICT',
        'reason', 'IDENTITY_MISMATCH'
      );
      RETURN;
    END IF;
    SELECT result.payload INTO v_schedule_result
      FROM pricing.read_commercial_fee_schedule_v1(
        p_tenant_id, p_legal_entity_id,
        jsonb_build_object('identityKey', v_canonical_identity, 'trustedOperationAt', p_input ->> 'trustedOperationAt')
      ) AS result;
    RETURN QUERY SELECT jsonb_build_object(
      'outcome', 'COMMERCIAL_FEE_UNCHANGED',
      'schedule', v_schedule_result -> 'schedule'
    );
    RETURN;
  END IF;

  SELECT max(revision.revision_number) + 1
    INTO v_new_revision_number
    FROM pricing.fee_revisions AS revision
   WHERE revision.tenant_id = p_tenant_id
     AND revision.legal_entity_id = p_legal_entity_id
     AND revision.fee_id = v_fee_id;
  v_new_schedule_revision := v_schedule_revision + 1;

  IF v_intent = 'CORRECT_REVISION' THEN
    IF v_expected_schedule_revision IS DISTINCT FROM v_schedule_revision THEN
      RETURN QUERY SELECT jsonb_build_object(
        'identityKey', v_canonical_identity,
        'outcome', 'COMMERCIAL_FEE_CONFLICT',
        'reason', 'EXPECTED_SCHEDULE_STALE'
      );
      RETURN;
    END IF;
    SELECT count(*)::integer,
           min(entry.fee_schedule_entry_id::text)::uuid,
           min(revision.revision_number), min(revision.amount), min(revision.currency_code),
           min(revision.catalog_target_evidence::text)::jsonb,
           min(entry.effective_from), min(entry.effective_to)
      INTO v_target_count, v_target_entry_id, v_target_revision_number,
           v_target_amount, v_target_currency, v_target_catalog_evidence,
           v_target_from, v_target_to
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
       AND entry.fee_revision_id = v_target_revision_id;
    IF v_target_count <> 1 THEN
      RETURN QUERY SELECT jsonb_build_object(
        'identityKey', v_canonical_identity,
        'outcome', 'COMMERCIAL_FEE_CONFLICT',
        'reason', 'TARGET_REVISION_NOT_FOUND'
      );
      RETURN;
    END IF;
    IF v_target_expected_from IS DISTINCT FROM v_target_from
      OR v_target_expected_to IS DISTINCT FROM v_target_to
    THEN
      RETURN QUERY SELECT jsonb_build_object(
        'identityKey', v_canonical_identity,
        'outcome', 'COMMERCIAL_FEE_CONFLICT',
        'reason', 'EFFECTIVE_BOUNDARY_STALE'
      );
      RETURN;
    END IF;
    IF v_normalized_catalog_evidence IS DISTINCT FROM v_target_catalog_evidence
      OR v_currency IS DISTINCT FROM v_target_currency
    THEN
      RETURN QUERY SELECT jsonb_build_object(
        'identityKey', v_canonical_identity,
        'outcome', 'COMMERCIAL_FEE_CONFLICT',
        'reason', 'IDENTITY_MISMATCH'
      );
      RETURN;
    END IF;
    INSERT INTO pricing.fee_revisions (
      fee_revision_id, tenant_id, legal_entity_id, fee_id,
      revision_number, amount, currency_code, catalog_target_evidence,
      previous_revision_id, corrected_revision_id, transition_kind,
      action_invocation_id, acting_principal_id, reason
    ) VALUES (
      v_new_revision_id, p_tenant_id, p_legal_entity_id, v_fee_id,
      v_new_revision_number, v_amount, v_currency, v_target_catalog_evidence,
      v_target_revision_id, v_target_revision_id, 'CORRECTION',
      v_action_invocation_id, v_acting_principal_id, v_reason
    );
  ELSE
    SELECT count(*)::integer,
           min(entry.fee_schedule_entry_id::text)::uuid,
           min(entry.fee_revision_id::text)::uuid,
           min(revision.revision_number), min(revision.amount), min(revision.currency_code),
           min(revision.catalog_target_evidence::text)::jsonb,
           min(entry.effective_from), min(entry.effective_to)
      INTO v_current_count, v_current_entry_id, v_current_revision_id,
           v_current_revision_number, v_current_amount, v_current_currency,
           v_current_catalog_evidence, v_current_from, v_current_to
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
    IF v_current_count <> 1 OR v_trusted_at <= v_current_from THEN
      RETURN QUERY SELECT jsonb_build_object(
        'identityKey', v_canonical_identity,
        'outcome', 'COMMERCIAL_FEE_CONFLICT',
        'reason', 'BOUNDARY_CROSSED'
      );
      RETURN;
    END IF;
    BEGIN
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
          'identityKey', v_canonical_identity,
          'outcome', 'COMMERCIAL_FEE_CONFLICT',
          'reason', 'EXPECTED_CURRENT_STALE'
        );
        RETURN;
      END IF;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN
      RETURN QUERY SELECT jsonb_build_object(
        'identityKey', v_canonical_identity,
        'outcome', 'COMMERCIAL_FEE_CONFLICT',
        'reason', 'EXPECTED_CURRENT_STALE'
      );
      RETURN;
    END;
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
    v_ack_body := jsonb_build_object(
      'actingPrincipalId', v_acting_principal_id::text,
      'feeRef', jsonb_build_object(
        'moduleId', 'commerce.pricing',
        'resourceId', v_fee_id::text,
        'resourceType', 'commerce.pricing.commercial-fee',
        'tenantId', p_tenant_id::text
      ),
      'identityKey', v_canonical_identity,
      'intendedConfiguredAmount', jsonb_build_object(
        'amount', v_current_amount::text,
        'currencyCode', v_current_currency
      ),
      'intendedEffectivePeriod', jsonb_build_object(
        'effectiveFrom', to_char(v_current_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'effectiveTo', CASE WHEN v_current_to IS NULL THEN NULL ELSE
          to_char(v_current_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
      ),
      'intent', 'RETIRE_CURRENT',
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
        'identityKey', v_canonical_identity,
        'outcome', 'COMMERCIAL_FEE_CONFLICT',
        'reason', 'ACKNOWLEDGEMENT_STALE'
      );
      RETURN;
    END IF;
    INSERT INTO pricing.fee_revisions (
      fee_revision_id, tenant_id, legal_entity_id, fee_id,
      revision_number, amount, currency_code, catalog_target_evidence,
      previous_revision_id, corrected_revision_id, transition_kind,
      action_invocation_id, acting_principal_id, reason
    ) VALUES (
      v_new_revision_id, p_tenant_id, p_legal_entity_id, v_fee_id,
      v_new_revision_number, v_current_amount, v_current_currency, v_current_catalog_evidence,
      v_current_revision_id, NULL, 'RETIREMENT',
      v_action_invocation_id, v_acting_principal_id, v_reason
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
  IF v_intent = 'CORRECT_REVISION' THEN
    INSERT INTO pricing.fee_schedule_entries (
      tenant_id, legal_entity_id, fee_id, fee_revision_id,
      fee_schedule_revision_id, schedule_revision, effective_from, effective_to
    )
    SELECT entry.tenant_id, entry.legal_entity_id, entry.fee_id,
           CASE WHEN entry.fee_schedule_entry_id = v_target_entry_id
             THEN v_new_revision_id ELSE entry.fee_revision_id END,
           v_new_schedule_revision_id, v_new_schedule_revision,
           entry.effective_from, entry.effective_to
      FROM pricing.fee_schedule_entries AS entry
     WHERE entry.tenant_id = p_tenant_id
       AND entry.legal_entity_id = p_legal_entity_id
       AND entry.fee_id = v_fee_id
       AND entry.fee_schedule_revision_id = v_head_revision_id;
  ELSE
    INSERT INTO pricing.fee_schedule_entries (
      tenant_id, legal_entity_id, fee_id, fee_revision_id,
      fee_schedule_revision_id, schedule_revision, effective_from, effective_to
    )
    SELECT entry.tenant_id, entry.legal_entity_id, entry.fee_id,
           entry.fee_revision_id, v_new_schedule_revision_id, v_new_schedule_revision,
           entry.effective_from,
           CASE WHEN entry.fee_schedule_entry_id = v_current_entry_id
             THEN v_trusted_at ELSE entry.effective_to END
      FROM pricing.fee_schedule_entries AS entry
     WHERE entry.tenant_id = p_tenant_id
       AND entry.legal_entity_id = p_legal_entity_id
       AND entry.fee_id = v_fee_id
       AND entry.fee_schedule_revision_id = v_head_revision_id;
    IF v_supplied_ack IS NOT NULL THEN
      INSERT INTO pricing.fee_schedule_acknowledgements (
        tenant_id, legal_entity_id, fee_id,
        fingerprint, acknowledgement, issued_by_principal_id
      ) VALUES (
        p_tenant_id, p_legal_entity_id, v_fee_id,
        v_ack_fingerprint, v_ack, v_acting_principal_id
      );
    END IF;
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
      jsonb_build_object('identityKey', v_canonical_identity, 'trustedOperationAt', p_input ->> 'trustedOperationAt')
    ) AS result;
  RETURN QUERY SELECT jsonb_build_object(
    'outcome', 'COMMERCIAL_FEE_REVISED',
    'schedule', v_schedule_result -> 'schedule'
  );
END;
$function$;

REVOKE ALL ON FUNCTION pricing.manage_commercial_fee_revision_v1(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pricing.manage_commercial_fee_revision_v1(uuid, uuid, jsonb) TO ontos_runtime;
