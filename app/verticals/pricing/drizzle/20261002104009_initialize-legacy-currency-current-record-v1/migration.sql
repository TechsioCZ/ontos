-- Keep the legacy compatibility write safe for a tenant whose canonical Currency Support root
-- does not exist yet. Scalar targets retain a known NULL value when either lookup returns no row;
-- an unassigned anonymous record cannot safely be dereferenced on that first write.
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
  v_observed_at timestamptz := pg_catalog.statement_timestamp();
  v_currency_support_id uuid;
  v_head_revision_id uuid;
  v_schedule_revision integer;
  v_current_count integer;
  v_current_revision_id uuid;
  v_current_effective_from timestamptz;
  v_current_effective_to timestamptz;
  v_current jsonb;
  v_future jsonb;
  v_expected_state jsonb;
  v_payload jsonb;
  v_canonical_input jsonb;
BEGIN
  IF p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid THEN
    RAISE EXCEPTION 'Pricing Currency Support compatibility scope mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT root.currency_support_id,
         head.currency_support_schedule_revision_id,
         head.schedule_revision
    INTO v_currency_support_id, v_head_revision_id, v_schedule_revision
    FROM pricing.currency_support_roots AS root
    LEFT JOIN pricing.currency_support_schedule_heads AS head
      ON head.tenant_id = root.tenant_id
     AND head.currency_support_id = root.currency_support_id
   WHERE root.tenant_id = p_tenant_id;
  IF v_currency_support_id IS NOT NULL THEN
    SELECT count(*)::integer,
           min(entry.currency_support_revision_id::text)::uuid,
           min(entry.effective_from),
           min(entry.effective_to),
           min(pg_catalog.jsonb_build_object(
             'effectivePeriod', pg_catalog.jsonb_build_object(
               'effectiveFrom', pg_catalog.to_char(
                 entry.effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
               ),
               'effectiveTo', CASE WHEN entry.effective_to IS NULL THEN NULL ELSE
                 pg_catalog.to_char(
                   entry.effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                 ) END
             ),
             'generation', revision.generation,
             'supportedCurrencies', revision.supported_currencies,
             'supportRevisionRef', pg_catalog.jsonb_build_object(
               'moduleId', 'commerce.pricing',
               'resourceId', revision.currency_support_revision_id::text,
               'resourceType', 'commerce.pricing.currency-support-revision',
               'supportRootId', v_currency_support_id::text,
               'tenantId', p_tenant_id::text
             )
           )::text)::jsonb
      INTO v_current_count, v_current_revision_id, v_current_effective_from,
           v_current_effective_to, v_current
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

    SELECT coalesce(pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'effectivePeriod', pg_catalog.jsonb_build_object(
                 'effectiveFrom', pg_catalog.to_char(
                   entry.effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                 ),
                 'effectiveTo', CASE WHEN entry.effective_to IS NULL THEN NULL ELSE
                   pg_catalog.to_char(
                     entry.effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                   ) END
               ),
               'generation', revision.generation,
               'supportedCurrencies', revision.supported_currencies,
               'supportRevisionRef', pg_catalog.jsonb_build_object(
                 'moduleId', 'commerce.pricing',
                 'resourceId', revision.currency_support_revision_id::text,
                 'resourceType', 'commerce.pricing.currency-support-revision',
                 'supportRootId', v_currency_support_id::text,
                 'tenantId', p_tenant_id::text
               )
             ) ORDER BY entry.effective_from, entry.currency_support_revision_id
           ), '[]'::jsonb)
      INTO v_future
      FROM pricing.currency_support_schedule_entries AS entry
      JOIN pricing.currency_support_value_revisions AS revision
        ON revision.tenant_id = entry.tenant_id
       AND revision.currency_support_id = entry.currency_support_id
       AND revision.currency_support_revision_id = entry.currency_support_revision_id
     WHERE entry.tenant_id = p_tenant_id
       AND entry.currency_support_id = v_currency_support_id
       AND entry.currency_support_schedule_revision_id = v_head_revision_id
       AND entry.effective_from > v_observed_at;
  END IF;
  v_expected_state := CASE WHEN v_currency_support_id IS NULL THEN
    pg_catalog.jsonb_build_object('state', 'ABSENT')
  ELSE pg_catalog.jsonb_build_object(
    'current', v_current,
    'future', coalesce(v_future, '[]'::jsonb),
    'observedAt', pg_catalog.to_char(
      v_observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'scheduleRevision', v_schedule_revision,
    'state', 'PRESENT',
    'supportRootRef', pg_catalog.jsonb_build_object(
      'moduleId', 'commerce.pricing',
      'resourceId', v_currency_support_id::text,
      'resourceType', 'commerce.pricing.currency-support',
      'tenantId', p_tenant_id::text
    )
  ) END;
  v_canonical_input := jsonb_build_object(
    'actionInvocationId', p_input ->> 'actionInvocationId',
    'actorPrincipalId', p_input ->> 'actorPrincipalId',
    'effectiveFrom', p_input ->> 'effectiveFrom',
    'expectedGeneration', p_input -> 'expectedGeneration',
    'expectedScheduleRevision', coalesce(v_schedule_revision, 0),
    'expectedState', v_expected_state,
    'intent', CASE WHEN v_currency_support_id IS NULL THEN 'ESTABLISH_CURRENT' ELSE 'VALUE_ONLY_CURRENT' END,
    'intendedEffectivePeriod', jsonb_build_object(
      'effectiveFrom', p_input ->> 'effectiveFrom',
      'effectiveTo', CASE WHEN v_current_revision_id IS NULL THEN NULL ELSE
        to_jsonb(to_char(v_current_effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END
    ),
    'reason', p_input ->> 'reason',
    'supportedCurrencies', p_input -> 'supportedCurrencies'
  );
  IF v_current_revision_id IS NOT NULL THEN
    v_canonical_input := v_canonical_input || jsonb_build_object(
      'expectedCurrent', jsonb_build_object(
        'effectiveFrom', to_char(v_current_effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'effectiveTo', CASE WHEN v_current_effective_to IS NULL THEN NULL ELSE
          to_char(v_current_effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
        'supportRevisionId', v_current_revision_id::text
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
