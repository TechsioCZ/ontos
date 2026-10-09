-- #797: keep exact Tenant Currency Support Action results, including no-op success.
-- Existing value/schedule revisions prove some older writes, but cannot reconstruct
-- their original result. Older no-op invocations left no owner record at all.
CREATE TABLE pricing.currency_support_action_result_receipts (
  currency_support_action_result_receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  action_invocation_id uuid NOT NULL,
  acting_principal_id uuid NOT NULL,
  intent text NOT NULL,
  request_payload jsonb NOT NULL,
  result_payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pricing_currency_support_results_invocation_uk UNIQUE (tenant_id, action_invocation_id),
  CONSTRAINT pricing_currency_support_results_intent_ck CHECK (
    intent IN ('ESTABLISH_CURRENT', 'VALUE_ONLY_CURRENT', 'SCHEDULE_REVISION')
  ),
  CONSTRAINT pricing_currency_support_results_payload_ck CHECK (
    jsonb_typeof(request_payload) = 'object' AND jsonb_typeof(result_payload) = 'object'
  ),
  CONSTRAINT pricing_currency_support_results_outcome_ck CHECK (
    result_payload ->> 'outcome' IN ('APPLIED', 'UNCHANGED')
  )
);

ALTER TABLE pricing.currency_support_action_result_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing.currency_support_action_result_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY pricing_currency_support_results_tenant_select
  ON pricing.currency_support_action_result_receipts FOR SELECT TO
    ontos_runtime, pricing_management_routine_writer
  USING (tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
CREATE POLICY pricing_currency_support_results_tenant_insert
  ON pricing.currency_support_action_result_receipts FOR INSERT TO pricing_management_routine_writer
  WITH CHECK (tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
CREATE POLICY pricing_currency_support_results_tenant_update
  ON pricing.currency_support_action_result_receipts FOR UPDATE TO pricing_management_routine_writer
  USING (false) WITH CHECK (false);
CREATE POLICY pricing_currency_support_results_tenant_delete
  ON pricing.currency_support_action_result_receipts FOR DELETE TO pricing_management_routine_writer
  USING (false);
REVOKE INSERT, UPDATE, DELETE ON TABLE pricing.currency_support_action_result_receipts FROM ontos_runtime;
GRANT SELECT ON TABLE pricing.currency_support_action_result_receipts TO ontos_runtime;

-- Keep the old entrypoint live for older deployed callers while journaling every
-- successful call made after this migration. The renamed body remains private.
ALTER FUNCTION pricing.set_tenant_currency_support_v1(uuid, jsonb)
  RENAME TO set_tenant_currency_support_unjournaled_v1;
REVOKE ALL ON FUNCTION pricing.set_tenant_currency_support_unjournaled_v1(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.set_tenant_currency_support_unjournaled_v1(uuid, jsonb) FROM ontos_runtime;

CREATE FUNCTION pricing.currency_support_expected_summary_v1(
  p_tenant_id uuid, p_support_id uuid, p_revision_id uuid,
  p_effective_from timestamptz, p_effective_to timestamptz
)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'effectivePeriod', pg_catalog.jsonb_build_object(
      'effectiveFrom', pg_catalog.to_char(p_effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'effectiveTo', CASE WHEN p_effective_to IS NULL THEN NULL ELSE
        pg_catalog.to_char(p_effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
    ),
    'generation', revision.generation,
    'supportedCurrencies', revision.supported_currencies,
    'supportRevisionRef', pg_catalog.jsonb_build_object(
      'moduleId', 'commerce.pricing',
      'resourceId', revision.currency_support_revision_id::text,
      'resourceType', 'commerce.pricing.currency-support-revision',
      'supportRootId', p_support_id::text,
      'tenantId', p_tenant_id::text
    )
  )
    FROM pricing.currency_support_value_revisions AS revision
   WHERE revision.tenant_id = p_tenant_id
     AND revision.currency_support_id = p_support_id
     AND revision.currency_support_revision_id = p_revision_id
$function$;

CREATE FUNCTION pricing.execute_tenant_currency_support_with_result_v1(
  p_tenant_id uuid, p_input jsonb, p_require_expected_state boolean
)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_invocation_id uuid;
  v_principal_id uuid;
  v_intent text;
  v_business_command jsonb;
  v_receipt record;
  v_result jsonb;
  v_expected_state jsonb;
  v_expected_observed_at timestamptz;
  v_support_id uuid;
  v_head_id uuid;
  v_schedule_revision integer;
  v_current_count integer;
  v_current jsonb;
  v_future jsonb;
  v_actual_expected_state jsonb;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'Pricing Currency Support result scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_input) <> 'object' THEN
    RAISE EXCEPTION 'Pricing Currency Support input is invalid' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_invocation_id := (p_input ->> 'actionInvocationId')::uuid;
    v_principal_id := (p_input ->> 'actorPrincipalId')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Pricing Currency Support invocation is invalid' USING ERRCODE = '22023';
  END;
  v_intent := p_input ->> 'intent';
  IF v_invocation_id IS NULL OR v_principal_id IS NULL OR v_intent IS NULL
    OR v_intent NOT IN ('ESTABLISH_CURRENT', 'VALUE_ONLY_CURRENT', 'SCHEDULE_REVISION')
  THEN
    RAISE EXCEPTION 'Pricing Currency Support invocation is invalid' USING ERRCODE = '22023';
  END IF;
  -- The caller's clock and reconstructed acknowledgement are transport
  -- evidence, not part of the durable business command. A retry may carry a
  -- later trusted clock or reconstruct the same acknowledgement differently.
  v_business_command := p_input - 'trustedOperationAt' - 'scheduleAcknowledgement';

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_tenant_id::text || ':currency-support-result:' || v_invocation_id::text, 0)
  );
  SELECT receipt.* INTO v_receipt
    FROM pricing.currency_support_action_result_receipts AS receipt
   WHERE receipt.tenant_id = p_tenant_id AND receipt.action_invocation_id = v_invocation_id;
  IF FOUND THEN
    IF v_receipt.acting_principal_id = v_principal_id
      AND v_receipt.intent = v_intent AND v_receipt.request_payload = v_business_command
    THEN
      RETURN QUERY SELECT v_receipt.result_payload;
    ELSE
      RETURN QUERY SELECT pg_catalog.jsonb_build_object(
        'changed', false,
        'outcome', 'CURRENT_STATE_CONFLICT',
        'reason', 'IDEMPOTENCY_CONFLICT'
      );
    END IF;
    RETURN;
  END IF;

  -- A pre-journal changed invocation is known to exist, but its original
  -- APPLIED result is not recoverable. Never replay it into a new success.
  IF EXISTS (
    SELECT 1 FROM pricing.currency_support_roots AS root
     WHERE root.tenant_id = p_tenant_id AND root.created_by_action_invocation_id = v_invocation_id
    UNION ALL
    SELECT 1 FROM pricing.currency_support_value_revisions AS revision
     WHERE revision.tenant_id = p_tenant_id AND revision.action_invocation_id = v_invocation_id
    UNION ALL
    SELECT 1 FROM pricing.currency_support_schedule_revisions AS revision
     WHERE revision.tenant_id = p_tenant_id AND revision.action_invocation_id = v_invocation_id
  ) THEN
    RAISE EXCEPTION 'Pricing Currency Support result predates exact receipt authority'
      USING ERRCODE = 'P7602';
  END IF;

  v_expected_state := p_input -> 'expectedState';
  IF p_require_expected_state AND v_expected_state IS NULL THEN
    RAISE EXCEPTION 'Pricing Currency Support expected state is required' USING ERRCODE = '22023';
  END IF;
  IF v_expected_state IS NOT NULL THEN
    IF jsonb_typeof(v_expected_state) <> 'object' THEN
      RAISE EXCEPTION 'Pricing Currency Support expected state is invalid' USING ERRCODE = '22023';
    END IF;
    -- Use the same Tenant lock as the canonical v1 writer. The complete
    -- expected state and subsequent mutation see one serialized schedule.
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('pricing:currency-support:' || p_tenant_id::text, 759)
    );
    SELECT root.currency_support_id INTO v_support_id
      FROM pricing.currency_support_roots AS root WHERE root.tenant_id = p_tenant_id;
    IF v_expected_state ->> 'state' = 'ABSENT' THEN
      IF v_expected_state <> '{"state":"ABSENT"}'::jsonb THEN
        RAISE EXCEPTION 'Pricing Currency Support expected state is invalid' USING ERRCODE = '22023';
      END IF;
      IF v_support_id IS NOT NULL THEN
        RETURN QUERY SELECT pg_catalog.jsonb_build_object(
          'changed', false, 'outcome', 'CURRENT_STATE_CONFLICT'
        );
        RETURN;
      END IF;
    ELSIF v_expected_state ->> 'state' = 'PRESENT' THEN
      BEGIN
        v_expected_observed_at := (v_expected_state ->> 'observedAt')::timestamptz;
      EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
        RAISE EXCEPTION 'Pricing Currency Support expected observation is invalid' USING ERRCODE = '22023';
      END;
      IF v_expected_observed_at IS NULL OR v_expected_observed_at > pg_catalog.statement_timestamp() THEN
        RAISE EXCEPTION 'Pricing Currency Support expected observation is invalid' USING ERRCODE = '22023';
      END IF;
      IF v_support_id IS NULL THEN
        RETURN QUERY SELECT pg_catalog.jsonb_build_object(
          'changed', false, 'outcome', 'CURRENT_STATE_CONFLICT'
        );
        RETURN;
      END IF;
      SELECT head.currency_support_schedule_revision_id, head.schedule_revision
        INTO v_head_id, v_schedule_revision
        FROM pricing.currency_support_schedule_heads AS head
       WHERE head.tenant_id = p_tenant_id AND head.currency_support_id = v_support_id;
      SELECT count(*)::integer,
             min(pricing.currency_support_expected_summary_v1(
               p_tenant_id, v_support_id, entry.currency_support_revision_id,
               entry.effective_from, entry.effective_to
             )::text)::jsonb
        INTO v_current_count, v_current
        FROM pricing.currency_support_schedule_entries AS entry
       WHERE entry.tenant_id = p_tenant_id
         AND entry.currency_support_id = v_support_id
         AND entry.currency_support_schedule_revision_id = v_head_id
         AND entry.effective_from <= v_expected_observed_at
         AND (entry.effective_to IS NULL OR v_expected_observed_at < entry.effective_to);
      SELECT coalesce(pg_catalog.jsonb_agg(
        pricing.currency_support_expected_summary_v1(
          p_tenant_id, v_support_id, entry.currency_support_revision_id,
          entry.effective_from, entry.effective_to
        ) ORDER BY entry.effective_from, entry.currency_support_revision_id
      ), '[]'::jsonb) INTO v_future
        FROM pricing.currency_support_schedule_entries AS entry
       WHERE entry.tenant_id = p_tenant_id
         AND entry.currency_support_id = v_support_id
         AND entry.currency_support_schedule_revision_id = v_head_id
         AND entry.effective_from > v_expected_observed_at;
      v_actual_expected_state := pg_catalog.jsonb_build_object(
        'current', v_current,
        'future', v_future,
        'observedAt', pg_catalog.to_char(v_expected_observed_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'scheduleRevision', v_schedule_revision,
        'state', 'PRESENT',
        'supportRootRef', pg_catalog.jsonb_build_object(
          'moduleId', 'commerce.pricing',
          'resourceId', v_support_id::text,
          'resourceType', 'commerce.pricing.currency-support',
          'tenantId', p_tenant_id::text
        )
      );
      IF v_head_id IS NULL OR v_current_count <> 1 OR v_expected_state <> v_actual_expected_state THEN
        RETURN QUERY SELECT pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'actualGeneration', (v_current ->> 'generation')::integer,
          'actualScheduleRevision', v_schedule_revision,
          'changed', false, 'outcome', 'CURRENT_STATE_CONFLICT',
          'supportedCurrencies', v_current -> 'supportedCurrencies'
        ));
        RETURN;
      END IF;
    ELSE
      RAISE EXCEPTION 'Pricing Currency Support expected state is invalid' USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT result.payload INTO v_result
    FROM pricing.set_tenant_currency_support_unjournaled_v1(p_tenant_id, p_input) AS result;
  IF v_result IS NULL OR jsonb_typeof(v_result) <> 'object' THEN
    RAISE EXCEPTION 'Pricing Currency Support returned no result' USING ERRCODE = 'P7602';
  END IF;
  IF v_result ->> 'outcome' IN ('APPLIED', 'UNCHANGED') THEN
    INSERT INTO pricing.currency_support_action_result_receipts (
      tenant_id, action_invocation_id, acting_principal_id, intent, request_payload, result_payload
    ) VALUES (p_tenant_id, v_invocation_id, v_principal_id, v_intent, v_business_command, v_result);
  END IF;
  RETURN QUERY SELECT v_result;
END;
$function$;

-- These two public compatibility entrypoints are the only path into the private
-- unjournaled implementation. SECURITY DEFINER is limited to fixed, qualified
-- calls; the shared executor and original writer both recheck trusted Tenant
-- scope before touching owner state.
CREATE FUNCTION pricing.set_tenant_currency_support_v2(p_tenant_id uuid, p_input jsonb)
RETURNS TABLE(payload jsonb) LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
  SELECT result.payload FROM pricing.execute_tenant_currency_support_with_result_v1(
    p_tenant_id, p_input, true
  ) AS result;
$function$;

CREATE FUNCTION pricing.set_tenant_currency_support_v1(p_tenant_id uuid, p_input jsonb)
RETURNS TABLE(payload jsonb) LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
  SELECT result.payload FROM pricing.execute_tenant_currency_support_with_result_v1(
    p_tenant_id, p_input, true
  ) AS result;
$function$;

CREATE FUNCTION pricing.verify_tenant_currency_support_generation_v1(p_tenant_id uuid, p_input jsonb)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_observed_at timestamptz := pg_catalog.clock_timestamp();
  v_support_id uuid;
  v_support_revision_id uuid;
  v_generation integer;
  v_schedule_revision integer;
  v_effective_at timestamptz;
  v_evidence_observed_at timestamptz;
  v_through timestamptz;
  v_expected_schedule_id uuid;
  v_expected_entry_count integer;
  v_changed_before_through boolean;
  v_common jsonb;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'Pricing Currency Support generation verification scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_input IS NULL OR pg_catalog.jsonb_typeof(p_input) <> 'object' THEN
    RAISE EXCEPTION 'Pricing Currency Support generation verification input is invalid' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_support_id := (p_input ->> 'supportId')::uuid;
    v_support_revision_id := (p_input ->> 'supportRevisionId')::uuid;
    v_generation := (p_input ->> 'generation')::integer;
    v_schedule_revision := (p_input ->> 'scheduleRevision')::integer;
    v_effective_at := (p_input ->> 'effectiveAt')::timestamptz;
    v_evidence_observed_at := (p_input ->> 'evidenceObservedAt')::timestamptz;
    v_through := (p_input ->> 'through')::timestamptz;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'Pricing Currency Support generation verification input is invalid' USING ERRCODE = '22023';
  END;
  IF v_support_id IS NULL OR v_support_revision_id IS NULL
    OR v_generation IS NULL OR v_generation < 1
    OR v_schedule_revision IS NULL OR v_schedule_revision < 1
    OR v_effective_at IS NULL OR v_evidence_observed_at IS NULL OR v_through IS NULL
    OR v_evidence_observed_at > v_through OR v_through > v_observed_at
  THEN
    RAISE EXCEPTION 'Pricing Currency Support generation verification input is invalid' USING ERRCODE = '22023';
  END IF;

  -- Coordinate with the canonical writer's exclusive Tenant lock. VOLATILE is
  -- required so reads after a wait receive a fresh READ COMMITTED snapshot and
  -- can observe the writer whose commit ordered before this verification.
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('pricing:currency-support:' || p_tenant_id::text, 759)
  );
  v_observed_at := pg_catalog.clock_timestamp();

  v_common := pg_catalog.jsonb_build_object(
    'observedAt', pg_catalog.to_char(
      v_observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'verifiedThrough', pg_catalog.to_char(
      v_through AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  );

  SELECT revision.currency_support_schedule_revision_id
    INTO v_expected_schedule_id
    FROM pricing.currency_support_schedule_revisions AS revision
    JOIN pricing.currency_support_roots AS root
      ON root.tenant_id = revision.tenant_id
     AND root.currency_support_id = revision.currency_support_id
   WHERE revision.tenant_id = p_tenant_id
     AND revision.currency_support_id = v_support_id
     AND revision.schedule_revision = v_schedule_revision
     AND pg_catalog.date_trunc('milliseconds', revision.recorded_at) <= v_evidence_observed_at;

  SELECT count(*)::integer
    INTO v_expected_entry_count
    FROM pricing.currency_support_schedule_entries AS entry
    JOIN pricing.currency_support_value_revisions AS revision
      ON revision.tenant_id = entry.tenant_id
     AND revision.currency_support_id = entry.currency_support_id
     AND revision.currency_support_revision_id = entry.currency_support_revision_id
   WHERE entry.tenant_id = p_tenant_id
     AND entry.currency_support_id = v_support_id
     AND entry.currency_support_schedule_revision_id = v_expected_schedule_id
     AND entry.currency_support_revision_id = v_support_revision_id
     AND revision.generation = v_generation
     AND entry.effective_from <= v_effective_at
     AND (entry.effective_to IS NULL OR v_effective_at < entry.effective_to)
     AND (entry.effective_to IS NULL OR v_through < entry.effective_to);

  SELECT EXISTS (
    SELECT 1
      FROM pricing.currency_support_schedule_revisions AS revision
     WHERE revision.tenant_id = p_tenant_id
       AND revision.currency_support_id = v_support_id
       AND revision.schedule_revision > v_schedule_revision
       AND pg_catalog.date_trunc('milliseconds', revision.recorded_at) <= v_through
  ) INTO v_changed_before_through;

  IF v_expected_schedule_id IS NULL OR v_expected_entry_count <> 1 OR v_changed_before_through THEN
    RETURN QUERY SELECT v_common || pg_catalog.jsonb_build_object(
      'outcome', 'CURRENCY_SUPPORT_CHANGED_BEFORE_FENCE'
    );
    RETURN;
  END IF;

  RETURN QUERY SELECT v_common || pg_catalog.jsonb_build_object(
    'generation', v_generation,
    'outcome', 'CURRENCY_SUPPORT_UNCHANGED_THROUGH',
    'scheduleRevision', v_schedule_revision,
    'supportId', v_support_id::text,
    'supportRevisionId', v_support_revision_id::text
  );
END;
$function$;

CREATE FUNCTION pricing.lookup_tenant_currency_support_result_v1(p_tenant_id uuid, p_input jsonb)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_invocation_id uuid;
  v_principal_id uuid;
  v_receipt record;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'Pricing Currency Support result scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_input) <> 'object' THEN
    RAISE EXCEPTION 'Pricing Currency Support result lookup input is invalid' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_invocation_id := (p_input ->> 'actionInvocationId')::uuid;
    v_principal_id := (p_input ->> 'actingPrincipalId')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Pricing Currency Support result lookup input is invalid' USING ERRCODE = '22023';
  END;
  IF v_invocation_id IS NULL OR v_principal_id IS NULL
    OR p_input <> pg_catalog.jsonb_build_object(
      'actionInvocationId', v_invocation_id::text,
      'actingPrincipalId', v_principal_id::text
    )
  THEN
    RAISE EXCEPTION 'Pricing Currency Support result lookup input is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT receipt.* INTO v_receipt
    FROM pricing.currency_support_action_result_receipts AS receipt
   WHERE receipt.tenant_id = p_tenant_id
     AND receipt.action_invocation_id = v_invocation_id
     AND receipt.acting_principal_id = v_principal_id;
  IF FOUND THEN
    RETURN QUERY SELECT pg_catalog.jsonb_build_object(
      'actionInvocationId', v_invocation_id::text,
      'actingPrincipalId', v_receipt.acting_principal_id::text,
      'intent', v_receipt.intent,
      'outcome', 'CURRENCY_SUPPORT_ACTION_RESULT_FOUND',
      'result', v_receipt.result_payload
    );
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pricing.currency_support_action_result_receipts AS receipt
     WHERE receipt.tenant_id = p_tenant_id
       AND receipt.action_invocation_id = v_invocation_id
  ) THEN
    RAISE EXCEPTION 'Pricing Currency Support result lookup principal mismatch' USING ERRCODE = '42501';
  END IF;

  -- A historical no-op is observationally identical to a never-started Action.
  -- Unknown is therefore the only truthful answer when no exact receipt exists.
  RETURN QUERY SELECT pg_catalog.jsonb_build_object(
    'actionInvocationId', v_invocation_id::text,
    'actingPrincipalId', v_principal_id::text,
    'outcome', 'CURRENCY_SUPPORT_ACTION_RESULT_UNKNOWN'
  );
END;
$function$;

DO $policies$
DECLARE
  v_policy record;
BEGIN
  FOR v_policy IN
    SELECT * FROM (VALUES
      ('currency_support_roots', 'pricing_currency_support_roots_tenant_select'),
      ('currency_support_roots', 'pricing_currency_support_roots_tenant_insert'),
      ('currency_support_schedule_entries', 'pricing_currency_support_entries_tenant_select'),
      ('currency_support_schedule_entries', 'pricing_currency_support_entries_tenant_insert'),
      ('currency_support_schedule_heads', 'pricing_currency_support_heads_tenant_select'),
      ('currency_support_schedule_heads', 'pricing_currency_support_heads_tenant_insert'),
      ('currency_support_schedule_heads', 'pricing_currency_support_heads_tenant_update'),
      ('currency_support_schedule_revisions', 'pricing_currency_support_schedule_tenant_select'),
      ('currency_support_schedule_revisions', 'pricing_currency_support_schedule_tenant_insert'),
      ('currency_support_value_revisions', 'pricing_currency_support_value_tenant_select'),
      ('currency_support_value_revisions', 'pricing_currency_support_value_tenant_insert')
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

GRANT SELECT, INSERT ON TABLE pricing.currency_support_roots,
  pricing.currency_support_schedule_entries, pricing.currency_support_schedule_revisions,
  pricing.currency_support_value_revisions, pricing.currency_support_action_result_receipts
TO pricing_management_routine_writer;
GRANT SELECT, INSERT, UPDATE ON TABLE pricing.currency_support_schedule_heads
TO pricing_management_routine_writer;
GRANT EXECUTE ON FUNCTION pricing.set_tenant_currency_support_unjournaled_v1(uuid,jsonb),
  pricing.execute_tenant_currency_support_with_result_v1(uuid,jsonb,boolean),
  pricing.currency_support_expected_summary_v1(uuid,uuid,uuid,timestamptz,timestamptz),
  pricing.currency_support_schedule_acknowledgement_v1(uuid,uuid,uuid,integer,uuid,timestamptz,jsonb,uuid),
  pricing.currency_support_scheduled_revision_json_v1(uuid,uuid,uuid,timestamptz,timestamptz)
TO pricing_management_routine_writer;

GRANT CREATE ON SCHEMA pricing TO pricing_management_routine_writer;
ALTER FUNCTION pricing.set_tenant_currency_support_v1(uuid,jsonb)
  OWNER TO pricing_management_routine_writer;
ALTER FUNCTION pricing.set_tenant_currency_support_v2(uuid,jsonb)
  OWNER TO pricing_management_routine_writer;
ALTER FUNCTION pricing.lookup_tenant_currency_support_result_v1(uuid,jsonb)
  OWNER TO pricing_management_routine_writer;
REVOKE CREATE ON SCHEMA pricing FROM pricing_management_routine_writer;

REVOKE ALL ON FUNCTION pricing.set_tenant_currency_support_v1(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.set_tenant_currency_support_v2(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.execute_tenant_currency_support_with_result_v1(uuid, jsonb, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.currency_support_expected_summary_v1(uuid, uuid, uuid, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.verify_tenant_currency_support_generation_v1(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.lookup_tenant_currency_support_result_v1(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pricing.execute_tenant_currency_support_with_result_v1(uuid, jsonb, boolean) FROM ontos_runtime;
REVOKE ALL ON FUNCTION pricing.currency_support_expected_summary_v1(uuid, uuid, uuid, timestamptz, timestamptz) FROM ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.set_tenant_currency_support_v1(uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.set_tenant_currency_support_v2(uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.verify_tenant_currency_support_generation_v1(uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.lookup_tenant_currency_support_result_v1(uuid, jsonb) TO ontos_runtime;
