-- #759 canonical Tenant Currency Support runtime. Legacy per-context rows remain qualified,
-- read-only history and are never unioned, intersected, or selected as a Tenant baseline.
ALTER TABLE pricing.currency_support_roots FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.currency_support_value_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.currency_support_schedule_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.currency_support_schedule_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE pricing.currency_support_schedule_heads FORCE ROW LEVEL SECURITY;

ALTER TABLE pricing.currency_support_schedule_entries
  ADD CONSTRAINT pricing_currency_support_entries_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    currency_support_id WITH =,
    currency_support_schedule_revision_id WITH =,
    pg_catalog.tstzrange(effective_from, effective_to, '[)') WITH &&
  );

REVOKE ALL ON TABLE pricing.currency_support_revisions FROM ontos_runtime;

CREATE FUNCTION pricing.currency_support_scheduled_revision_json_v1(
  p_tenant_id uuid,
  p_currency_support_id uuid,
  p_currency_support_revision_id uuid,
  p_effective_from timestamptz,
  p_effective_to timestamptz
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT jsonb_build_object(
    'effectiveFrom', to_char(p_effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'effectiveTo', CASE WHEN p_effective_to IS NULL THEN NULL ELSE
      to_char(p_effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'generation', revision.generation,
    'pricingRevision', revision.pricing_revision,
    'supportRevisionId', revision.currency_support_revision_id::text,
    'supportedCurrencies', revision.supported_currencies
  )
    FROM pricing.currency_support_value_revisions AS revision
   WHERE revision.tenant_id = p_tenant_id
     AND revision.currency_support_id = p_currency_support_id
     AND revision.currency_support_revision_id = p_currency_support_revision_id
$function$;

REVOKE ALL ON FUNCTION pricing.currency_support_scheduled_revision_json_v1(
  uuid, uuid, uuid, timestamptz, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pricing.currency_support_scheduled_revision_json_v1(
  uuid, uuid, uuid, timestamptz, timestamptz
) TO ontos_runtime;

CREATE FUNCTION pricing.currency_support_schedule_acknowledgement_v1(
  p_tenant_id uuid,
  p_currency_support_id uuid,
  p_currency_support_schedule_revision_id uuid,
  p_schedule_revision integer,
  p_target_revision_id uuid,
  p_intended_from timestamptz,
  p_intended_currencies jsonb,
  p_acting_principal_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_target_from timestamptz;
  v_target_to timestamptz;
  v_future jsonb;
  v_body jsonb;
  v_fingerprint text;
BEGIN
  SELECT entry.effective_from, entry.effective_to
    INTO STRICT v_target_from, v_target_to
    FROM pricing.currency_support_schedule_entries AS entry
   WHERE entry.tenant_id = p_tenant_id
     AND entry.currency_support_id = p_currency_support_id
     AND entry.currency_support_schedule_revision_id = p_currency_support_schedule_revision_id
     AND entry.currency_support_revision_id = p_target_revision_id;

  SELECT coalesce(jsonb_agg(
           pricing.currency_support_scheduled_revision_json_v1(
             p_tenant_id,
             p_currency_support_id,
             entry.currency_support_revision_id,
             entry.effective_from,
             entry.effective_to
           ) - 'pricingRevision' ORDER BY entry.effective_from, entry.currency_support_revision_id
         ), '[]'::jsonb)
    INTO v_future
    FROM pricing.currency_support_schedule_entries AS entry
   WHERE entry.tenant_id = p_tenant_id
     AND entry.currency_support_id = p_currency_support_id
     AND entry.currency_support_schedule_revision_id = p_currency_support_schedule_revision_id
     AND entry.effective_from >= v_target_to;

  v_body := jsonb_build_object(
    'actingPrincipalId', p_acting_principal_id::text,
    'intendedEffectivePeriod', jsonb_build_object(
      'effectiveFrom', to_char(p_intended_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'effectiveTo', CASE WHEN v_target_to IS NULL THEN NULL ELSE
        to_char(v_target_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
    ),
    'intendedSupportedCurrencies', p_intended_currencies,
    'presentedFuture', v_future,
    'scheduleRevision', p_schedule_revision,
    'supportId', p_currency_support_id::text,
    'targetEffectivePeriod', jsonb_build_object(
      'effectiveFrom', to_char(v_target_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'effectiveTo', CASE WHEN v_target_to IS NULL THEN NULL ELSE
        to_char(v_target_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
    ),
    'targetRevisionId', p_target_revision_id::text
  );
  v_fingerprint := pg_catalog.encode(
    public.digest(pg_catalog.convert_to(v_body::text, 'UTF8'), 'sha256'),
    'hex'
  );
  RETURN v_body || jsonb_build_object('fingerprint', v_fingerprint);
END;
$function$;

REVOKE ALL ON FUNCTION pricing.currency_support_schedule_acknowledgement_v1(
  uuid, uuid, uuid, integer, uuid, timestamptz, jsonb, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pricing.currency_support_schedule_acknowledgement_v1(
  uuid, uuid, uuid, integer, uuid, timestamptz, jsonb, uuid
) TO ontos_runtime;

CREATE FUNCTION pricing.read_tenant_currency_support_v1(
  p_tenant_id uuid,
  p_input jsonb
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_effective_at timestamptz;
  v_observed_at timestamptz := pg_catalog.statement_timestamp();
  v_mode text;
  v_root_count integer;
  v_currency_support_id uuid;
  v_head_revision_id uuid;
  v_schedule_revision integer;
  v_current_count integer;
  v_candidate_ids jsonb;
  v_current jsonb;
  v_future jsonb;
  v_revisions jsonb;
  v_next_boundary timestamptz;
  v_common jsonb;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'Pricing Currency Support read scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_input IS NULL OR jsonb_typeof(p_input) <> 'object' THEN
    RAISE EXCEPTION 'Pricing Currency Support read input is invalid' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_effective_at := (p_input ->> 'effectiveAt')::timestamptz;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Pricing Currency Support effective instant is invalid' USING ERRCODE = '22023';
  END;
  v_mode := p_input ->> 'evaluationMode';
  IF v_effective_at IS NULL OR v_mode IS DISTINCT FROM 'HISTORICAL_AS_OF' THEN
    RAISE EXCEPTION 'Pricing Currency Support read input is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT count(*)::integer, min(root.currency_support_id::text)::uuid
    INTO v_root_count, v_currency_support_id
    FROM pricing.currency_support_roots AS root
   WHERE root.tenant_id = p_tenant_id;

  v_common := jsonb_build_object(
    'activeRevisionCount', 0,
    'evaluatedAt', to_char(v_effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'evaluationMode', v_mode,
    'observedAt', to_char(v_observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
  IF v_root_count = 0 THEN
    RETURN QUERY SELECT v_common || jsonb_build_object('outcome', 'CURRENCY_SUPPORT_ABSENT');
    RETURN;
  END IF;
  IF v_root_count <> 1 THEN
    RETURN QUERY SELECT v_common || jsonb_build_object('outcome', 'CURRENCY_SUPPORT_CONFLICT');
    RETURN;
  END IF;

  SELECT head.currency_support_schedule_revision_id, head.schedule_revision
    INTO v_head_revision_id, v_schedule_revision
    FROM pricing.currency_support_schedule_heads AS head
   WHERE head.tenant_id = p_tenant_id
     AND head.currency_support_id = v_currency_support_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT v_common || jsonb_build_object(
      'outcome', 'CURRENCY_SUPPORT_CONFLICT',
      'supportId', v_currency_support_id::text
    );
    RETURN;
  END IF;

  SELECT count(*)::integer,
         coalesce(jsonb_agg(entry.currency_support_revision_id::text ORDER BY entry.effective_from), '[]'::jsonb),
         min(pricing.currency_support_scheduled_revision_json_v1(
           p_tenant_id,
           v_currency_support_id,
           entry.currency_support_revision_id,
           entry.effective_from,
           entry.effective_to
         )::text)::jsonb,
         min(entry.effective_to)
    INTO v_current_count, v_candidate_ids, v_current, v_next_boundary
    FROM pricing.currency_support_schedule_entries AS entry
   WHERE entry.tenant_id = p_tenant_id
     AND entry.currency_support_id = v_currency_support_id
     AND entry.currency_support_schedule_revision_id = v_head_revision_id
     AND entry.effective_from <= v_effective_at
     AND (entry.effective_to IS NULL OR v_effective_at < entry.effective_to);

  SELECT coalesce(jsonb_agg(
           pricing.currency_support_scheduled_revision_json_v1(
             p_tenant_id,
             v_currency_support_id,
             entry.currency_support_revision_id,
             entry.effective_from,
             entry.effective_to
           ) ORDER BY entry.effective_from, entry.currency_support_revision_id
         ), '[]'::jsonb),
         coalesce(jsonb_agg(
           pricing.currency_support_scheduled_revision_json_v1(
             p_tenant_id,
             v_currency_support_id,
             entry.currency_support_revision_id,
             entry.effective_from,
             entry.effective_to
           ) ORDER BY entry.effective_from, entry.currency_support_revision_id
         ) FILTER (WHERE entry.effective_from > v_effective_at), '[]'::jsonb)
    INTO v_revisions, v_future
    FROM pricing.currency_support_schedule_entries AS entry
   WHERE entry.tenant_id = p_tenant_id
     AND entry.currency_support_id = v_currency_support_id
     AND entry.currency_support_schedule_revision_id = v_head_revision_id;

  v_common := v_common || jsonb_build_object(
    'activeRevisionCount', v_current_count,
    'scheduleRevision', v_schedule_revision,
    'supportId', v_currency_support_id::text
  );
  IF v_current_count = 0 THEN
    SELECT min(entry.effective_from)
      INTO v_next_boundary
      FROM pricing.currency_support_schedule_entries AS entry
     WHERE entry.tenant_id = p_tenant_id
       AND entry.currency_support_id = v_currency_support_id
       AND entry.currency_support_schedule_revision_id = v_head_revision_id
       AND entry.effective_from > v_effective_at;
    RETURN QUERY SELECT v_common || jsonb_build_object(
      'outcome', 'CURRENCY_SUPPORT_GAP',
      'schedule', jsonb_build_object('future', v_future, 'revisions', v_revisions)
    ) || CASE WHEN v_next_boundary IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
      'nextApplicabilityBoundary', to_char(
        v_next_boundary AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
    ) END;
    RETURN;
  END IF;
  IF v_current_count <> 1 THEN
    RETURN QUERY SELECT v_common || jsonb_build_object(
      'candidateRevisionIds', v_candidate_ids,
      'outcome', 'CURRENCY_SUPPORT_CONFLICT'
    );
    RETURN;
  END IF;

  RETURN QUERY SELECT v_common || v_current || jsonb_build_object(
    'current', v_current,
    'outcome', 'CURRENCY_SUPPORT_CURRENT',
    'schedule', jsonb_build_object('current', v_current, 'future', v_future, 'revisions', v_revisions)
  ) || CASE WHEN v_next_boundary IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
    'nextApplicabilityBoundary', to_char(
      v_next_boundary AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  ) END;
END;
$function$;

REVOKE ALL ON FUNCTION pricing.read_tenant_currency_support_v1(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pricing.read_tenant_currency_support_v1(uuid, jsonb) TO ontos_runtime;

-- This is deliberately a separate routine and therefore a separate READ COMMITTED statement from
-- the requested as-of read. The caller may promote the first payload to Current only when its exact
-- root, head, schedule, outcome/cardinality, revision, and effective period match this fresh result.
CREATE FUNCTION pricing.revalidate_tenant_currency_support_v1(
  p_tenant_id uuid
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_observed_at timestamptz := pg_catalog.statement_timestamp();
  v_revalidated_at timestamptz;
  v_payload jsonb;
BEGIN
  SELECT read_result.payload
    INTO STRICT v_payload
    FROM pricing.read_tenant_currency_support_v1(
      p_tenant_id,
      jsonb_build_object(
        'effectiveAt', to_char(v_observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'evaluationMode', 'HISTORICAL_AS_OF'
      )
    ) AS read_result;

  v_revalidated_at := pg_catalog.clock_timestamp();
  RETURN QUERY SELECT (v_payload - 'evaluationMode') || jsonb_build_object(
    'evaluationMode', 'CURRENT_WITH_REVALIDATION',
    'revalidatedAt', to_char(v_revalidated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END;
$function$;

REVOKE ALL ON FUNCTION pricing.revalidate_tenant_currency_support_v1(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pricing.revalidate_tenant_currency_support_v1(uuid) TO ontos_runtime;

CREATE FUNCTION pricing.set_tenant_currency_support_v1(
  p_tenant_id uuid,
  p_input jsonb
)
RETURNS TABLE(payload jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_observed_at timestamptz := pg_catalog.statement_timestamp();
  v_action_invocation_id uuid;
  v_acting_principal_id uuid;
  v_expected_generation integer;
  v_expected_schedule_revision integer;
  v_effective_from timestamptz;
  v_effective_to timestamptz;
  v_intent text;
  v_reason text;
  v_desired jsonb;
  v_supplied_acknowledgement jsonb;
  v_currency_support_id uuid;
  v_head_revision_id uuid;
  v_schedule_revision integer;
  v_current_count integer;
  v_current record;
  v_expected_revision_id uuid;
  v_expected_from timestamptz;
  v_expected_to timestamptz;
  v_future_count integer;
  v_overlap_count integer;
  v_acknowledgement jsonb;
  v_new_revision_id uuid;
  v_new_schedule_revision_id uuid;
  v_new_generation integer;
  v_new_schedule_revision integer;
  v_previous_revision_id uuid;
  v_result_summary jsonb;
  v_updated_count integer;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'Pricing Currency Support write scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_input IS NULL OR jsonb_typeof(p_input) <> 'object' THEN
    RAISE EXCEPTION 'Pricing Currency Support write input is invalid' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_action_invocation_id := (p_input ->> 'actionInvocationId')::uuid;
    v_acting_principal_id := (p_input ->> 'actorPrincipalId')::uuid;
    v_expected_generation := (p_input ->> 'expectedGeneration')::integer;
    v_expected_schedule_revision := (p_input ->> 'expectedScheduleRevision')::integer;
    v_effective_from := (p_input ->> 'effectiveFrom')::timestamptz;
    v_effective_to := (p_input #>> '{intendedEffectivePeriod,effectiveTo}')::timestamptz;
    IF p_input ? 'expectedCurrent' THEN
      v_expected_revision_id := (p_input #>> '{expectedCurrent,supportRevisionId}')::uuid;
      v_expected_from := (p_input #>> '{expectedCurrent,effectiveFrom}')::timestamptz;
      v_expected_to := (p_input #>> '{expectedCurrent,effectiveTo}')::timestamptz;
    END IF;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'Pricing Currency Support write input is invalid' USING ERRCODE = '22023';
  END;
  v_reason := p_input ->> 'reason';
  v_intent := p_input ->> 'intent';
  v_desired := p_input -> 'supportedCurrencies';
  v_supplied_acknowledgement := p_input -> 'scheduleAcknowledgement';
  IF v_action_invocation_id IS NULL OR v_acting_principal_id IS NULL
    OR v_expected_generation IS NULL OR v_expected_generation < 0
    OR v_expected_schedule_revision IS NULL OR v_expected_schedule_revision < 0
    OR v_effective_from IS NULL
    OR v_intent IS NULL OR v_intent NOT IN ('ESTABLISH_CURRENT', 'VALUE_ONLY_CURRENT', 'SCHEDULE_REVISION')
    OR p_input ->> 'effectiveFrom' IS DISTINCT FROM p_input #>> '{intendedEffectivePeriod,effectiveFrom}'
    OR (v_effective_to IS NOT NULL AND v_effective_to <= v_effective_from)
    OR v_reason IS NULL OR v_reason <> btrim(v_reason) OR length(v_reason) NOT BETWEEN 1 AND 1000
    OR v_desired IS NULL OR jsonb_typeof(v_desired) <> 'array'
  THEN
    RAISE EXCEPTION 'Pricing Currency Support write input is invalid' USING ERRCODE = '22023';
  END IF;

  -- Generalized storage remains currency-aware. Launch activation is deliberately enforced at
  -- the authoritative write routine, not hardcoded into the schema or Price identity.
  IF v_desired <> '["CZK"]'::jsonb THEN
    RETURN QUERY SELECT jsonb_build_object(
      'actualGeneration', 0,
      'actualScheduleRevision', 0,
      'changed', false,
      'outcome', 'LAUNCH_CURRENCY_REJECTED',
      'supportedCurrencies', v_desired
    );
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pricing:currency-support:' || p_tenant_id::text, 759)
  );
  SELECT root.currency_support_id
    INTO v_currency_support_id
    FROM pricing.currency_support_roots AS root
   WHERE root.tenant_id = p_tenant_id;

  IF NOT FOUND THEN
    IF v_intent <> 'ESTABLISH_CURRENT'
      OR v_effective_from > v_observed_at
      OR (v_effective_to IS NOT NULL AND v_observed_at >= v_effective_to)
    THEN
      RETURN QUERY SELECT jsonb_build_object(
        'actualGeneration', 0,
        'actualScheduleRevision', 0,
        'changed', false,
        'outcome', 'EFFECTIVE_TIME_CONFLICT',
        'supportedCurrencies', '[]'::jsonb
      );
      RETURN;
    END IF;
    IF v_expected_generation <> 0 THEN
      RETURN QUERY SELECT jsonb_build_object(
        'actualGeneration', 0,
        'actualScheduleRevision', 0,
        'changed', false,
        'expectedGeneration', v_expected_generation,
        'outcome', 'REVISION_CONFLICT',
        'supportedCurrencies', '[]'::jsonb
      );
      RETURN;
    END IF;
    IF v_expected_schedule_revision <> 0 THEN
      RETURN QUERY SELECT jsonb_build_object(
        'actualGeneration', 0,
        'actualScheduleRevision', 0,
        'changed', false,
        'expectedScheduleRevision', v_expected_schedule_revision,
        'outcome', 'SCHEDULE_CONFLICT',
        'supportedCurrencies', '[]'::jsonb
      );
      RETURN;
    END IF;
    v_currency_support_id := pg_catalog.gen_random_uuid();
    v_new_revision_id := pg_catalog.gen_random_uuid();
    v_new_schedule_revision_id := pg_catalog.gen_random_uuid();
    INSERT INTO pricing.currency_support_roots (
      currency_support_id, tenant_id, created_by_action_invocation_id, created_by_principal_id, created_at
    ) VALUES (
      v_currency_support_id, p_tenant_id, v_action_invocation_id, v_acting_principal_id, v_observed_at
    );
    INSERT INTO pricing.currency_support_value_revisions (
      currency_support_revision_id, tenant_id, currency_support_id, generation, pricing_revision,
      supported_currencies, previous_revision_id, action_invocation_id, acting_principal_id, reason, recorded_at
    ) VALUES (
      v_new_revision_id, p_tenant_id, v_currency_support_id, 1, 'pricing-currency-support:1',
      v_desired, NULL, v_action_invocation_id, v_acting_principal_id, v_reason, v_observed_at
    );
    INSERT INTO pricing.currency_support_schedule_revisions (
      currency_support_schedule_revision_id, tenant_id, currency_support_id, schedule_revision,
      previous_schedule_revision_id, action_invocation_id, acting_principal_id, schedule_acknowledgement,
      reason, recorded_at
    ) VALUES (
      v_new_schedule_revision_id, p_tenant_id, v_currency_support_id, 1,
      NULL, v_action_invocation_id, v_acting_principal_id, NULL, v_reason, v_observed_at
    );
    INSERT INTO pricing.currency_support_schedule_entries (
      tenant_id, currency_support_id, currency_support_revision_id,
      currency_support_schedule_revision_id, schedule_revision, effective_from, effective_to
    ) VALUES (
      p_tenant_id, v_currency_support_id, v_new_revision_id, v_new_schedule_revision_id, 1,
      v_effective_from, v_effective_to
    );
    INSERT INTO pricing.currency_support_schedule_heads (
      tenant_id, currency_support_id, currency_support_schedule_revision_id, schedule_revision
    ) VALUES (p_tenant_id, v_currency_support_id, v_new_schedule_revision_id, 1);
    v_result_summary := pricing.currency_support_scheduled_revision_json_v1(
      p_tenant_id, v_currency_support_id, v_new_revision_id, v_effective_from, v_effective_to
    );
    RETURN QUERY SELECT jsonb_build_object(
      'actualGeneration', 1,
      'actualScheduleRevision', 1,
      'changed', true,
      'current', v_result_summary,
      'generation', 1,
      'outcome', 'APPLIED',
      'pricingRevision', 'pricing-currency-support:1',
      'scheduleRevision', 1,
      'supportId', v_currency_support_id::text,
      'supportedCurrencies', v_desired
    );
    RETURN;
  END IF;

  SELECT head.currency_support_schedule_revision_id, head.schedule_revision
    INTO v_head_revision_id, v_schedule_revision
    FROM pricing.currency_support_schedule_heads AS head
   WHERE head.tenant_id = p_tenant_id
     AND head.currency_support_id = v_currency_support_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT jsonb_build_object(
      'actualGeneration', 0,
      'actualScheduleRevision', 0,
      'changed', false,
      'outcome', 'CURRENT_STATE_CONFLICT',
      'supportId', v_currency_support_id::text,
      'supportedCurrencies', '[]'::jsonb
    );
    RETURN;
  END IF;
  IF v_intent = 'ESTABLISH_CURRENT' THEN
    RETURN QUERY SELECT jsonb_build_object(
      'actualGeneration', 0,
      'actualScheduleRevision', v_schedule_revision,
      'changed', false,
      'outcome', 'REVISION_CONFLICT',
      'supportId', v_currency_support_id::text,
      'supportedCurrencies', '[]'::jsonb
    );
    RETURN;
  END IF;

  SELECT count(*)::integer
    INTO v_current_count
    FROM pricing.currency_support_schedule_entries AS entry
   WHERE entry.tenant_id = p_tenant_id
     AND entry.currency_support_id = v_currency_support_id
     AND entry.currency_support_schedule_revision_id = v_head_revision_id
     AND entry.effective_from <= v_observed_at
     AND (entry.effective_to IS NULL OR v_observed_at < entry.effective_to);
  IF v_current_count <> 1 THEN
    RETURN QUERY SELECT jsonb_build_object(
      'activeRevisionCount', v_current_count,
      'actualGeneration', 0,
      'actualScheduleRevision', v_schedule_revision,
      'changed', false,
      'outcome', 'CURRENT_STATE_CONFLICT',
      'supportId', v_currency_support_id::text,
      'supportedCurrencies', '[]'::jsonb
    );
    RETURN;
  END IF;

  SELECT entry.currency_support_revision_id,
         entry.effective_from,
         entry.effective_to,
         revision.generation,
         revision.pricing_revision,
         revision.supported_currencies
    INTO v_current
    FROM pricing.currency_support_schedule_entries AS entry
    JOIN pricing.currency_support_value_revisions AS revision
      ON revision.tenant_id = entry.tenant_id
     AND revision.currency_support_id = entry.currency_support_id
     AND revision.currency_support_revision_id = entry.currency_support_revision_id
   WHERE entry.tenant_id = p_tenant_id
     AND entry.currency_support_id = v_currency_support_id
     AND entry.currency_support_schedule_revision_id = v_head_revision_id
     AND entry.effective_from <= v_observed_at
     AND (entry.effective_to IS NULL OR v_observed_at < entry.effective_to);

  IF v_schedule_revision <> v_expected_schedule_revision THEN
    RETURN QUERY SELECT jsonb_build_object(
      'actualGeneration', v_current.generation,
      'actualScheduleRevision', v_schedule_revision,
      'changed', false,
      'expectedScheduleRevision', v_expected_schedule_revision,
      'outcome', 'SCHEDULE_CONFLICT',
      'supportId', v_currency_support_id::text,
      'supportedCurrencies', v_current.supported_currencies
    );
    RETURN;
  END IF;
  IF v_current.generation <> v_expected_generation THEN
    RETURN QUERY SELECT jsonb_build_object(
      'actualGeneration', v_current.generation,
      'actualScheduleRevision', v_schedule_revision,
      'changed', false,
      'expectedGeneration', v_expected_generation,
      'outcome', 'REVISION_CONFLICT',
      'supportId', v_currency_support_id::text,
      'supportedCurrencies', v_current.supported_currencies
    );
    RETURN;
  END IF;
  IF v_expected_revision_id IS NULL
    OR v_expected_revision_id IS DISTINCT FROM v_current.currency_support_revision_id
    OR v_expected_from IS DISTINCT FROM v_current.effective_from
    OR v_expected_to IS DISTINCT FROM v_current.effective_to
  THEN
    RETURN QUERY SELECT jsonb_build_object(
      'actualGeneration', v_current.generation,
      'actualScheduleRevision', v_schedule_revision,
      'changed', false,
      'outcome', CASE WHEN v_supplied_acknowledgement IS NULL
        THEN 'CURRENT_STATE_CONFLICT' ELSE 'SCHEDULE_ACKNOWLEDGEMENT_STALE' END,
      'supportId', v_currency_support_id::text,
      'supportedCurrencies', v_current.supported_currencies
    );
    RETURN;
  END IF;

  SELECT coalesce(max(revision.generation), 0) + 1
    INTO v_new_generation
    FROM pricing.currency_support_value_revisions AS revision
   WHERE revision.tenant_id = p_tenant_id
     AND revision.currency_support_id = v_currency_support_id;

  IF v_intent = 'SCHEDULE_REVISION' THEN
    IF v_effective_from <= v_observed_at THEN
      RETURN QUERY SELECT jsonb_build_object(
        'actualGeneration', v_current.generation,
        'actualScheduleRevision', v_schedule_revision,
        'changed', false,
        'outcome', 'EFFECTIVE_TIME_CONFLICT',
        'reason', 'BOUNDARY_CROSSED',
        'supportId', v_currency_support_id::text,
        'supportedCurrencies', v_current.supported_currencies
      );
      RETURN;
    END IF;
    SELECT count(*)::integer
      INTO v_overlap_count
      FROM pricing.currency_support_schedule_entries AS entry
     WHERE entry.tenant_id = p_tenant_id
       AND entry.currency_support_id = v_currency_support_id
       AND entry.currency_support_schedule_revision_id = v_head_revision_id
       AND pg_catalog.tstzrange(entry.effective_from, entry.effective_to, '[)')
           && pg_catalog.tstzrange(v_effective_from, v_effective_to, '[)');
    IF v_overlap_count > 0 THEN
      RETURN QUERY SELECT jsonb_build_object(
        'actualGeneration', v_current.generation,
        'actualScheduleRevision', v_schedule_revision,
        'changed', false,
        'outcome', 'SCHEDULE_CONFLICT',
        'reason', 'OVERLAPPING_SCHEDULE',
        'supportId', v_currency_support_id::text,
        'supportedCurrencies', v_current.supported_currencies
      );
      RETURN;
    END IF;

    SELECT entry.currency_support_revision_id
      INTO v_previous_revision_id
      FROM pricing.currency_support_schedule_entries AS entry
     WHERE entry.tenant_id = p_tenant_id
       AND entry.currency_support_id = v_currency_support_id
       AND entry.currency_support_schedule_revision_id = v_head_revision_id
       AND entry.effective_from < v_effective_from
     ORDER BY entry.effective_from DESC, entry.currency_support_revision_id
     LIMIT 1;

    v_new_schedule_revision := v_schedule_revision + 1;
    v_new_revision_id := pg_catalog.gen_random_uuid();
    v_new_schedule_revision_id := pg_catalog.gen_random_uuid();
    INSERT INTO pricing.currency_support_value_revisions (
      currency_support_revision_id, tenant_id, currency_support_id, generation, pricing_revision,
      supported_currencies, previous_revision_id, action_invocation_id, acting_principal_id, reason, recorded_at
    ) VALUES (
      v_new_revision_id, p_tenant_id, v_currency_support_id, v_new_generation,
      'pricing-currency-support:' || v_new_generation::text, v_desired,
      v_previous_revision_id, v_action_invocation_id, v_acting_principal_id, v_reason, v_observed_at
    );
    INSERT INTO pricing.currency_support_schedule_revisions (
      currency_support_schedule_revision_id, tenant_id, currency_support_id, schedule_revision,
      previous_schedule_revision_id, action_invocation_id, acting_principal_id, schedule_acknowledgement,
      reason, recorded_at
    ) VALUES (
      v_new_schedule_revision_id, p_tenant_id, v_currency_support_id, v_new_schedule_revision,
      v_head_revision_id, v_action_invocation_id, v_acting_principal_id, NULL, v_reason, v_observed_at
    );
    INSERT INTO pricing.currency_support_schedule_entries (
      tenant_id, currency_support_id, currency_support_revision_id,
      currency_support_schedule_revision_id, schedule_revision, effective_from, effective_to
    )
    SELECT entry.tenant_id,
           entry.currency_support_id,
           entry.currency_support_revision_id,
           v_new_schedule_revision_id,
           v_new_schedule_revision,
           entry.effective_from,
           entry.effective_to
      FROM pricing.currency_support_schedule_entries AS entry
     WHERE entry.tenant_id = p_tenant_id
       AND entry.currency_support_id = v_currency_support_id
       AND entry.currency_support_schedule_revision_id = v_head_revision_id;
    INSERT INTO pricing.currency_support_schedule_entries (
      tenant_id, currency_support_id, currency_support_revision_id,
      currency_support_schedule_revision_id, schedule_revision, effective_from, effective_to
    ) VALUES (
      p_tenant_id, v_currency_support_id, v_new_revision_id,
      v_new_schedule_revision_id, v_new_schedule_revision, v_effective_from, v_effective_to
    );
    UPDATE pricing.currency_support_schedule_heads
       SET currency_support_schedule_revision_id = v_new_schedule_revision_id,
           schedule_revision = v_new_schedule_revision
     WHERE tenant_id = p_tenant_id
       AND currency_support_id = v_currency_support_id
       AND schedule_revision = v_expected_schedule_revision;
    GET DIAGNOSTICS v_updated_count = ROW_COUNT;
    IF v_updated_count <> 1 THEN
      RAISE EXCEPTION 'Pricing Currency Support head compare-and-swap failed' USING ERRCODE = '40001';
    END IF;
    v_result_summary := pricing.currency_support_scheduled_revision_json_v1(
      p_tenant_id,
      v_currency_support_id,
      v_current.currency_support_revision_id,
      v_current.effective_from,
      v_current.effective_to
    );
    RETURN QUERY SELECT jsonb_build_object(
      'actualGeneration', v_new_generation,
      'actualScheduleRevision', v_new_schedule_revision,
      'changed', true,
      'current', v_result_summary,
      'generation', v_current.generation,
      'outcome', 'APPLIED',
      'pricingRevision', v_current.pricing_revision,
      'scheduleRevision', v_new_schedule_revision,
      'supportId', v_currency_support_id::text,
      'supportedCurrencies', v_current.supported_currencies
    );
    RETURN;
  END IF;

  -- Expectations and the exact Current target are always checked before a legitimate no-op.
  IF v_current.supported_currencies = v_desired
    AND v_effective_from = v_current.effective_from
    AND v_effective_to IS NOT DISTINCT FROM v_current.effective_to
  THEN
    v_result_summary := pricing.currency_support_scheduled_revision_json_v1(
      p_tenant_id,
      v_currency_support_id,
      v_current.currency_support_revision_id,
      v_current.effective_from,
      v_current.effective_to
    );
    RETURN QUERY SELECT jsonb_build_object(
      'actualGeneration', v_current.generation,
      'actualScheduleRevision', v_schedule_revision,
      'changed', false,
      'current', v_result_summary,
      'generation', v_current.generation,
      'outcome', 'UNCHANGED',
      'pricingRevision', v_current.pricing_revision,
      'scheduleRevision', v_schedule_revision,
      'supportId', v_currency_support_id::text,
      'supportedCurrencies', v_current.supported_currencies
    );
    RETURN;
  END IF;

  IF v_effective_from < v_current.effective_from
    OR v_effective_from > v_observed_at
    OR (v_current.effective_to IS NOT NULL AND v_effective_from >= v_current.effective_to)
    OR v_effective_to IS DISTINCT FROM v_current.effective_to
  THEN
    RETURN QUERY SELECT jsonb_build_object(
      'actualGeneration', v_current.generation,
      'actualScheduleRevision', v_schedule_revision,
      'changed', false,
      'outcome', 'EFFECTIVE_TIME_CONFLICT',
      'supportId', v_currency_support_id::text,
      'supportedCurrencies', v_current.supported_currencies
    );
    RETURN;
  END IF;

  SELECT count(*)::integer
    INTO v_future_count
    FROM pricing.currency_support_schedule_entries AS entry
   WHERE entry.tenant_id = p_tenant_id
     AND entry.currency_support_id = v_currency_support_id
     AND entry.currency_support_schedule_revision_id = v_head_revision_id
     AND entry.effective_from >= v_current.effective_to;
  IF v_future_count > 0 THEN
    v_acknowledgement := pricing.currency_support_schedule_acknowledgement_v1(
      p_tenant_id,
      v_currency_support_id,
      v_head_revision_id,
      v_schedule_revision,
      v_current.currency_support_revision_id,
      v_effective_from,
      v_desired,
      v_acting_principal_id
    );
    IF v_supplied_acknowledgement IS NULL THEN
      RETURN QUERY SELECT jsonb_build_object(
        'actualGeneration', v_current.generation,
        'actualScheduleRevision', v_schedule_revision,
        'changed', false,
        'outcome', 'SCHEDULE_ACKNOWLEDGEMENT_REQUIRED',
        'scheduleAcknowledgement', v_acknowledgement,
        'supportId', v_currency_support_id::text,
        'supportedCurrencies', v_current.supported_currencies
      );
      RETURN;
    END IF;
    IF v_supplied_acknowledgement <> v_acknowledgement THEN
      RETURN QUERY SELECT jsonb_build_object(
        'actualGeneration', v_current.generation,
        'actualScheduleRevision', v_schedule_revision,
        'changed', false,
        'outcome', 'SCHEDULE_ACKNOWLEDGEMENT_STALE',
        'supportId', v_currency_support_id::text,
        'supportedCurrencies', v_current.supported_currencies
      );
      RETURN;
    END IF;
  END IF;

  v_new_schedule_revision := v_schedule_revision + 1;
  v_new_revision_id := pg_catalog.gen_random_uuid();
  v_new_schedule_revision_id := pg_catalog.gen_random_uuid();
  INSERT INTO pricing.currency_support_value_revisions (
    currency_support_revision_id, tenant_id, currency_support_id, generation, pricing_revision,
    supported_currencies, previous_revision_id, action_invocation_id, acting_principal_id, reason, recorded_at
  ) VALUES (
    v_new_revision_id, p_tenant_id, v_currency_support_id, v_new_generation,
    'pricing-currency-support:' || v_new_generation::text, v_desired,
    v_current.currency_support_revision_id, v_action_invocation_id, v_acting_principal_id, v_reason, v_observed_at
  );
  INSERT INTO pricing.currency_support_schedule_revisions (
    currency_support_schedule_revision_id, tenant_id, currency_support_id, schedule_revision,
    previous_schedule_revision_id, action_invocation_id, acting_principal_id, schedule_acknowledgement,
    reason, recorded_at
  ) VALUES (
    v_new_schedule_revision_id, p_tenant_id, v_currency_support_id, v_new_schedule_revision,
    v_head_revision_id, v_action_invocation_id, v_acting_principal_id, v_supplied_acknowledgement,
    v_reason, v_observed_at
  );

  INSERT INTO pricing.currency_support_schedule_entries (
    tenant_id, currency_support_id, currency_support_revision_id,
    currency_support_schedule_revision_id, schedule_revision, effective_from, effective_to
  )
  SELECT entry.tenant_id,
         entry.currency_support_id,
         entry.currency_support_revision_id,
         v_new_schedule_revision_id,
         v_new_schedule_revision,
         entry.effective_from,
         entry.effective_to
    FROM pricing.currency_support_schedule_entries AS entry
   WHERE entry.tenant_id = p_tenant_id
     AND entry.currency_support_id = v_currency_support_id
     AND entry.currency_support_schedule_revision_id = v_head_revision_id
     AND entry.currency_support_revision_id <> v_current.currency_support_revision_id;

  IF v_current.effective_from < v_effective_from THEN
    INSERT INTO pricing.currency_support_schedule_entries (
      tenant_id, currency_support_id, currency_support_revision_id,
      currency_support_schedule_revision_id, schedule_revision, effective_from, effective_to
    ) VALUES (
      p_tenant_id, v_currency_support_id, v_current.currency_support_revision_id,
      v_new_schedule_revision_id, v_new_schedule_revision, v_current.effective_from, v_effective_from
    );
  END IF;
  INSERT INTO pricing.currency_support_schedule_entries (
    tenant_id, currency_support_id, currency_support_revision_id,
    currency_support_schedule_revision_id, schedule_revision, effective_from, effective_to
  ) VALUES (
    p_tenant_id, v_currency_support_id, v_new_revision_id,
    v_new_schedule_revision_id, v_new_schedule_revision, v_effective_from, v_current.effective_to
  );

  UPDATE pricing.currency_support_schedule_heads
     SET currency_support_schedule_revision_id = v_new_schedule_revision_id,
         schedule_revision = v_new_schedule_revision
   WHERE tenant_id = p_tenant_id
     AND currency_support_id = v_currency_support_id
     AND schedule_revision = v_expected_schedule_revision;
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count <> 1 THEN
    RAISE EXCEPTION 'Pricing Currency Support head compare-and-swap failed' USING ERRCODE = '40001';
  END IF;

  v_result_summary := pricing.currency_support_scheduled_revision_json_v1(
    p_tenant_id, v_currency_support_id, v_new_revision_id, v_effective_from, v_current.effective_to
  );
  RETURN QUERY SELECT jsonb_build_object(
    'actualGeneration', v_new_generation,
    'actualScheduleRevision', v_new_schedule_revision,
    'changed', true,
    'current', v_result_summary,
    'generation', v_new_generation,
    'outcome', 'APPLIED',
    'pricingRevision', 'pricing-currency-support:' || v_new_generation::text,
    'scheduleRevision', v_new_schedule_revision,
    'supportId', v_currency_support_id::text,
    'supportedCurrencies', v_desired
  );
END;
$function$;

REVOKE ALL ON FUNCTION pricing.set_tenant_currency_support_v1(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pricing.set_tenant_currency_support_v1(uuid, jsonb) TO ontos_runtime;

-- Legacy wire routines become bounded adapters over the one canonical Tenant authority. They do
-- not read or mutate the qualified legacy relation after this migration.
CREATE OR REPLACE FUNCTION pricing.read_current_supported_currencies(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_input jsonb
)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_payload jsonb;
BEGIN
  IF p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'Pricing Currency Support compatibility scope mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT read_result.payload INTO v_payload
    FROM pricing.read_tenant_currency_support_v1(
      p_tenant_id,
      jsonb_build_object(
        'effectiveAt', p_input ->> 'effectiveAt',
        'evaluationMode', 'HISTORICAL_AS_OF'
      )
    ) AS read_result;
  IF v_payload ->> 'outcome' = 'CURRENCY_SUPPORT_CURRENT' THEN
    RETURN QUERY SELECT jsonb_build_object(
      'generation', (v_payload ->> 'generation')::integer,
      'nextApplicabilityBoundary', v_payload -> 'nextApplicabilityBoundary',
      'observedAt', v_payload ->> 'observedAt',
      'pricingRevision', v_payload ->> 'pricingRevision',
      'supportedCurrencies', v_payload -> 'supportedCurrencies'
    );
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION pricing.read_current_supported_currencies(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pricing.read_current_supported_currencies(uuid, uuid, jsonb) TO ontos_runtime;

DROP FUNCTION pricing.read_tenant_supported_currencies_v2(uuid, uuid, jsonb);
CREATE FUNCTION pricing.read_tenant_supported_currencies_v2(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_input jsonb
)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_payload jsonb;
BEGIN
  IF p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'Pricing Currency Support compatibility scope mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT read_result.payload INTO v_payload
    FROM pricing.read_tenant_currency_support_v1(
      p_tenant_id,
      jsonb_build_object(
        'effectiveAt', p_input ->> 'effectiveAt',
        'evaluationMode', 'HISTORICAL_AS_OF'
      )
    ) AS read_result;
  RETURN QUERY SELECT jsonb_build_object(
    'activeRevisionCount', coalesce((v_payload ->> 'activeRevisionCount')::integer, 0),
    'observedAt', v_payload ->> 'observedAt',
    'outcome', CASE v_payload ->> 'outcome'
      WHEN 'CURRENCY_SUPPORT_ABSENT' THEN 'ABSENT'
      WHEN 'CURRENCY_SUPPORT_CURRENT' THEN 'UNAMBIGUOUS'
      ELSE 'AMBIGUOUS'
    END,
    'revision', CASE WHEN v_payload ->> 'outcome' = 'CURRENCY_SUPPORT_CURRENT' THEN jsonb_build_object(
      'generation', (v_payload ->> 'generation')::integer,
      'nextApplicabilityBoundary', v_payload -> 'nextApplicabilityBoundary',
      'pricingRevision', v_payload ->> 'pricingRevision',
      'recordedAt', v_payload ->> 'observedAt',
      'supportedCurrencies', v_payload -> 'supportedCurrencies'
    ) ELSE NULL END
  );
END;
$function$;

REVOKE ALL ON FUNCTION pricing.read_tenant_supported_currencies_v2(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pricing.read_tenant_supported_currencies_v2(uuid, uuid, jsonb) TO ontos_runtime;

CREATE OR REPLACE FUNCTION pricing.set_supported_currencies(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_input jsonb
)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_head record;
  v_current record;
  v_payload jsonb;
  v_canonical_input jsonb;
BEGIN
  IF p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'Pricing Currency Support compatibility scope mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT root.currency_support_id,
         head.currency_support_schedule_revision_id,
         head.schedule_revision
    INTO v_head
    FROM pricing.currency_support_roots AS root
    LEFT JOIN pricing.currency_support_schedule_heads AS head
      ON head.tenant_id = root.tenant_id
     AND head.currency_support_id = root.currency_support_id
   WHERE root.tenant_id = p_tenant_id;
  IF FOUND THEN
    SELECT entry.currency_support_revision_id,
           entry.effective_from,
           entry.effective_to
      INTO v_current
      FROM pricing.currency_support_schedule_entries AS entry
     WHERE entry.tenant_id = p_tenant_id
       AND entry.currency_support_id = v_head.currency_support_id
       AND entry.currency_support_schedule_revision_id = v_head.currency_support_schedule_revision_id
       AND entry.effective_from <= pg_catalog.statement_timestamp()
       AND (entry.effective_to IS NULL OR pg_catalog.statement_timestamp() < entry.effective_to);
  END IF;
  v_canonical_input := jsonb_build_object(
    'actionInvocationId', p_input ->> 'actionInvocationId',
    'actorPrincipalId', p_input ->> 'actorPrincipalId',
    'effectiveFrom', p_input ->> 'effectiveFrom',
    'expectedGeneration', p_input -> 'expectedGeneration',
    'expectedScheduleRevision', coalesce(v_head.schedule_revision, 0),
    'intent', CASE WHEN v_head.currency_support_id IS NULL THEN 'ESTABLISH_CURRENT' ELSE 'VALUE_ONLY_CURRENT' END,
    'intendedEffectivePeriod', jsonb_build_object(
      'effectiveFrom', p_input ->> 'effectiveFrom',
      'effectiveTo', CASE WHEN v_current.currency_support_revision_id IS NULL THEN NULL ELSE
        to_jsonb(to_char(v_current.effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END
    ),
    'reason', p_input ->> 'reason',
    'supportedCurrencies', p_input -> 'supportedCurrencies'
  );
  IF v_current.currency_support_revision_id IS NOT NULL THEN
    v_canonical_input := v_canonical_input || jsonb_build_object(
      'expectedCurrent', jsonb_build_object(
        'effectiveFrom', to_char(v_current.effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'effectiveTo', CASE WHEN v_current.effective_to IS NULL THEN NULL ELSE
          to_char(v_current.effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
        'supportRevisionId', v_current.currency_support_revision_id::text
      )
    );
  END IF;
  SELECT set_result.payload INTO v_payload
    FROM pricing.set_tenant_currency_support_v1(p_tenant_id, v_canonical_input) AS set_result;
  RETURN QUERY SELECT jsonb_build_object(
    'actualGeneration', coalesce((v_payload ->> 'actualGeneration')::integer, 0),
    'changed', coalesce((v_payload ->> 'changed')::boolean, false),
    'outcome', CASE v_payload ->> 'outcome'
      WHEN 'APPLIED' THEN 'APPLIED'
      WHEN 'UNCHANGED' THEN 'UNCHANGED'
      WHEN 'REVISION_CONFLICT' THEN 'REVISION_CONFLICT'
      ELSE 'EFFECTIVE_TIME_CONFLICT'
    END,
    'pricingRevision', v_payload -> 'pricingRevision',
    'supportedCurrencies', coalesce(v_payload -> 'supportedCurrencies', '[]'::jsonb)
  );
END;
$function$;

REVOKE ALL ON FUNCTION pricing.set_supported_currencies(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pricing.set_supported_currencies(uuid, uuid, jsonb) TO ontos_runtime;

GRANT SELECT, INSERT ON TABLE pricing.currency_support_roots TO ontos_runtime;
GRANT SELECT, INSERT ON TABLE pricing.currency_support_value_revisions TO ontos_runtime;
GRANT SELECT, INSERT ON TABLE pricing.currency_support_schedule_revisions TO ontos_runtime;
GRANT SELECT, INSERT ON TABLE pricing.currency_support_schedule_entries TO ontos_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE pricing.currency_support_schedule_heads TO ontos_runtime;
