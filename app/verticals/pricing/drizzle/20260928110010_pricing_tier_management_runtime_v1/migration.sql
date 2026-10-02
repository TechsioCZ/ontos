-- #797: exact Quantity Tier Action results and corrected write ordering.
-- Tier set triggers call the private generation helper. Execute those triggers
-- as their owner so the runtime role does not gain direct helper EXECUTE access.
ALTER FUNCTION pricing.advance_quantity_tier_set_after_define_v1() SECURITY DEFINER;
ALTER FUNCTION pricing.advance_quantity_tier_set_after_revise_v1() SECURITY DEFINER;

CREATE TABLE pricing.quantity_tier_action_result_receipts (
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  action_invocation_id uuid NOT NULL,
  acting_principal_id uuid NOT NULL,
  action_kind text NOT NULL,
  request_payload jsonb NOT NULL,
  result_payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pricing_quantity_tier_action_results_pk PRIMARY KEY (tenant_id, action_invocation_id),
  CONSTRAINT pricing_quantity_tier_action_results_kind_ck CHECK (action_kind IN ('DEFINE', 'REVISE')),
  CONSTRAINT pricing_quantity_tier_action_results_request_ck CHECK (jsonb_typeof(request_payload) = 'object'),
  CONSTRAINT pricing_quantity_tier_action_results_result_ck CHECK (jsonb_typeof(result_payload) = 'object')
);

ALTER TABLE pricing.quantity_tier_action_result_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing.quantity_tier_action_result_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY pricing_quantity_tier_action_results_scope_select
  ON pricing.quantity_tier_action_result_receipts FOR SELECT TO
    ontos_runtime, pricing_management_routine_writer
  USING (tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid
    AND legal_entity_id = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
CREATE POLICY pricing_quantity_tier_action_results_scope_insert
  ON pricing.quantity_tier_action_result_receipts FOR INSERT TO pricing_management_routine_writer
  WITH CHECK (tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid
    AND legal_entity_id = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
REVOKE INSERT, UPDATE, DELETE ON TABLE pricing.quantity_tier_action_result_receipts FROM ontos_runtime;
GRANT SELECT ON TABLE pricing.quantity_tier_action_result_receipts TO ontos_runtime;

CREATE FUNCTION pricing.lookup_quantity_tier_action_result_v1(
  p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_invocation_id uuid;
  v_principal_id uuid;
  v_result jsonb;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Pricing Quantity Tier result lookup scope mismatch' USING ERRCODE = '42501';
  END IF;
  BEGIN
    v_invocation_id := (p_input ->> 'actionInvocationId')::uuid;
    v_principal_id := (p_input ->> 'actingPrincipalId')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Pricing Quantity Tier result lookup input is invalid' USING ERRCODE = '22023';
  END;
  IF v_invocation_id IS NULL OR v_principal_id IS NULL THEN
    RAISE EXCEPTION 'Pricing Quantity Tier result lookup input is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT receipt.result_payload INTO v_result
    FROM pricing.quantity_tier_action_result_receipts AS receipt
   WHERE receipt.tenant_id = p_tenant_id
     AND receipt.legal_entity_id = p_legal_entity_id
     AND receipt.action_invocation_id = v_invocation_id
     AND receipt.acting_principal_id = v_principal_id;
  IF FOUND THEN
    RETURN QUERY SELECT jsonb_build_object(
      'actionInvocationId', v_invocation_id::text,
      'outcome', 'QUANTITY_TIER_RESULT_FOUND',
      'result', v_result
    );
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pricing.quantity_tiers AS tier
     WHERE tier.tenant_id = p_tenant_id
       AND tier.legal_entity_id = p_legal_entity_id
       AND tier.created_by_action_invocation_id = v_invocation_id
       AND tier.created_by_principal_id = v_principal_id
    UNION ALL
    SELECT 1 FROM pricing.quantity_tier_revisions AS revision
     WHERE revision.tenant_id = p_tenant_id
       AND revision.legal_entity_id = p_legal_entity_id
       AND revision.action_invocation_id = v_invocation_id
       AND revision.acting_principal_id = v_principal_id
    UNION ALL
    SELECT 1 FROM pricing.quantity_tier_schedule_revisions AS revision
     WHERE revision.tenant_id = p_tenant_id
       AND revision.legal_entity_id = p_legal_entity_id
       AND revision.action_invocation_id = v_invocation_id
       AND revision.acting_principal_id = v_principal_id
  ) THEN
    RAISE EXCEPTION 'Pricing Quantity Tier result predates exact receipt authority' USING ERRCODE = 'P7602';
  END IF;
  RETURN QUERY SELECT jsonb_build_object(
    'actionInvocationId', v_invocation_id::text,
    'outcome', 'QUANTITY_TIER_RESULT_ABSENT'
  );
END;
$function$;

CREATE FUNCTION pricing.define_quantity_tier_v2(
  p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_invocation_id uuid;
  v_principal_id uuid;
  v_price_id uuid;
  v_canonical_request jsonb := p_input - 'requestCorrelationId' - 'trustedOperationAt';
  v_receipt record;
  v_result jsonb;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Pricing Quantity Tier define scope mismatch' USING ERRCODE = '42501';
  END IF;
  BEGIN
    v_invocation_id := (p_input ->> 'actionInvocationId')::uuid;
    v_principal_id := (p_input ->> 'actingPrincipalId')::uuid;
    v_price_id := (p_input #>> '{identityKey,priceRef,resourceId}')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Pricing Quantity Tier define input is invalid' USING ERRCODE = '22023';
  END;
  IF v_invocation_id IS NULL OR v_principal_id IS NULL OR v_price_id IS NULL
    OR p_input #>> '{expectedState,state}' IS DISTINCT FROM 'ABSENT'
  THEN
    RAISE EXCEPTION 'Pricing Quantity Tier define input is invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':tier-action:' || v_invocation_id::text, 0));
  SELECT receipt.* INTO v_receipt
    FROM pricing.quantity_tier_action_result_receipts AS receipt
   WHERE receipt.tenant_id = p_tenant_id AND receipt.action_invocation_id = v_invocation_id;
  IF FOUND THEN
    IF v_receipt.legal_entity_id IS DISTINCT FROM p_legal_entity_id
      OR v_receipt.acting_principal_id IS DISTINCT FROM v_principal_id
      OR v_receipt.action_kind IS DISTINCT FROM 'DEFINE'
      OR v_receipt.request_payload IS DISTINCT FROM v_canonical_request
    THEN
      RETURN QUERY SELECT jsonb_build_object('identityKey', p_input -> 'identityKey',
        'outcome', 'QUANTITY_TIER_CONFLICT', 'reason', 'IDENTITY_MISMATCH');
    ELSE
      RETURN QUERY SELECT v_receipt.result_payload;
    END IF;
    RETURN;
  END IF;

  -- The stable Price ID serializes semantically equal first Tier creates even
  -- when their JSON decimal spelling differs. Price rows are immutable here.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text || ':' || p_legal_entity_id::text || ':tier-price:' || v_price_id::text, 0
  ));
  IF EXISTS (
    SELECT 1 FROM pricing.quantity_tier_revisions AS revision
     WHERE revision.tenant_id = p_tenant_id AND revision.action_invocation_id = v_invocation_id
  ) THEN
    RETURN QUERY SELECT jsonb_build_object('identityKey', p_input -> 'identityKey',
      'outcome', 'QUANTITY_TIER_CONFLICT', 'reason', 'IDENTITY_MISMATCH');
    RETURN;
  END IF;
  IF pricing.quantity_tier_id_for_identity_v1(p_tenant_id, p_legal_entity_id, p_input -> 'identityKey') IS NOT NULL THEN
    RETURN QUERY SELECT jsonb_build_object('identityKey', p_input -> 'identityKey',
      'outcome', 'QUANTITY_TIER_CONFLICT', 'reason', 'EXPECTED_CURRENT_STALE');
    RETURN;
  END IF;
  SELECT result.payload INTO v_result
    FROM pricing.define_quantity_tier_v1(p_tenant_id, p_legal_entity_id, p_input) AS result;
  IF v_result ->> 'outcome' IN ('QUANTITY_TIER_CREATED', 'QUANTITY_TIER_REUSED') THEN
    INSERT INTO pricing.quantity_tier_action_result_receipts (
      tenant_id, legal_entity_id, action_invocation_id, acting_principal_id,
      action_kind, request_payload, result_payload
    ) VALUES (p_tenant_id, p_legal_entity_id, v_invocation_id, v_principal_id,
      'DEFINE', v_canonical_request, v_result);
  END IF;
  RETURN QUERY SELECT v_result;
END;
$function$;

CREATE FUNCTION pricing.revise_quantity_tier_v2(
  p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_identity jsonb := p_input -> 'identityKey';
  v_invocation_id uuid;
  v_principal_id uuid;
  v_tier_id uuid;
  v_trusted_at timestamptz;
  v_amount numeric(38,9);
  v_currency text;
  v_intent text := p_input ->> 'intent';
  v_receipt record;
  v_head record;
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
  v_target_count integer;
  v_target_entry_id uuid;
  v_target_revision_id uuid;
  v_target_from timestamptz;
  v_target_to timestamptz;
  v_expected_schedule_revision integer;
  v_future jsonb;
  v_ack_body jsonb;
  v_ack jsonb;
  v_ack_fingerprint text;
  v_target_period jsonb;
  v_intended_period jsonb;
  v_canonical_request jsonb := p_input - 'requestCorrelationId' - 'trustedOperationAt';
  v_new_revision_id uuid := pg_catalog.gen_random_uuid();
  v_new_revision_number integer;
  v_new_schedule_revision_id uuid := pg_catalog.gen_random_uuid();
  v_new_schedule_revision integer;
  v_updated_count integer;
  v_result jsonb;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'Pricing Quantity Tier revision scope mismatch' USING ERRCODE = '42501';
  END IF;
  BEGIN
    v_invocation_id := (p_input ->> 'actionInvocationId')::uuid;
    v_principal_id := (p_input ->> 'actingPrincipalId')::uuid;
    v_trusted_at := (p_input ->> 'trustedOperationAt')::timestamptz;
    IF p_input ->> 'intent' = 'VALUE_ONLY_CURRENT' THEN
      v_effective_from := (p_input ->> 'effectiveFrom')::timestamptz;
    ELSIF p_input ->> 'intent' = 'RETIRE_CURRENT' THEN
      v_effective_to := (p_input ->> 'effectiveTo')::timestamptz;
    ELSIF p_input ->> 'intent' = 'CORRECT_REVISION' THEN
      v_target_revision_id := (p_input ->> 'targetRevisionId')::uuid;
      v_target_from := (p_input #>> '{targetEffectivePeriod,effectiveFrom}')::timestamptz;
      v_target_to := (p_input #>> '{targetEffectivePeriod,effectiveTo}')::timestamptz;
      v_expected_schedule_revision := (p_input ->> 'expectedScheduleRevision')::integer;
    END IF;
    v_tier_id := pricing.quantity_tier_id_for_identity_v1(p_tenant_id, p_legal_entity_id, v_identity);
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'Pricing Quantity Tier revision input is invalid' USING ERRCODE = '22023';
  END;
  IF v_intent <> 'RETIRE_CURRENT' THEN
    IF p_input #>> '{resultingUnitPrice,amount}' !~ '^(0|[1-9][0-9]{0,28})(\.[0-9]{1,9})?$'
      OR p_input #>> '{resultingUnitPrice,amount}' IS NULL
    THEN
      RAISE EXCEPTION 'Pricing Quantity Tier revision amount is invalid' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_amount := (p_input #>> '{resultingUnitPrice,amount}')::numeric(38,9);
    EXCEPTION WHEN numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Pricing Quantity Tier revision amount is invalid' USING ERRCODE = '22023';
    END;
    v_currency := p_input #>> '{resultingUnitPrice,currencyCode}';
  END IF;
  IF v_invocation_id IS NULL OR v_principal_id IS NULL OR v_trusted_at IS NULL
    OR v_intent NOT IN ('VALUE_ONLY_CURRENT', 'SCHEDULE_REVISION', 'RETIRE_CURRENT', 'CORRECT_REVISION')
    OR (v_intent <> 'RETIRE_CURRENT' AND (v_amount IS NULL OR v_amount < 0 OR v_currency !~ '^[A-Z]{3}$'))
    OR (v_intent = 'VALUE_ONLY_CURRENT' AND v_effective_from IS NULL)
    OR (v_intent = 'RETIRE_CURRENT' AND v_effective_to IS NULL)
    OR (v_intent = 'CORRECT_REVISION' AND (
      v_target_revision_id IS NULL OR v_target_from IS NULL OR v_expected_schedule_revision IS NULL
    ))
  THEN
    RAISE EXCEPTION 'Pricing Quantity Tier revision input is invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':tier-action:' || v_invocation_id::text, 0));
  SELECT receipt.* INTO v_receipt
    FROM pricing.quantity_tier_action_result_receipts AS receipt
   WHERE receipt.tenant_id = p_tenant_id AND receipt.action_invocation_id = v_invocation_id;
  IF FOUND THEN
    IF v_receipt.legal_entity_id IS DISTINCT FROM p_legal_entity_id
      OR v_receipt.acting_principal_id IS DISTINCT FROM v_principal_id
      OR v_receipt.action_kind IS DISTINCT FROM 'REVISE'
      OR v_receipt.request_payload IS DISTINCT FROM v_canonical_request
    THEN
      RETURN QUERY SELECT jsonb_build_object('identityKey', v_identity,
        'outcome', 'QUANTITY_TIER_CONFLICT', 'reason', 'IDENTITY_MISMATCH');
    ELSE
      RETURN QUERY SELECT v_receipt.result_payload;
    END IF;
    RETURN;
  END IF;
  IF v_tier_id IS NULL THEN
    RETURN QUERY SELECT jsonb_build_object('identityKey', v_identity,
      'outcome', 'QUANTITY_TIER_CONFLICT', 'reason', 'IDENTITY_MISMATCH');
    RETURN;
  END IF;
  IF v_intent <> 'RETIRE_CURRENT' AND NOT EXISTS (
    SELECT 1 FROM pricing.quantity_tiers AS tier
     WHERE tier.tenant_id = p_tenant_id AND tier.legal_entity_id = p_legal_entity_id
       AND tier.quantity_tier_id = v_tier_id AND tier.price_currency_code = v_currency
  ) THEN
    RETURN QUERY SELECT jsonb_build_object('identityKey', v_identity,
      'outcome', 'QUANTITY_TIER_CONFLICT', 'reason', 'IDENTITY_MISMATCH');
    RETURN;
  END IF;
  SELECT head.quantity_tier_schedule_revision_id, head.schedule_revision
    INTO v_head
    FROM pricing.quantity_tier_schedule_heads AS head
   WHERE head.tenant_id = p_tenant_id AND head.legal_entity_id = p_legal_entity_id
     AND head.quantity_tier_id = v_tier_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT jsonb_build_object('identityKey', v_identity,
      'outcome', 'QUANTITY_TIER_CONFLICT', 'reason', 'IDENTITY_MISMATCH');
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pricing.quantity_tier_revisions AS revision
     WHERE revision.tenant_id = p_tenant_id AND revision.action_invocation_id = v_invocation_id
  ) THEN
    RETURN QUERY SELECT jsonb_build_object('identityKey', v_identity,
      'outcome', 'QUANTITY_TIER_CONFLICT', 'reason', 'IDENTITY_MISMATCH');
    RETURN;
  END IF;

  IF v_intent IN ('VALUE_ONLY_CURRENT', 'RETIRE_CURRENT') THEN
    SELECT count(*)::integer,
           min(entry.quantity_tier_schedule_entry_id::text)::uuid,
           min(entry.quantity_tier_revision_id::text)::uuid,
           min(revision.revision_number), min(revision.resulting_amount), min(revision.currency_code),
           min(entry.effective_from), min(entry.effective_to)
      INTO v_current_count, v_current_entry_id, v_current_revision_id, v_current_revision_number,
           v_current_amount, v_current_currency, v_current_from, v_current_to
      FROM pricing.quantity_tier_schedule_entries AS entry
      JOIN pricing.quantity_tier_revisions AS revision
        ON revision.tenant_id = entry.tenant_id
       AND revision.legal_entity_id = entry.legal_entity_id
       AND revision.quantity_tier_id = entry.quantity_tier_id
       AND revision.quantity_tier_revision_id = entry.quantity_tier_revision_id
     WHERE entry.tenant_id = p_tenant_id AND entry.legal_entity_id = p_legal_entity_id
       AND entry.quantity_tier_id = v_tier_id
       AND entry.quantity_tier_schedule_revision_id = v_head.quantity_tier_schedule_revision_id
       AND entry.effective_from <= v_trusted_at
       AND (entry.effective_to IS NULL OR v_trusted_at < entry.effective_to);
    IF v_current_count <> 1 THEN
      RETURN QUERY SELECT jsonb_build_object('identityKey', v_identity,
        'outcome', 'QUANTITY_TIER_CONFLICT', 'reason', 'EFFECTIVE_BOUNDARY_STALE');
      RETURN;
    END IF;
    IF v_intent = 'RETIRE_CURRENT' THEN
      v_effective_from := v_effective_to;
      v_amount := v_current_amount;
      v_currency := v_current_currency;
    END IF;
    IF v_effective_from < v_current_from
      OR v_effective_from > v_trusted_at
      OR (v_intent = 'RETIRE_CURRENT' AND v_effective_from = v_current_from)
      OR (v_current_to IS NOT NULL AND v_effective_from >= v_current_to)
    THEN
      RETURN QUERY SELECT jsonb_build_object('identityKey', v_identity,
        'outcome', 'QUANTITY_TIER_CONFLICT', 'reason', 'EFFECTIVE_BOUNDARY_STALE');
      RETURN;
    END IF;
    BEGIN
      IF (p_input #>> '{expectedCurrent,scheduleRevision}')::integer IS DISTINCT FROM v_head.schedule_revision
        OR (p_input #>> '{expectedCurrent,revision}')::integer IS DISTINCT FROM v_current_revision_number
        OR (p_input #>> '{expectedCurrent,revisionId}')::uuid IS DISTINCT FROM v_current_revision_id
        OR (p_input #>> '{expectedCurrent,effectivePeriod,effectiveFrom}')::timestamptz IS DISTINCT FROM v_current_from
        OR (p_input #>> '{expectedCurrent,effectivePeriod,effectiveTo}')::timestamptz IS DISTINCT FROM v_current_to
        OR pricing.quantity_tier_id_for_identity_v1(
          p_tenant_id, p_legal_entity_id, p_input #> '{expectedCurrent,identityKey}'
        ) IS DISTINCT FROM v_tier_id
      THEN
        RETURN QUERY SELECT jsonb_build_object('identityKey', v_identity,
          'outcome', 'QUANTITY_TIER_CONFLICT', 'reason', 'EXPECTED_CURRENT_STALE');
        RETURN;
      END IF;
    EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Pricing Quantity Tier expected Current input is invalid' USING ERRCODE = '22023';
    END;

    SELECT coalesce(jsonb_agg(
      pricing.scheduled_quantity_tier_revision_json_v1(
        p_tenant_id, p_legal_entity_id, v_tier_id,
        entry.quantity_tier_revision_id, entry.effective_from, entry.effective_to
      ) ORDER BY entry.effective_from, entry.quantity_tier_revision_id
    ), '[]'::jsonb) INTO v_future
      FROM pricing.quantity_tier_schedule_entries AS entry
     WHERE entry.tenant_id = p_tenant_id AND entry.legal_entity_id = p_legal_entity_id
       AND entry.quantity_tier_id = v_tier_id
       AND entry.quantity_tier_schedule_revision_id = v_head.quantity_tier_schedule_revision_id
       AND entry.effective_from > v_effective_from;
    v_target_period := jsonb_build_object(
      'effectiveFrom', to_char(v_current_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'effectiveTo', CASE WHEN v_current_to IS NULL THEN NULL ELSE
        to_char(v_current_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
    );
    v_intended_period := jsonb_build_object(
      'effectiveFrom', to_char(
        (CASE WHEN v_intent = 'RETIRE_CURRENT' THEN v_current_from ELSE v_effective_from END)
        AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'effectiveTo', CASE WHEN v_intent = 'RETIRE_CURRENT' THEN
        to_char(v_effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      WHEN v_current_to IS NULL THEN NULL ELSE
        to_char(v_current_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
    );
    v_ack_body := jsonb_build_object(
      'actingPrincipalId', v_principal_id::text,
      'identityKey', pricing.quantity_tier_identity_json_v1(p_tenant_id, p_legal_entity_id, v_tier_id),
      'intendedEffectivePeriod', v_intended_period,
      'intendedResultingUnitPrice', jsonb_build_object('amount', v_amount::text, 'currencyCode', v_currency),
      'intent', v_intent,
      'presentedFuture', v_future,
      'scheduleRevision', v_head.schedule_revision,
      'targetEffectivePeriod', v_target_period,
      'targetRevisionId', v_current_revision_id::text
    );
    v_ack_fingerprint := encode(public.digest(convert_to(v_ack_body::text, 'UTF8'), 'sha256'), 'hex');
    v_ack := v_ack_body || jsonb_build_object('fingerprint', v_ack_fingerprint);
    IF jsonb_array_length(v_future) > 0 AND p_input -> 'acknowledgement' IS NULL THEN
      v_result := jsonb_build_object(
        'acknowledgement', v_ack, 'outcome', 'QUANTITY_TIER_ACKNOWLEDGEMENT_REQUIRED');
      INSERT INTO pricing.quantity_tier_schedule_acknowledgements (
        tenant_id, legal_entity_id, price_id, quantity_tier_id,
        fingerprint, acknowledgement, issued_by_principal_id
      ) VALUES (
        p_tenant_id, p_legal_entity_id, (v_identity #>> '{priceRef,resourceId}')::uuid,
        v_tier_id, v_ack_fingerprint, v_ack, v_principal_id
      ) ON CONFLICT (tenant_id, fingerprint) DO NOTHING;
      INSERT INTO pricing.quantity_tier_action_result_receipts (
        tenant_id, legal_entity_id, action_invocation_id, acting_principal_id,
        action_kind, request_payload, result_payload
      ) VALUES (
        p_tenant_id, p_legal_entity_id, v_invocation_id, v_principal_id,
        'REVISE', v_canonical_request, v_result
      );
      RETURN QUERY SELECT v_result;
      RETURN;
    END IF;
    IF p_input -> 'acknowledgement' IS NOT NULL
      AND (p_input -> 'acknowledgement' IS DISTINCT FROM v_ack
        OR NOT EXISTS (
          SELECT 1
            FROM pricing.quantity_tier_schedule_acknowledgements AS ledger
           WHERE ledger.tenant_id = p_tenant_id
             AND ledger.legal_entity_id = p_legal_entity_id
             AND ledger.price_id = (v_identity #>> '{priceRef,resourceId}')::uuid
             AND ledger.quantity_tier_id = v_tier_id
             AND ledger.fingerprint = v_ack_fingerprint
             AND ledger.acknowledgement = v_ack
             AND ledger.issued_by_principal_id = v_principal_id
        ))
    THEN
      RETURN QUERY SELECT jsonb_build_object('identityKey', v_identity,
        'outcome', 'QUANTITY_TIER_CONFLICT', 'reason', 'ACKNOWLEDGEMENT_STALE');
      RETURN;
    END IF;

    IF v_intent = 'VALUE_ONLY_CURRENT'
      AND v_current_amount = v_amount
      AND v_current_currency = v_currency
      AND v_effective_from = v_current_from
    THEN
      SELECT result.payload INTO v_result
        FROM pricing.read_quantity_tier_schedule_v1(
          p_tenant_id, p_legal_entity_id,
          jsonb_build_object('identityKey', v_identity, 'trustedOperationAt', p_input ->> 'trustedOperationAt')
        ) AS result;
      v_result := jsonb_build_object('outcome', 'QUANTITY_TIER_UNCHANGED', 'schedule', v_result -> 'schedule');
    ELSE
      SELECT coalesce(max(revision.revision_number), 0) + 1
        INTO v_new_revision_number
        FROM pricing.quantity_tier_revisions AS revision
       WHERE revision.tenant_id = p_tenant_id
         AND revision.legal_entity_id = p_legal_entity_id
         AND revision.quantity_tier_id = v_tier_id;
      v_new_schedule_revision := v_head.schedule_revision + 1;

      INSERT INTO pricing.quantity_tier_revisions (
        quantity_tier_revision_id, tenant_id, legal_entity_id, price_id, quantity_tier_id,
        revision_number, resulting_amount, currency_code, previous_revision_id,
        corrected_revision_id, transition_kind, action_invocation_id, acting_principal_id, reason
      ) VALUES (
        v_new_revision_id, p_tenant_id, p_legal_entity_id,
        (v_identity #>> '{priceRef,resourceId}')::uuid, v_tier_id,
        v_new_revision_number, v_amount, v_currency, v_current_revision_id,
        NULL, CASE WHEN v_intent = 'RETIRE_CURRENT' THEN 'RETIREMENT' ELSE 'VALUE_ONLY_CURRENT' END,
        v_invocation_id, v_principal_id, p_input ->> 'reason'
      );
      INSERT INTO pricing.quantity_tier_schedule_revisions (
        quantity_tier_schedule_revision_id, tenant_id, legal_entity_id, price_id, quantity_tier_id,
        schedule_revision, previous_schedule_revision_id, action_invocation_id, acting_principal_id, reason
      ) VALUES (
        v_new_schedule_revision_id, p_tenant_id, p_legal_entity_id,
        (v_identity #>> '{priceRef,resourceId}')::uuid, v_tier_id,
        v_new_schedule_revision, v_head.quantity_tier_schedule_revision_id,
        v_invocation_id, v_principal_id, p_input ->> 'reason'
      );
      INSERT INTO pricing.quantity_tier_schedule_entries (
        tenant_id, legal_entity_id, price_id, quantity_tier_id, quantity_tier_revision_id,
        quantity_tier_schedule_revision_id, schedule_revision, effective_from, effective_to
      )
      SELECT entry.tenant_id, entry.legal_entity_id, entry.price_id, entry.quantity_tier_id,
             entry.quantity_tier_revision_id, v_new_schedule_revision_id,
             v_new_schedule_revision, entry.effective_from, entry.effective_to
        FROM pricing.quantity_tier_schedule_entries AS entry
       WHERE entry.tenant_id = p_tenant_id
         AND entry.legal_entity_id = p_legal_entity_id
         AND entry.quantity_tier_id = v_tier_id
         AND entry.quantity_tier_schedule_revision_id = v_head.quantity_tier_schedule_revision_id
         AND entry.quantity_tier_schedule_entry_id <> v_current_entry_id;
      IF v_intent = 'VALUE_ONLY_CURRENT' AND v_effective_from > v_current_from THEN
        INSERT INTO pricing.quantity_tier_schedule_entries (
          tenant_id, legal_entity_id, price_id, quantity_tier_id, quantity_tier_revision_id,
          quantity_tier_schedule_revision_id, schedule_revision, effective_from, effective_to
        ) VALUES (
          p_tenant_id, p_legal_entity_id, (v_identity #>> '{priceRef,resourceId}')::uuid,
          v_tier_id, v_current_revision_id, v_new_schedule_revision_id,
          v_new_schedule_revision, v_current_from, v_effective_from
        );
      END IF;
      INSERT INTO pricing.quantity_tier_schedule_entries (
        tenant_id, legal_entity_id, price_id, quantity_tier_id, quantity_tier_revision_id,
        quantity_tier_schedule_revision_id, schedule_revision, effective_from, effective_to
      ) VALUES (
        p_tenant_id, p_legal_entity_id, (v_identity #>> '{priceRef,resourceId}')::uuid,
        v_tier_id, v_new_revision_id, v_new_schedule_revision_id,
        v_new_schedule_revision,
        CASE WHEN v_intent = 'RETIRE_CURRENT' THEN v_current_from ELSE v_effective_from END,
        CASE WHEN v_intent = 'RETIRE_CURRENT' THEN v_effective_from ELSE v_current_to END
      );
      UPDATE pricing.quantity_tier_schedule_heads
         SET quantity_tier_schedule_revision_id = v_new_schedule_revision_id,
             schedule_revision = v_new_schedule_revision
       WHERE tenant_id = p_tenant_id
         AND legal_entity_id = p_legal_entity_id
         AND quantity_tier_id = v_tier_id
         AND quantity_tier_schedule_revision_id = v_head.quantity_tier_schedule_revision_id
         AND schedule_revision = v_head.schedule_revision;
      GET DIAGNOSTICS v_updated_count = ROW_COUNT;
      IF v_updated_count <> 1 THEN
        RAISE EXCEPTION 'Pricing Quantity Tier schedule CAS failed' USING ERRCODE = '40001';
      END IF;
      SELECT result.payload INTO v_result
        FROM pricing.read_quantity_tier_schedule_v1(
          p_tenant_id, p_legal_entity_id,
          jsonb_build_object('identityKey', v_identity, 'trustedOperationAt', p_input ->> 'trustedOperationAt')
        ) AS result;
      v_result := jsonb_build_object('outcome', 'QUANTITY_TIER_REVISED', 'schedule', v_result -> 'schedule');
    END IF;

    INSERT INTO pricing.quantity_tier_action_result_receipts (
      tenant_id, legal_entity_id, action_invocation_id, acting_principal_id,
      action_kind, request_payload, result_payload
    ) VALUES (
      p_tenant_id, p_legal_entity_id, v_invocation_id, v_principal_id,
      'REVISE', v_canonical_request, v_result
    );
    RETURN QUERY SELECT v_result;
    RETURN;
  END IF;

  IF v_intent = 'CORRECT_REVISION' THEN
    IF v_expected_schedule_revision IS DISTINCT FROM v_head.schedule_revision THEN
      RETURN QUERY SELECT jsonb_build_object('identityKey', v_identity,
        'outcome', 'QUANTITY_TIER_CONFLICT', 'reason', 'EXPECTED_SCHEDULE_STALE');
      RETURN;
    END IF;
    SELECT count(*)::integer,
           min(entry.quantity_tier_schedule_entry_id::text)::uuid,
           min(entry.effective_from), min(entry.effective_to)
      INTO v_target_count, v_target_entry_id, v_effective_from, v_effective_to
      FROM pricing.quantity_tier_schedule_entries AS entry
     WHERE entry.tenant_id = p_tenant_id
       AND entry.legal_entity_id = p_legal_entity_id
       AND entry.quantity_tier_id = v_tier_id
       AND entry.quantity_tier_schedule_revision_id = v_head.quantity_tier_schedule_revision_id
       AND entry.quantity_tier_revision_id = v_target_revision_id;
    IF v_target_count <> 1 THEN
      RETURN QUERY SELECT jsonb_build_object('identityKey', v_identity,
        'outcome', 'QUANTITY_TIER_CONFLICT', 'reason', 'TARGET_REVISION_NOT_FOUND');
      RETURN;
    END IF;
    IF v_target_from IS DISTINCT FROM v_effective_from OR v_target_to IS DISTINCT FROM v_effective_to THEN
      RETURN QUERY SELECT jsonb_build_object('identityKey', v_identity,
        'outcome', 'QUANTITY_TIER_CONFLICT', 'reason', 'EFFECTIVE_BOUNDARY_STALE');
      RETURN;
    END IF;

    SELECT coalesce(max(revision.revision_number), 0) + 1
      INTO v_new_revision_number
      FROM pricing.quantity_tier_revisions AS revision
     WHERE revision.tenant_id = p_tenant_id
       AND revision.legal_entity_id = p_legal_entity_id
       AND revision.quantity_tier_id = v_tier_id;
    v_new_schedule_revision := v_head.schedule_revision + 1;
    INSERT INTO pricing.quantity_tier_revisions (
      quantity_tier_revision_id, tenant_id, legal_entity_id, price_id, quantity_tier_id,
      revision_number, resulting_amount, currency_code, previous_revision_id,
      corrected_revision_id, transition_kind, action_invocation_id, acting_principal_id, reason
    ) VALUES (
      v_new_revision_id, p_tenant_id, p_legal_entity_id,
      (v_identity #>> '{priceRef,resourceId}')::uuid, v_tier_id,
      v_new_revision_number, v_amount, v_currency, v_target_revision_id,
      v_target_revision_id, 'CORRECTION', v_invocation_id, v_principal_id, p_input ->> 'reason'
    );
    INSERT INTO pricing.quantity_tier_schedule_revisions (
      quantity_tier_schedule_revision_id, tenant_id, legal_entity_id, price_id, quantity_tier_id,
      schedule_revision, previous_schedule_revision_id, action_invocation_id, acting_principal_id, reason
    ) VALUES (
      v_new_schedule_revision_id, p_tenant_id, p_legal_entity_id,
      (v_identity #>> '{priceRef,resourceId}')::uuid, v_tier_id,
      v_new_schedule_revision, v_head.quantity_tier_schedule_revision_id,
      v_invocation_id, v_principal_id, p_input ->> 'reason'
    );
    INSERT INTO pricing.quantity_tier_schedule_entries (
      tenant_id, legal_entity_id, price_id, quantity_tier_id, quantity_tier_revision_id,
      quantity_tier_schedule_revision_id, schedule_revision, effective_from, effective_to
    )
    SELECT entry.tenant_id, entry.legal_entity_id, entry.price_id, entry.quantity_tier_id,
           CASE WHEN entry.quantity_tier_schedule_entry_id = v_target_entry_id
             THEN v_new_revision_id ELSE entry.quantity_tier_revision_id END,
           v_new_schedule_revision_id, v_new_schedule_revision,
           entry.effective_from, entry.effective_to
      FROM pricing.quantity_tier_schedule_entries AS entry
     WHERE entry.tenant_id = p_tenant_id
       AND entry.legal_entity_id = p_legal_entity_id
       AND entry.quantity_tier_id = v_tier_id
       AND entry.quantity_tier_schedule_revision_id = v_head.quantity_tier_schedule_revision_id;
    UPDATE pricing.quantity_tier_schedule_heads
       SET quantity_tier_schedule_revision_id = v_new_schedule_revision_id,
           schedule_revision = v_new_schedule_revision
     WHERE tenant_id = p_tenant_id
       AND legal_entity_id = p_legal_entity_id
       AND quantity_tier_id = v_tier_id
       AND quantity_tier_schedule_revision_id = v_head.quantity_tier_schedule_revision_id
       AND schedule_revision = v_head.schedule_revision;
    GET DIAGNOSTICS v_updated_count = ROW_COUNT;
    IF v_updated_count <> 1 THEN
      RAISE EXCEPTION 'Pricing Quantity Tier schedule CAS failed' USING ERRCODE = '40001';
    END IF;
    SELECT result.payload INTO v_result
      FROM pricing.read_quantity_tier_schedule_v1(
        p_tenant_id, p_legal_entity_id,
        jsonb_build_object('identityKey', v_identity, 'trustedOperationAt', p_input ->> 'trustedOperationAt')
      ) AS result;
    v_result := jsonb_build_object('outcome', 'QUANTITY_TIER_REVISED', 'schedule', v_result -> 'schedule');
    INSERT INTO pricing.quantity_tier_action_result_receipts (
      tenant_id, legal_entity_id, action_invocation_id, acting_principal_id,
      action_kind, request_payload, result_payload
    ) VALUES (
      p_tenant_id, p_legal_entity_id, v_invocation_id, v_principal_id,
      'REVISE', v_canonical_request, v_result
    );
    RETURN QUERY SELECT v_result;
    RETURN;
  END IF;

  -- Scheduling is an explicit different intent. The established v1 routine
  -- already preserves the existing schedule and enforces non-overlap.
  SELECT result.payload INTO v_result
    FROM pricing.revise_quantity_tier_v1(p_tenant_id, p_legal_entity_id, p_input) AS result;
  IF v_result ->> 'outcome' IN ('QUANTITY_TIER_REVISED', 'QUANTITY_TIER_UNCHANGED') THEN
    INSERT INTO pricing.quantity_tier_action_result_receipts (
      tenant_id, legal_entity_id, action_invocation_id, acting_principal_id,
      action_kind, request_payload, result_payload
    ) VALUES (p_tenant_id, p_legal_entity_id, v_invocation_id, v_principal_id,
      'REVISE', v_canonical_request, v_result);
  END IF;
  RETURN QUERY SELECT v_result;
END;
$function$;

DO $policies$
DECLARE
  v_policy record;
BEGIN
  FOR v_policy IN
    SELECT * FROM (VALUES
      ('quantity_tiers', 'pricing_quantity_tiers_scope_select'),
      ('quantity_tiers', 'pricing_quantity_tiers_scope_insert'),
      ('quantity_tier_revisions', 'pricing_quantity_tier_revisions_scope_select'),
      ('quantity_tier_revisions', 'pricing_quantity_tier_revisions_scope_insert'),
      ('quantity_tier_schedule_acknowledgements', 'pricing_quantity_tier_schedule_acknowledgements_scope_select'),
      ('quantity_tier_schedule_acknowledgements', 'pricing_quantity_tier_schedule_acknowledgements_scope_insert'),
      ('quantity_tier_schedule_entries', 'pricing_quantity_tier_schedule_entries_scope_select'),
      ('quantity_tier_schedule_entries', 'pricing_quantity_tier_schedule_entries_scope_insert'),
      ('quantity_tier_schedule_heads', 'pricing_quantity_tier_schedule_heads_scope_select'),
      ('quantity_tier_schedule_heads', 'pricing_quantity_tier_schedule_heads_scope_insert'),
      ('quantity_tier_schedule_heads', 'pricing_quantity_tier_schedule_heads_scope_update'),
      ('quantity_tier_schedule_revisions', 'pricing_quantity_tier_schedule_revisions_scope_select'),
      ('quantity_tier_schedule_revisions', 'pricing_quantity_tier_schedule_revisions_scope_insert'),
      ('quantity_tier_set_roots', 'pricing_quantity_tier_set_roots_scope_select'),
      ('quantity_tier_set_roots', 'pricing_quantity_tier_set_roots_scope_insert'),
      ('quantity_tier_set_revisions', 'pricing_quantity_tier_set_revisions_scope_select'),
      ('quantity_tier_set_revisions', 'pricing_quantity_tier_set_revisions_scope_insert'),
      ('quantity_tier_set_heads', 'pricing_quantity_tier_set_heads_scope_select'),
      ('quantity_tier_set_heads', 'pricing_quantity_tier_set_heads_scope_insert'),
      ('quantity_tier_set_heads', 'pricing_quantity_tier_set_heads_scope_update')
    ) AS policies(table_name, policy_name)
  LOOP
    EXECUTE pg_catalog.format(
      'ALTER POLICY %I ON pricing.%I TO ontos_runtime, pricing_management_routine_writer',
      v_policy.policy_name,
      v_policy.table_name
    );
  END LOOP;
END;
$policies$;

GRANT SELECT, INSERT ON TABLE pricing.quantity_tiers,
  pricing.quantity_tier_revisions, pricing.quantity_tier_schedule_acknowledgements,
  pricing.quantity_tier_schedule_entries, pricing.quantity_tier_schedule_revisions,
  pricing.quantity_tier_set_roots, pricing.quantity_tier_set_revisions,
  pricing.quantity_tier_action_result_receipts
TO pricing_management_routine_writer;
GRANT SELECT, INSERT, UPDATE ON TABLE pricing.quantity_tier_schedule_heads,
  pricing.quantity_tier_set_heads TO pricing_management_routine_writer;
GRANT EXECUTE ON FUNCTION pricing.define_quantity_tier_v1(uuid,uuid,jsonb),
  pricing.revise_quantity_tier_v1(uuid,uuid,jsonb),
  pricing.advance_quantity_tier_set_generation_v1(uuid,uuid,uuid,uuid,text),
  pricing.quantity_tier_id_for_identity_v1(uuid,uuid,jsonb),
  pricing.quantity_tier_identity_json_v1(uuid,uuid,uuid),
  pricing.read_quantity_tier_schedule_v1(uuid,uuid,jsonb),
  pricing.scheduled_quantity_tier_revision_json_v1(uuid,uuid,uuid,uuid,timestamptz,timestamptz)
TO pricing_management_routine_writer;

GRANT CREATE ON SCHEMA pricing TO pricing_management_routine_writer;
ALTER FUNCTION pricing.advance_quantity_tier_set_after_define_v1()
  OWNER TO pricing_management_routine_writer;
ALTER FUNCTION pricing.advance_quantity_tier_set_after_revise_v1()
  OWNER TO pricing_management_routine_writer;
ALTER FUNCTION pricing.lookup_quantity_tier_action_result_v1(uuid,uuid,jsonb)
  OWNER TO pricing_management_routine_writer;
ALTER FUNCTION pricing.define_quantity_tier_v2(uuid,uuid,jsonb)
  OWNER TO pricing_management_routine_writer;
ALTER FUNCTION pricing.revise_quantity_tier_v2(uuid,uuid,jsonb)
  OWNER TO pricing_management_routine_writer;
REVOKE CREATE ON SCHEMA pricing FROM pricing_management_routine_writer;

REVOKE ALL ON FUNCTION pricing.lookup_quantity_tier_action_result_v1(uuid,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.define_quantity_tier_v2(uuid,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.revise_quantity_tier_v2(uuid,uuid,jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pricing.define_quantity_tier_v1(uuid,uuid,jsonb) FROM ontos_runtime;
REVOKE EXECUTE ON FUNCTION pricing.revise_quantity_tier_v1(uuid,uuid,jsonb) FROM ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.lookup_quantity_tier_action_result_v1(uuid,uuid,jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.define_quantity_tier_v2(uuid,uuid,jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.revise_quantity_tier_v2(uuid,uuid,jsonb) TO ontos_runtime;
