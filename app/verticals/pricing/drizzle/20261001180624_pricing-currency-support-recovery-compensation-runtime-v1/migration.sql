-- Keep the retired per-context table history-only even if an older deployment/bootstrap granted
-- broad table privileges. Canonical recovery and compensation use only the Tenant-owned schedule.
REVOKE ALL ON TABLE pricing.currency_support_revisions FROM ontos_runtime;

ALTER POLICY pricing_currency_support_recovery_compensation_tenant_select
  ON pricing.currency_support_recovery_compensation_receipts
  TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_currency_support_recovery_compensation_tenant_insert
  ON pricing.currency_support_recovery_compensation_receipts
  TO ontos_runtime, pricing_management_routine_writer;
GRANT SELECT, INSERT ON TABLE pricing.currency_support_recovery_compensation_receipts
  TO pricing_management_routine_writer;
REVOKE ALL ON TABLE pricing.currency_support_recovery_compensation_receipts FROM ontos_runtime;

ALTER TABLE pricing.currency_support_recovery_compensation_receipts FORCE ROW LEVEL SECURITY;

CREATE FUNCTION pricing.compensate_tenant_currency_support_recovery_v1(
  p_tenant_id uuid,
  p_input jsonb
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_observed_at timestamptz := pg_catalog.statement_timestamp();
  v_compensation_invocation_id uuid;
  v_acting_principal_id uuid;
  v_committed_invocation_id uuid;
  v_trusted_operation_at timestamptz;
  v_reason text;
  v_request_payload jsonb;
  v_existing_compensation record;
  v_existing_for_commit record;
  v_committed_receipt record;
  v_support_id uuid;
  v_committed_revision_id uuid;
  v_committed_generation integer;
  v_committed_schedule_revision integer;
  v_committed_effective_from timestamptz;
  v_committed_effective_to timestamptz;
  v_head_revision_id uuid;
  v_head_schedule_revision integer;
  v_current_count integer;
  v_current record;
  v_compensation_schedule_revision_id uuid;
  v_compensation_schedule_revision integer;
  v_updated_count integer;
  v_result jsonb;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'Pricing Currency Support recovery compensation scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_input IS NULL OR pg_catalog.jsonb_typeof(p_input) <> 'object'
    OR p_input
      - 'actionInvocationId'
      - 'actorPrincipalId'
      - 'committedActionInvocationId'
      - 'reason'
      - 'trustedOperationAt' <> '{}'::jsonb
  THEN
    RAISE EXCEPTION 'Pricing Currency Support recovery compensation input is invalid' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_compensation_invocation_id := (p_input ->> 'actionInvocationId')::uuid;
    v_acting_principal_id := (p_input ->> 'actorPrincipalId')::uuid;
    v_committed_invocation_id := (p_input ->> 'committedActionInvocationId')::uuid;
    v_trusted_operation_at := (p_input ->> 'trustedOperationAt')::timestamptz;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Pricing Currency Support recovery compensation input is invalid' USING ERRCODE = '22023';
  END;
  v_reason := p_input ->> 'reason';
  IF v_compensation_invocation_id IS NULL OR v_acting_principal_id IS NULL
    OR v_committed_invocation_id IS NULL OR v_trusted_operation_at IS NULL
    OR v_trusted_operation_at > v_observed_at
    OR v_compensation_invocation_id = v_committed_invocation_id
    OR v_reason IS NULL OR v_reason <> pg_catalog.btrim(v_reason)
    OR pg_catalog.length(v_reason) NOT BETWEEN 1 AND 1000
  THEN
    RAISE EXCEPTION 'Pricing Currency Support recovery compensation input is invalid' USING ERRCODE = '22023';
  END IF;
  v_request_payload := p_input - 'trustedOperationAt';

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pricing:currency-support:' || p_tenant_id::text, 759)
  );

  SELECT receipt.* INTO v_existing_compensation
    FROM pricing.currency_support_recovery_compensation_receipts AS receipt
   WHERE receipt.tenant_id = p_tenant_id
     AND receipt.compensation_action_invocation_id = v_compensation_invocation_id;
  IF FOUND THEN
    IF v_existing_compensation.request_payload = v_request_payload THEN
      RETURN QUERY SELECT v_existing_compensation.result_payload;
    ELSE
      RETURN QUERY SELECT pg_catalog.jsonb_build_object(
        'outcome', 'CURRENCY_SUPPORT_RECOVERY_COMPENSATION_CONFLICT',
        'reason', 'IDEMPOTENCY_CONFLICT'
      );
    END IF;
    RETURN;
  END IF;

  SELECT receipt.* INTO v_existing_for_commit
    FROM pricing.currency_support_recovery_compensation_receipts AS receipt
   WHERE receipt.tenant_id = p_tenant_id
     AND receipt.committed_action_invocation_id = v_committed_invocation_id;
  IF FOUND THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      'outcome', 'CURRENCY_SUPPORT_RECOVERY_COMPENSATION_CONFLICT',
      'reason', 'ALREADY_COMPENSATED'
    );
    RETURN;
  END IF;

  SELECT receipt.* INTO v_committed_receipt
    FROM pricing.currency_support_action_result_receipts AS receipt
   WHERE receipt.tenant_id = p_tenant_id
     AND receipt.action_invocation_id = v_committed_invocation_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      'outcome', 'CURRENCY_SUPPORT_RECOVERY_COMPENSATION_CONFLICT',
      'reason', 'COMMITTED_RESULT_NOT_FOUND'
    );
    RETURN;
  END IF;
  IF v_committed_receipt.intent <> 'ESTABLISH_CURRENT'
    OR v_committed_receipt.request_payload #>> '{expectedState,state}' <> 'ABSENT'
    OR v_committed_receipt.result_payload ->> 'outcome' <> 'APPLIED'
    OR v_committed_receipt.result_payload ->> 'changed' <> 'true'
    OR v_committed_receipt.result_payload #> '{current,supportedCurrencies}' <> '["CZK"]'::jsonb
  THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      'outcome', 'CURRENCY_SUPPORT_RECOVERY_COMPENSATION_CONFLICT',
      'reason', 'COMMITTED_INTENT_MISMATCH'
    );
    RETURN;
  END IF;
  BEGIN
    v_support_id := (v_committed_receipt.result_payload ->> 'supportId')::uuid;
    v_committed_revision_id :=
      (v_committed_receipt.result_payload #>> '{current,supportRevisionId}')::uuid;
    v_committed_generation :=
      (v_committed_receipt.result_payload #>> '{current,generation}')::integer;
    v_committed_schedule_revision :=
      (v_committed_receipt.result_payload ->> 'scheduleRevision')::integer;
    v_committed_effective_from :=
      (v_committed_receipt.result_payload #>> '{current,effectiveFrom}')::timestamptz;
    v_committed_effective_to :=
      (v_committed_receipt.result_payload #>> '{current,effectiveTo}')::timestamptz;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR numeric_value_out_of_range THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      'outcome', 'CURRENCY_SUPPORT_RECOVERY_COMPENSATION_CONFLICT',
      'reason', 'COMMITTED_INTENT_MISMATCH'
    );
    RETURN;
  END;
  IF v_support_id IS NULL OR v_committed_revision_id IS NULL
    OR v_committed_generation IS NULL OR v_committed_generation < 1
    OR v_committed_schedule_revision IS NULL OR v_committed_schedule_revision < 1
    OR v_committed_effective_from IS NULL
  THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      'outcome', 'CURRENCY_SUPPORT_RECOVERY_COMPENSATION_CONFLICT',
      'reason', 'COMMITTED_INTENT_MISMATCH'
    );
    RETURN;
  END IF;

  SELECT head.currency_support_schedule_revision_id, head.schedule_revision
    INTO v_head_revision_id, v_head_schedule_revision
    FROM pricing.currency_support_schedule_heads AS head
   WHERE head.tenant_id = p_tenant_id
     AND head.currency_support_id = v_support_id
   FOR UPDATE;
  IF NOT FOUND OR v_head_schedule_revision <> v_committed_schedule_revision THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      'outcome', 'CURRENCY_SUPPORT_RECOVERY_COMPENSATION_CONFLICT',
      'reason', 'CANONICAL_STATE_CHANGED'
    );
    RETURN;
  END IF;

  SELECT count(*)::integer INTO v_current_count
    FROM pricing.currency_support_schedule_entries AS entry
   WHERE entry.tenant_id = p_tenant_id
     AND entry.currency_support_id = v_support_id
     AND entry.currency_support_schedule_revision_id = v_head_revision_id;
  IF v_current_count <> 1 THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      'outcome', 'CURRENCY_SUPPORT_RECOVERY_COMPENSATION_CONFLICT',
      'reason', 'CANONICAL_STATE_CHANGED'
    );
    RETURN;
  END IF;

  SELECT entry.currency_support_revision_id,
         entry.effective_from,
         entry.effective_to,
         revision.generation,
         revision.supported_currencies,
         revision.action_invocation_id AS revision_action_invocation_id,
         schedule.action_invocation_id AS schedule_action_invocation_id,
         root.created_by_action_invocation_id
    INTO v_current
    FROM pricing.currency_support_schedule_entries AS entry
    JOIN pricing.currency_support_value_revisions AS revision
      ON revision.tenant_id = entry.tenant_id
     AND revision.currency_support_id = entry.currency_support_id
     AND revision.currency_support_revision_id = entry.currency_support_revision_id
    JOIN pricing.currency_support_schedule_revisions AS schedule
      ON schedule.tenant_id = entry.tenant_id
     AND schedule.currency_support_id = entry.currency_support_id
     AND schedule.currency_support_schedule_revision_id = entry.currency_support_schedule_revision_id
    JOIN pricing.currency_support_roots AS root
      ON root.tenant_id = entry.tenant_id
     AND root.currency_support_id = entry.currency_support_id
   WHERE entry.tenant_id = p_tenant_id
     AND entry.currency_support_id = v_support_id
     AND entry.currency_support_schedule_revision_id = v_head_revision_id;
  IF v_current.currency_support_revision_id IS DISTINCT FROM v_committed_revision_id
    OR v_current.generation IS DISTINCT FROM v_committed_generation
    OR v_current.effective_from IS DISTINCT FROM v_committed_effective_from
    OR v_current.effective_to IS DISTINCT FROM v_committed_effective_to
    OR v_current.supported_currencies IS DISTINCT FROM '["CZK"]'::jsonb
    OR v_current.revision_action_invocation_id IS DISTINCT FROM v_committed_invocation_id
    OR v_current.schedule_action_invocation_id IS DISTINCT FROM v_committed_invocation_id
    OR v_current.created_by_action_invocation_id IS DISTINCT FROM v_committed_invocation_id
  THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      'outcome', 'CURRENCY_SUPPORT_RECOVERY_COMPENSATION_CONFLICT',
      'reason', 'CANONICAL_STATE_CHANGED'
    );
    RETURN;
  END IF;
  IF v_trusted_operation_at <= v_committed_effective_from
    OR (v_committed_effective_to IS NOT NULL AND v_trusted_operation_at >= v_committed_effective_to)
  THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      'outcome', 'CURRENCY_SUPPORT_RECOVERY_COMPENSATION_CONFLICT',
      'reason', 'EFFECTIVE_TIME_INVALID'
    );
    RETURN;
  END IF;

  v_compensation_schedule_revision := v_committed_schedule_revision + 1;
  v_compensation_schedule_revision_id := pg_catalog.gen_random_uuid();
  INSERT INTO pricing.currency_support_schedule_revisions (
    currency_support_schedule_revision_id,
    tenant_id,
    currency_support_id,
    schedule_revision,
    previous_schedule_revision_id,
    action_invocation_id,
    acting_principal_id,
    schedule_acknowledgement,
    reason,
    recorded_at
  ) VALUES (
    v_compensation_schedule_revision_id,
    p_tenant_id,
    v_support_id,
    v_compensation_schedule_revision,
    v_head_revision_id,
    v_compensation_invocation_id,
    v_acting_principal_id,
    NULL,
    v_reason,
    v_observed_at
  );
  INSERT INTO pricing.currency_support_schedule_entries (
    tenant_id,
    currency_support_id,
    currency_support_revision_id,
    currency_support_schedule_revision_id,
    schedule_revision,
    effective_from,
    effective_to
  ) VALUES (
    p_tenant_id,
    v_support_id,
    v_committed_revision_id,
    v_compensation_schedule_revision_id,
    v_compensation_schedule_revision,
    v_committed_effective_from,
    v_trusted_operation_at
  );
  UPDATE pricing.currency_support_schedule_heads
     SET currency_support_schedule_revision_id = v_compensation_schedule_revision_id,
         schedule_revision = v_compensation_schedule_revision
   WHERE tenant_id = p_tenant_id
     AND currency_support_id = v_support_id
     AND currency_support_schedule_revision_id = v_head_revision_id
     AND schedule_revision = v_committed_schedule_revision;
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count <> 1 THEN
    RAISE EXCEPTION 'Pricing Currency Support compensation head compare-and-swap failed' USING ERRCODE = '40001';
  END IF;

  v_result := pg_catalog.jsonb_build_object(
    'absentFrom', pg_catalog.to_char(
      v_trusted_operation_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'committedActionInvocationId', v_committed_invocation_id::text,
    'committedGeneration', v_committed_generation,
    'committedScheduleRevision', v_committed_schedule_revision,
    'committedSupportRevisionId', v_committed_revision_id::text,
    'compensationScheduleRevision', v_compensation_schedule_revision,
    'outcome', 'CURRENCY_SUPPORT_RECOVERY_COMPENSATED',
    'supportId', v_support_id::text
  );
  INSERT INTO pricing.currency_support_recovery_compensation_receipts (
    tenant_id,
    compensation_action_invocation_id,
    acting_principal_id,
    committed_action_invocation_id,
    currency_support_id,
    committed_currency_support_revision_id,
    previous_schedule_revision_id,
    compensation_schedule_revision_id,
    absent_from,
    request_payload,
    result_payload,
    reason,
    recorded_at
  ) VALUES (
    p_tenant_id,
    v_compensation_invocation_id,
    v_acting_principal_id,
    v_committed_invocation_id,
    v_support_id,
    v_committed_revision_id,
    v_head_revision_id,
    v_compensation_schedule_revision_id,
    v_trusted_operation_at,
    v_request_payload,
    v_result,
    v_reason,
    v_observed_at
  );
  RETURN QUERY SELECT v_result;
END;
$function$;

GRANT CREATE ON SCHEMA pricing TO pricing_management_routine_writer;
ALTER FUNCTION pricing.compensate_tenant_currency_support_recovery_v1(uuid,jsonb)
  OWNER TO pricing_management_routine_writer;
REVOKE CREATE ON SCHEMA pricing FROM pricing_management_routine_writer;
REVOKE ALL ON FUNCTION pricing.compensate_tenant_currency_support_recovery_v1(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pricing.compensate_tenant_currency_support_recovery_v1(uuid,jsonb)
  TO ontos_runtime;
