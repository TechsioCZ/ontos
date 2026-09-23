CREATE OR REPLACE FUNCTION "commerce_customer_context"."assess_market_retirement_affected_use"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_market_resource_id text,
  p_market_revision bigint,
  p_evaluated_at timestamptz
) RETURNS TABLE(result jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
DECLARE
  v_bootstrap_live jsonb;
  v_bootstrap_retained jsonb;
  v_bootstrap_digest text;
  v_bootstrap_owner_revision text;
  v_evaluated_at text;
  v_market_ref jsonb;
  v_next_boundary timestamptz;
  v_next_boundary_text text;
  v_proposal_live jsonb;
  v_proposal_retained jsonb;
  v_proposal_digest text;
  v_proposal_owner_revision text;
  v_source_evidence jsonb;
  v_without_digest jsonb;
BEGIN
  PERFORM assert_customer_commerce_policy_scope(p_tenant_id, p_legal_entity_id);
  IF p_market_resource_id IS NULL OR p_market_resource_id <> btrim(p_market_resource_id)
     OR length(p_market_resource_id) NOT BETWEEN 1 AND 1000
     OR p_market_revision IS NULL OR p_market_revision NOT BETWEEN 1 AND 2147483647
     OR p_evaluated_at IS NULL OR p_evaluated_at > statement_timestamp()
  THEN
    RAISE EXCEPTION 'invalid Market affected-use assessment input'
      USING ERRCODE = '22023', CONSTRAINT = 'market_retirement_reservation_invalid';
  END IF;

  v_evaluated_at := to_char(p_evaluated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_market_ref := jsonb_build_object(
    'moduleId', 'commerce.market-catalog',
    'resourceId', p_market_resource_id,
    'resourceType', 'commerce.market-catalog.market',
    'tenantId', p_tenant_id::text
  );

  SELECT coalesce(jsonb_agg(reference ORDER BY reference->>'ownerResourceRevision', reference->'ownerResourceRef'->>'resourceId'), '[]'::jsonb)
    INTO v_bootstrap_live
    FROM (
      SELECT jsonb_build_object(
        'kind', 'BOOTSTRAP_DEFAULT',
        'marketRef', v_market_ref,
        'marketRevision', p_market_revision,
        'ownerResourceRef', jsonb_build_object(
          'moduleId', 'commerce.customer-context',
          'resourceId', policy_revision_id::text,
          'resourceType', 'commerce.customer-context.market-bootstrap-policy',
          'tenantId', p_tenant_id::text
        ),
        'ownerResourceRevision', policy_revision_id::text
      ) AS reference
      FROM market_bootstrap_policy_revisions
      WHERE tenant_id = p_tenant_id
        AND legal_entity_id = p_legal_entity_id
        AND default_commerce_market_id = p_market_resource_id
        AND lifecycle IN ('ACTIVE', 'SCHEDULED')
        AND coalesce(applicable_to, effective_to, 'infinity'::timestamptz) > p_evaluated_at
    ) AS reference_rows;

  SELECT coalesce(jsonb_agg(reference ORDER BY reference->>'ownerResourceRevision', reference->'ownerResourceRef'->>'resourceId'), '[]'::jsonb)
    INTO v_bootstrap_retained
    FROM (
      SELECT jsonb_build_object(
        'kind', 'RETAINED_HISTORY',
        'marketRef', v_market_ref,
        'marketRevision', p_market_revision,
        'ownerResourceRef', jsonb_build_object(
          'moduleId', 'commerce.customer-context',
          'resourceId', policy_revision_id::text,
          'resourceType', 'commerce.customer-context.market-bootstrap-policy',
          'tenantId', p_tenant_id::text
        ),
        'ownerResourceRevision', policy_revision_id::text
      ) AS reference
      FROM market_bootstrap_policy_revisions
      WHERE tenant_id = p_tenant_id
        AND legal_entity_id = p_legal_entity_id
        AND default_commerce_market_id = p_market_resource_id
        AND (lifecycle = 'RETIRED' OR coalesce(applicable_to, effective_to) <= p_evaluated_at)
    ) AS reference_rows;

  SELECT coalesce(jsonb_agg(reference ORDER BY reference->>'ownerResourceRevision', reference->'ownerResourceRef'->>'resourceId'), '[]'::jsonb)
    INTO v_proposal_live
    FROM (
      SELECT jsonb_build_object(
        'kind', 'CURRENT_PROPOSAL',
        'marketRef', v_market_ref,
        'marketRevision', p_market_revision,
        'ownerResourceRef', jsonb_build_object(
          'moduleId', 'commerce.customer-context',
          'resourceId', proposal_revision_resource_id,
          'resourceType', 'commerce.customer-context.purchase-proposal-revision',
          'tenantId', p_tenant_id::text
        ),
        'ownerResourceRevision', revision::text
      ) AS reference
      FROM purchase_proposal_revisions
      WHERE tenant_id = p_tenant_id
        AND legal_entity_id = p_legal_entity_id
        AND proposal_snapshot->'context'->>'marketId' = p_market_resource_id
        AND state = 'CURRENT'
        AND expires_at > p_evaluated_at
    ) AS reference_rows;

  SELECT coalesce(jsonb_agg(reference ORDER BY reference->>'ownerResourceRevision', reference->'ownerResourceRef'->>'resourceId'), '[]'::jsonb)
    INTO v_proposal_retained
    FROM (
      SELECT jsonb_build_object(
        'kind', 'RETAINED_HISTORY',
        'marketRef', v_market_ref,
        'marketRevision', p_market_revision,
        'ownerResourceRef', jsonb_build_object(
          'moduleId', 'commerce.customer-context',
          'resourceId', proposal_revision_resource_id,
          'resourceType', 'commerce.customer-context.purchase-proposal-revision',
          'tenantId', p_tenant_id::text
        ),
        'ownerResourceRevision', revision::text
      ) AS reference
      FROM purchase_proposal_revisions
      WHERE tenant_id = p_tenant_id
        AND legal_entity_id = p_legal_entity_id
        AND proposal_snapshot->'context'->>'marketId' = p_market_resource_id
        AND (state <> 'CURRENT' OR expires_at <= p_evaluated_at)
    ) AS reference_rows;

  SELECT min(boundary)
    INTO v_next_boundary
    FROM (
      SELECT applicable_from AS boundary
        FROM market_bootstrap_policy_revisions
       WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
         AND default_commerce_market_id = p_market_resource_id AND applicable_from > p_evaluated_at
      UNION ALL
      SELECT applicable_to
        FROM market_bootstrap_policy_revisions
       WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
         AND default_commerce_market_id = p_market_resource_id AND applicable_to > p_evaluated_at
      UNION ALL
      SELECT effective_from
        FROM market_bootstrap_policy_revisions
       WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
         AND default_commerce_market_id = p_market_resource_id AND effective_from > p_evaluated_at
      UNION ALL
      SELECT effective_to
        FROM market_bootstrap_policy_revisions
       WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
         AND default_commerce_market_id = p_market_resource_id AND effective_to > p_evaluated_at
      UNION ALL
      SELECT expires_at
        FROM purchase_proposal_revisions
       WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
         AND proposal_snapshot->'context'->>'marketId' = p_market_resource_id AND expires_at > p_evaluated_at
    ) AS boundaries;
  v_next_boundary_text := CASE WHEN v_next_boundary IS NULL THEN NULL
    ELSE to_char(v_next_boundary AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END;

  v_bootstrap_digest := encode(sha256(convert_to((v_bootstrap_live || v_bootstrap_retained)::text, 'UTF8')), 'hex');
  v_proposal_digest := encode(sha256(convert_to((v_proposal_live || v_proposal_retained)::text, 'UTF8')), 'hex');
  v_bootstrap_owner_revision := format('market-bootstrap:%s', v_bootstrap_digest);
  v_proposal_owner_revision := format('purchase-proposals:%s', v_proposal_digest);
  v_source_evidence := jsonb_build_array(
    jsonb_build_object(
      'completenessEvidence', jsonb_strip_nulls(jsonb_build_object(
        'nextApplicabilityBoundary', v_next_boundary_text,
        'observedAt', v_evaluated_at,
        'ownerRevision', v_bootstrap_owner_revision,
        'scope', jsonb_build_object(
          'kind', 'EXACT_PREDICATE',
          'predicateRef', format('commerce.customer-context.market-bootstrap:%s:%s:%s', p_tenant_id, p_legal_entity_id, p_market_resource_id)
        )
      )),
      'currentness', 'CURRENT',
      'digest', v_bootstrap_digest,
      'generation', v_bootstrap_owner_revision,
      'ownerRevision', v_bootstrap_owner_revision,
      'sourceId', 'commerce.customer-context.market-bootstrap-policy'
    ),
    jsonb_build_object(
      'completenessEvidence', jsonb_strip_nulls(jsonb_build_object(
        'nextApplicabilityBoundary', v_next_boundary_text,
        'observedAt', v_evaluated_at,
        'ownerRevision', v_proposal_owner_revision,
        'scope', jsonb_build_object(
          'kind', 'EXACT_PREDICATE',
          'predicateRef', format('commerce.customer-context.purchase-proposals:%s:%s:%s', p_tenant_id, p_legal_entity_id, p_market_resource_id)
        )
      )),
      'currentness', 'CURRENT',
      'digest', v_proposal_digest,
      'generation', v_proposal_owner_revision,
      'ownerRevision', v_proposal_owner_revision,
      'sourceId', 'commerce.customer-context.purchase-proposals'
    )
  );

  v_without_digest := jsonb_strip_nulls(jsonb_build_object(
    'evaluatedAt', v_evaluated_at,
    'liveBlockingReferences', jsonb_build_object(
      'bootstrapDefaults', v_bootstrap_live,
      'currentProposals', v_proposal_live
    ),
    'marketRef', v_market_ref,
    'marketRevision', p_market_revision,
    'nextApplicabilityBoundary', v_next_boundary_text,
    'observedAt', v_evaluated_at,
    'outcome', 'VERIFIED',
    'retainedHistoryReferences', v_bootstrap_retained || v_proposal_retained,
    'sourceEvidence', v_source_evidence,
    'tenantId', p_tenant_id::text
  ));
  RETURN QUERY SELECT v_without_digest || jsonb_build_object(
    'assessmentDigest', encode(sha256(convert_to(v_without_digest::text, 'UTF8')), 'hex')
  );
END
$routine$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."assess_market_retirement_affected_use"(uuid, uuid, text, bigint, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."assess_market_retirement_affected_use"(uuid, uuid, text, bigint, timestamptz) TO "ontos_runtime";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "commerce_customer_context"."canonical_market_retirement_json"(
  p_value jsonb
) RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $canonical$
DECLARE
  v_result text;
BEGIN
  CASE jsonb_typeof(p_value)
    WHEN 'object' THEN
      SELECT '{' || coalesce(string_agg(
        to_jsonb(entry.key)::text || ':' || canonical_market_retirement_json(entry.value),
        ',' ORDER BY entry.key
      ), '') || '}'
      INTO v_result
      FROM jsonb_each(p_value) AS entry;
    WHEN 'array' THEN
      SELECT '[' || coalesce(string_agg(
        canonical_market_retirement_json(entry.value),
        ',' ORDER BY entry.ordinality
      ), '') || ']'
      INTO v_result
      FROM jsonb_array_elements(p_value) WITH ORDINALITY AS entry(value, ordinality);
    WHEN 'null' THEN v_result := 'null';
    WHEN 'boolean' THEN v_result := p_value::text;
    WHEN 'number' THEN v_result := p_value::text;
    WHEN 'string' THEN v_result := p_value::text;
    ELSE RAISE EXCEPTION 'unsupported Market retirement canonical JSON value' USING ERRCODE = '22023';
  END CASE;
  RETURN v_result;
END
$canonical$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."canonical_market_retirement_json"(jsonb) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "commerce_customer_context"."reserve_market_retirement"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_input jsonb
) RETURNS TABLE(result jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
DECLARE
  v_action_invocation_id uuid;
  v_actor_principal_id uuid;
  v_assessment jsonb;
  v_assessment_digest text;
  v_composition_evidence jsonb;
  v_composition_module text;
  v_composition_observed_at text;
  v_composition_revision text;
  v_composition_valid_until text;
  v_current_local_evidence jsonb;
  v_digest_input jsonb;
  v_evaluated_at timestamptz;
  v_existing market_retirement_reservations%ROWTYPE;
  v_market_resource_id text;
  v_market_revision integer;
  v_operation text;
  v_reason text;
  v_reservation_token uuid;
  v_reservation_version integer;
  v_sorted_source_evidence jsonb;
  v_source_evidence jsonb;
  v_supplied_local_evidence jsonb;
  v_expected_assessment_digest text;
BEGIN
  PERFORM assert_customer_commerce_policy_scope(p_tenant_id, p_legal_entity_id);
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid Market retirement reservation input'
      USING ERRCODE = '22023', CONSTRAINT = 'market_retirement_reservation_invalid';
  END IF;
  BEGIN
    v_action_invocation_id := (p_input->>'actionInvocationId')::uuid;
    v_actor_principal_id := (p_input->>'actorPrincipalId')::uuid;
    v_market_revision := (p_input->>'marketRevision')::integer;
    v_reservation_token := nullif(p_input->>'reservationToken', '')::uuid;
    v_reservation_version := nullif(p_input->>'reservationVersion', '')::integer;
    v_evaluated_at := nullif(p_input->>'evaluatedAt', '')::timestamptz;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN
    RAISE EXCEPTION 'invalid Market retirement reservation input'
      USING ERRCODE = '22023', CONSTRAINT = 'market_retirement_reservation_invalid';
  END;
  v_operation := p_input->>'operation';
  v_reason := nullif(btrim(p_input->>'reason'), '');
  v_market_resource_id := p_input->'marketRef'->>'resourceId';
  v_assessment_digest := p_input->>'assessmentDigest';
  v_source_evidence := p_input->'sourceEvidence';

  IF v_action_invocation_id IS NULL OR v_actor_principal_id IS NULL
     OR v_operation NOT IN ('RESERVE', 'COMMIT', 'RELEASE')
     OR v_reason IS NULL OR length(v_reason) > 500
     OR v_market_resource_id IS NULL OR v_market_resource_id <> btrim(v_market_resource_id)
     OR length(v_market_resource_id) NOT BETWEEN 1 AND 1000
     OR v_market_revision IS NULL OR v_market_revision < 1
     OR p_input->>'tenantId' IS DISTINCT FROM p_tenant_id::text
     OR p_input->'marketRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
     OR p_input->'marketRef'->>'moduleId' IS DISTINCT FROM 'commerce.market-catalog'
     OR p_input->'marketRef'->>'resourceType' IS DISTINCT FROM 'commerce.market-catalog.market'
  THEN
    RAISE EXCEPTION 'invalid Market retirement reservation input'
      USING ERRCODE = '22023', CONSTRAINT = 'market_retirement_reservation_invalid';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text || ':' || p_legal_entity_id::text || ':market-retirement:' || v_market_resource_id,
    0
  ));

  IF v_operation = 'RESERVE' THEN
    IF v_reservation_token IS NOT NULL OR v_reservation_version IS NOT NULL
       OR v_evaluated_at IS NULL OR v_evaluated_at > statement_timestamp()
       OR v_assessment_digest IS NULL OR v_assessment_digest !~ '^[0-9a-f]{64}$'
       OR jsonb_typeof(v_source_evidence) IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_source_evidence) <> 4
       OR (SELECT count(*) FROM jsonb_array_elements(v_source_evidence))
          <> (SELECT count(DISTINCT item->>'sourceId') FROM jsonb_array_elements(v_source_evidence) AS evidence(item))
       OR EXISTS (
         SELECT 1
         FROM (VALUES
           ('commerce.customer-context.market-bootstrap-policy'),
           ('commerce.customer-context.purchase-proposals'),
           ('application-composition:commerce.cart:UNIMPLEMENTED'),
           ('application-composition:commerce.order:UNIMPLEMENTED')
         ) AS required(source_id)
         WHERE (SELECT count(*) FROM jsonb_array_elements(v_source_evidence) AS evidence(item)
                WHERE item->>'sourceId' = required.source_id) <> 1
       )
    THEN
      RAISE EXCEPTION 'invalid Market retirement reservation input'
        USING ERRCODE = '22023', CONSTRAINT = 'market_retirement_reservation_invalid';
    END IF;

    BEGIN
      IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_source_evidence) AS evidence(item)
        WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
           OR item->>'currentness' IS DISTINCT FROM 'CURRENT'
           OR item->>'ownerRevision' IS NULL
           OR item->>'ownerRevision' IS DISTINCT FROM item->'completenessEvidence'->>'ownerRevision'
           OR item->>'generation' IS DISTINCT FROM item->>'ownerRevision'
           OR item->>'digest' !~ '^[0-9a-f]{64}$'
           OR (item->'completenessEvidence'->>'observedAt')::timestamptz > v_evaluated_at
           OR (
             item->'completenessEvidence' ? 'nextApplicabilityBoundary'
             AND (item->'completenessEvidence'->>'nextApplicabilityBoundary')::timestamptz <= statement_timestamp()
           )
      ) THEN
        RAISE EXCEPTION 'Market retirement source evidence is stale or internally inconsistent'
          USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_conflict';
      END IF;
    EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
      RAISE EXCEPTION 'Market retirement source evidence timestamps are invalid'
        USING ERRCODE = '22023', CONSTRAINT = 'market_retirement_reservation_invalid';
    END;

    FOR v_composition_module IN SELECT unnest(ARRAY['commerce.cart', 'commerce.order']) LOOP
      SELECT item INTO v_composition_evidence
      FROM jsonb_array_elements(v_source_evidence) AS evidence(item)
      WHERE item->>'sourceId' = format('application-composition:%s:UNIMPLEMENTED', v_composition_module);
      IF v_composition_evidence->'completenessEvidence'->>'nextApplicabilityBoundary' IS NULL
         OR v_composition_evidence->'completenessEvidence'->'scope'->>'kind' IS DISTINCT FROM 'SAFELY_BROADER_SCOPE'
         OR v_composition_evidence->'completenessEvidence'->'scope'->>'predicateRef'
            IS DISTINCT FROM format('application-composition:module:%s:absent', v_composition_module)
         OR v_composition_evidence->'completenessEvidence'->'scope'->>'declaredScopeRef'
            IS DISTINCT FROM format('application-composition:%s', v_composition_evidence->>'ownerRevision')
         OR v_composition_evidence->>'digest' IS DISTINCT FROM encode(sha256(
           convert_to(v_composition_evidence->>'ownerRevision', 'UTF8') || decode('00', 'hex') ||
           convert_to(v_composition_module, 'UTF8') || decode('00', 'hex') ||
           convert_to('UNIMPLEMENTED', 'UTF8')
         ), 'hex')
      THEN
        RAISE EXCEPTION 'Application Composition absence proof is missing or substituted'
          USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_conflict';
      END IF;
      IF v_composition_revision IS NULL THEN
        v_composition_revision := v_composition_evidence->>'ownerRevision';
        v_composition_observed_at := v_composition_evidence->'completenessEvidence'->>'observedAt';
        v_composition_valid_until := v_composition_evidence->'completenessEvidence'->>'nextApplicabilityBoundary';
      ELSIF v_composition_evidence->>'ownerRevision' IS DISTINCT FROM v_composition_revision
         OR v_composition_evidence->'completenessEvidence'->>'observedAt' IS DISTINCT FROM v_composition_observed_at
         OR v_composition_evidence->'completenessEvidence'->>'nextApplicabilityBoundary'
            IS DISTINCT FROM v_composition_valid_until
      THEN
        RAISE EXCEPTION 'Application Composition proofs do not describe one active snapshot'
          USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_conflict';
      END IF;
    END LOOP;
    SELECT jsonb_agg(item ORDER BY item->>'sourceId')
      INTO v_source_evidence
      FROM jsonb_array_elements(v_source_evidence) AS evidence(item);

    SELECT reservation.* INTO v_existing
      FROM market_retirement_reservations AS reservation
     WHERE reservation.tenant_id = p_tenant_id
       AND reservation.legal_entity_id = p_legal_entity_id
       AND reservation.action_invocation_id = v_action_invocation_id
     FOR UPDATE;
    IF FOUND THEN
      IF v_existing.market_resource_id IS DISTINCT FROM v_market_resource_id
         OR v_existing.market_revision IS DISTINCT FROM v_market_revision
         OR v_existing.assessment_digest IS DISTINCT FROM v_assessment_digest
         OR v_existing.evaluated_at IS DISTINCT FROM v_evaluated_at
         OR v_existing.source_evidence IS DISTINCT FROM v_source_evidence
         OR v_existing.lifecycle = 'RELEASED'
      THEN
        RAISE EXCEPTION 'Market retirement reservation conflicts with existing Action evidence'
          USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_conflict';
      END IF;
    ELSE
      IF EXISTS (
        SELECT 1 FROM market_retirement_reservations AS reservation
         WHERE reservation.tenant_id = p_tenant_id
           AND reservation.legal_entity_id = p_legal_entity_id
           AND reservation.market_resource_id = v_market_resource_id
           AND reservation.lifecycle IN ('RESERVED', 'COMMITTED')
      ) THEN
        RAISE EXCEPTION 'another Market retirement reservation is active'
          USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_conflict';
      END IF;

      SELECT assessment.result INTO v_assessment
        FROM assess_market_retirement_affected_use(
          p_tenant_id, p_legal_entity_id, v_market_resource_id, v_market_revision, v_evaluated_at
        ) AS assessment;
      IF jsonb_array_length(v_assessment->'liveBlockingReferences'->'bootstrapDefaults') > 0
         OR jsonb_array_length(v_assessment->'liveBlockingReferences'->'currentProposals') > 0
      THEN
        RAISE EXCEPTION 'live Customer Context references block Market retirement'
          USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_conflict';
      END IF;
      v_current_local_evidence := v_assessment->'sourceEvidence';
      SELECT coalesce(jsonb_agg(item ORDER BY item->>'sourceId'), '[]'::jsonb)
        INTO v_supplied_local_evidence
        FROM jsonb_array_elements(v_source_evidence) AS evidence(item)
       WHERE item->>'sourceId' IN (
         'commerce.customer-context.market-bootstrap-policy',
         'commerce.customer-context.purchase-proposals'
       );
      IF v_supplied_local_evidence IS DISTINCT FROM v_current_local_evidence THEN
        RAISE EXCEPTION 'Market affected-use evidence changed before reservation'
          USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_conflict';
      END IF;

      v_sorted_source_evidence := v_source_evidence;
      v_digest_input := (v_assessment - 'assessmentDigest' - 'outcome') ||
        jsonb_build_object('sourceEvidence', v_sorted_source_evidence);
      v_expected_assessment_digest := encode(sha256(convert_to(
        canonical_market_retirement_json(v_digest_input), 'UTF8'
      )), 'hex');
      IF v_assessment_digest IS DISTINCT FROM v_expected_assessment_digest THEN
        RAISE EXCEPTION 'Market affected-use aggregate digest does not match the exact owner evidence'
          USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_conflict';
      END IF;

      INSERT INTO market_retirement_reservations (
        tenant_id, legal_entity_id, market_resource_id, market_revision, assessment_digest,
        source_evidence, evaluated_at, lifecycle, reservation_version, action_invocation_id,
        actor_principal_id, reason, recorded_at, created_at, updated_at
      ) VALUES (
        p_tenant_id, p_legal_entity_id, v_market_resource_id, v_market_revision, v_assessment_digest,
        v_source_evidence, v_evaluated_at, 'RESERVED', 1, v_action_invocation_id,
        v_actor_principal_id, v_reason, now(), now(), now()
      ) RETURNING * INTO v_existing;
    END IF;
  ELSE
    IF v_reservation_token IS NULL OR v_reservation_version IS NULL
       OR v_evaluated_at IS NOT NULL OR v_assessment_digest IS NOT NULL OR v_source_evidence IS NOT NULL
    THEN
      RAISE EXCEPTION 'invalid Market retirement completion input'
        USING ERRCODE = '22023', CONSTRAINT = 'market_retirement_reservation_invalid';
    END IF;
    SELECT reservation.* INTO v_existing
      FROM market_retirement_reservations AS reservation
     WHERE reservation.tenant_id = p_tenant_id
       AND reservation.legal_entity_id = p_legal_entity_id
       AND reservation.market_retirement_reservation_id = v_reservation_token
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Market retirement reservation was not found'
        USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_not_found';
    END IF;
    IF v_existing.market_resource_id IS DISTINCT FROM v_market_resource_id
       OR v_existing.market_revision IS DISTINCT FROM v_market_revision
    THEN
      RAISE EXCEPTION 'Market retirement reservation identity changed'
        USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_conflict';
    END IF;

    IF v_operation = 'COMMIT' THEN
      IF v_existing.lifecycle = 'RELEASED' THEN
        RAISE EXCEPTION 'released Market retirement reservation cannot be committed'
          USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_conflict';
      ELSIF v_existing.lifecycle = 'COMMITTED' THEN
        IF NOT (
          v_reservation_version = v_existing.reservation_version
          OR (v_existing.last_action_invocation_id = v_action_invocation_id
              AND v_existing.last_operation = 'COMMIT'
              AND v_reservation_version = v_existing.reservation_version - 1)
        ) THEN
          RAISE EXCEPTION 'stale Market retirement reservation version'
            USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_conflict';
        END IF;
      ELSE
        IF v_reservation_version <> v_existing.reservation_version THEN
          RAISE EXCEPTION 'stale Market retirement reservation version'
            USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_conflict';
        END IF;
        UPDATE market_retirement_reservations
           SET lifecycle = 'COMMITTED', reservation_version = reservation_version + 1,
               last_action_invocation_id = v_action_invocation_id, last_operation = 'COMMIT',
               actor_principal_id = v_actor_principal_id, reason = v_reason,
               recorded_at = now(), updated_at = now()
         WHERE market_retirement_reservation_id = v_reservation_token
        RETURNING * INTO v_existing;
      END IF;
    ELSE
      IF v_existing.lifecycle = 'COMMITTED' THEN
        RAISE EXCEPTION 'committed Market retirement reservation cannot be released'
          USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_conflict';
      ELSIF v_existing.lifecycle = 'RELEASED' THEN
        IF NOT (
          v_reservation_version = v_existing.reservation_version
          OR (v_existing.last_action_invocation_id = v_action_invocation_id
              AND v_existing.last_operation = 'RELEASE'
              AND v_reservation_version = v_existing.reservation_version - 1)
        ) THEN
          RAISE EXCEPTION 'stale Market retirement reservation version'
            USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_conflict';
        END IF;
      ELSE
        IF v_reservation_version <> v_existing.reservation_version THEN
          RAISE EXCEPTION 'stale Market retirement reservation version'
            USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_conflict';
        END IF;
        UPDATE market_retirement_reservations
           SET lifecycle = 'RELEASED', reservation_version = reservation_version + 1,
               last_action_invocation_id = v_action_invocation_id, last_operation = 'RELEASE',
               actor_principal_id = v_actor_principal_id, reason = v_reason,
               recorded_at = now(), updated_at = now()
         WHERE market_retirement_reservation_id = v_reservation_token
        RETURNING * INTO v_existing;
      END IF;
    END IF;
  END IF;

  RETURN QUERY SELECT jsonb_build_object(
    'assessmentDigest', v_existing.assessment_digest,
    'lifecycle', v_existing.lifecycle,
    'marketRef', jsonb_build_object(
      'moduleId', 'commerce.market-catalog',
      'resourceId', v_existing.market_resource_id,
      'resourceType', 'commerce.market-catalog.market',
      'tenantId', v_existing.tenant_id::text
    ),
    'marketRevision', v_existing.market_revision,
    'reservationToken', v_existing.market_retirement_reservation_id::text,
    'reservationVersion', v_existing.reservation_version,
    'tenantId', v_existing.tenant_id::text
  );
END
$routine$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."reserve_market_retirement"(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."reserve_market_retirement"(uuid, uuid, jsonb) TO "ontos_runtime";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "commerce_customer_context"."guard_market_retirement_reference"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_market_resource_id text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $guard$
BEGIN
  IF p_market_resource_id IS NULL OR btrim(p_market_resource_id) = '' THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text || ':' || p_legal_entity_id::text || ':market-retirement:' || p_market_resource_id,
    0
  ));
  IF EXISTS (
    SELECT 1 FROM market_retirement_reservations AS reservation
     WHERE reservation.tenant_id = p_tenant_id
       AND reservation.legal_entity_id = p_legal_entity_id
       AND reservation.market_resource_id = p_market_resource_id
       AND reservation.lifecycle IN ('RESERVED', 'COMMITTED')
  ) THEN
    RAISE EXCEPTION 'Market retirement is reserved; affected Customer Context references are frozen'
      USING ERRCODE = '55P03', CONSTRAINT = 'market_retirement_reservation_conflict';
  END IF;
END
$guard$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."guard_market_retirement_reference"(uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "commerce_customer_context"."guard_market_bootstrap_retirement_reference"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $guard$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM guard_market_retirement_reference(OLD.tenant_id, OLD.legal_entity_id, OLD.default_commerce_market_id);
  END IF;
  IF TG_OP <> 'DELETE' AND (
    TG_OP = 'INSERT'
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
    OR NEW.default_commerce_market_id IS DISTINCT FROM OLD.default_commerce_market_id
  ) THEN
    PERFORM guard_market_retirement_reference(NEW.tenant_id, NEW.legal_entity_id, NEW.default_commerce_market_id);
  END IF;
  RETURN coalesce(NEW, OLD);
END
$guard$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS market_bootstrap_policy_retirement_guard ON "commerce_customer_context"."market_bootstrap_policy_revisions";
CREATE TRIGGER market_bootstrap_policy_retirement_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "commerce_customer_context"."market_bootstrap_policy_revisions"
  FOR EACH ROW EXECUTE FUNCTION "commerce_customer_context"."guard_market_bootstrap_retirement_reference"();
REVOKE ALL ON FUNCTION "commerce_customer_context"."guard_market_bootstrap_retirement_reference"() FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "commerce_customer_context"."guard_market_proposal_retirement_reference"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $guard$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM guard_market_retirement_reference(
      OLD.tenant_id, OLD.legal_entity_id, OLD.proposal_snapshot->'context'->>'marketId'
    );
  END IF;
  IF TG_OP <> 'DELETE' AND (
    TG_OP = 'INSERT'
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
    OR NEW.proposal_snapshot IS DISTINCT FROM OLD.proposal_snapshot
    OR NEW.state IS DISTINCT FROM OLD.state
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
  ) THEN
    PERFORM guard_market_retirement_reference(
      NEW.tenant_id, NEW.legal_entity_id, NEW.proposal_snapshot->'context'->>'marketId'
    );
  END IF;
  RETURN coalesce(NEW, OLD);
END
$guard$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS purchase_proposal_market_retirement_guard ON "commerce_customer_context"."purchase_proposal_revisions";
CREATE TRIGGER purchase_proposal_market_retirement_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "commerce_customer_context"."purchase_proposal_revisions"
  FOR EACH ROW EXECUTE FUNCTION "commerce_customer_context"."guard_market_proposal_retirement_reference"();
REVOKE ALL ON FUNCTION "commerce_customer_context"."guard_market_proposal_retirement_reference"() FROM PUBLIC;
