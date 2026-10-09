-- #797 ZERO_FLOOR owner routines. All reads and mutations run under the caller's governed scope.
CREATE FUNCTION pricing.zero_floor_instant_v1(p_at timestamptz)
RETURNS text LANGUAGE sql STABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
RETURN to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

CREATE FUNCTION pricing.zero_floor_current_revision_v1(p_schedule jsonb, p_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_current jsonb;
  v_count integer;
BEGIN
  SELECT count(*), (jsonb_agg(value) -> 0) INTO v_count, v_current
    FROM jsonb_array_elements(p_schedule -> 'revisions') AS revision(value)
   WHERE value ->> 'scheduleState' IS DISTINCT FROM 'SUPERSEDED'
     AND (value #>> '{authorization,effectivePeriod,startsAt}')::timestamptz <= p_at
     AND (
       value #>> '{authorization,effectivePeriod,endsAt}' IS NULL
       OR p_at < (value #>> '{authorization,effectivePeriod,endsAt}')::timestamptz
     );
  IF v_count > 1 THEN
    RAISE EXCEPTION 'Competing ZERO_FLOOR Current Authorization revisions' USING ERRCODE = '23514';
  END IF;
  RETURN v_current;
END;
$function$;

CREATE FUNCTION pricing.zero_floor_governance_proof_matches_v1(
  p_tenant_id uuid, p_legal_entity_id uuid, p_authorization jsonb,
  p_proof jsonb, p_operation_at timestamptz
)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_approval jsonb;
  v_head pricing.zero_floor_set_heads%ROWTYPE;
  v_owner_revision text;
  v_predicate_ref text;
BEGIN
  v_approval := pricing.zero_floor_approval_for_v1(
    p_tenant_id, p_legal_entity_id, p_authorization, p_operation_at);
  SELECT * INTO v_head FROM pricing.zero_floor_set_heads
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id;
  IF v_approval IS NULL OR NOT FOUND THEN RETURN false; END IF;
  v_owner_revision := 'pricing:zero-floor-set:generation:' || v_head.generation::text;
  v_predicate_ref := 'pricing:zero-floor-governance-approval:v1:' ||
    pricing.zero_floor_authorization_fingerprint_v1(p_authorization);
  RETURN COALESCE(pricing.canonicalize_management_json_v1(v_approval) =
      pricing.canonicalize_management_json_v1(p_proof -> 'approvalEvidence')
    AND pricing.canonicalize_management_json_v1(p_authorization) =
      pricing.canonicalize_management_json_v1(p_proof -> 'authorization')
    AND p_proof ->> 'ownerRevision' = v_owner_revision
    AND p_proof ->> 'exactPredicateRef' = v_predicate_ref
    AND p_proof #>> '{completenessEvidence,ownerRevision}' = v_owner_revision
    AND p_proof #>> '{completenessEvidence,scope,kind}' = 'EXACT_PREDICATE'
    AND p_proof #>> '{completenessEvidence,scope,predicateRef}' = v_predicate_ref
    AND p_proof #>> '{currentness,status}' = 'CURRENT'
    AND (p_proof #>> '{currentness,evaluatedAt}')::timestamptz = p_operation_at
    AND (p_proof #>> '{currentness,observedAt}')::timestamptz >= p_operation_at
    AND (p_proof #>> '{currentness,revalidatedAt}')::timestamptz >=
      (p_proof #>> '{currentness,observedAt}')::timestamptz
    AND (p_proof #>> '{currentness,revalidatedAt}')::timestamptz <= statement_timestamp()
    AND p_proof #>> '{completenessEvidence,observedAt}' =
      p_proof #>> '{currentness,observedAt}', false);
END;
$function$;

CREATE FUNCTION pricing.zero_floor_approval_for_v1(
  p_tenant_id uuid, p_legal_entity_id uuid, p_authorization jsonb, p_at timestamptz
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_approval record;
BEGIN
  SELECT * INTO v_approval FROM pricing.zero_floor_governance_approvals
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
     AND approval_evidence_ref = p_authorization #>> '{governanceEvidence,approvalEvidenceRef}'
     AND approved_by_principal_id = p_authorization #>> '{governanceEvidence,approvedByPrincipalRef}'
     AND approved_at <= p_at AND valid_from <= p_at AND p_at < valid_until
     AND approval_evidence -> 'authorization' IS NOT NULL
     AND pricing.zero_floor_authorization_fingerprint_v1(approval_evidence -> 'authorization') =
       authorization_fingerprint
     AND pricing.canonicalize_management_json_v1(
       (approval_evidence -> 'authorization') - 'effectivePeriod' - 'authorizationRevision'
     ) = pricing.canonicalize_management_json_v1(
       p_authorization - 'effectivePeriod' - 'authorizationRevision'
     )
     AND ((approval_evidence #>> '{authorization,effectivePeriod,startsAt}')::timestamptz <=
       (p_authorization #>> '{effectivePeriod,startsAt}')::timestamptz)
     AND (
       approval_evidence #>> '{authorization,effectivePeriod,endsAt}' IS NULL
       OR (
         p_authorization #>> '{effectivePeriod,endsAt}' IS NOT NULL
         AND (p_authorization #>> '{effectivePeriod,endsAt}')::timestamptz <=
           (approval_evidence #>> '{authorization,effectivePeriod,endsAt}')::timestamptz
       )
     )
   ORDER BY approved_at DESC LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN v_approval.approval_evidence;
END;
$function$;

CREATE FUNCTION pricing.read_zero_floor_authorization_schedule_v1(
  p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb
)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE v_schedule jsonb;
BEGIN
  IF p_input ->> 'tenantId' <> p_tenant_id::text THEN
    RAISE EXCEPTION 'ZERO_FLOOR schedule Tenant mismatch' USING ERRCODE = '22023';
  END IF;
  SELECT revision.schedule INTO v_schedule
    FROM pricing.zero_floor_authorizations AS auth_root
    JOIN pricing.zero_floor_authorization_schedule_heads AS head
      ON head.tenant_id = auth_root.tenant_id
     AND head.legal_entity_id = auth_root.legal_entity_id
     AND head.zero_floor_authorization_id = auth_root.zero_floor_authorization_id
    JOIN pricing.zero_floor_authorization_revisions AS revision
      ON revision.zero_floor_authorization_revision_id = head.zero_floor_authorization_revision_id
   WHERE auth_root.tenant_id = p_tenant_id
     AND auth_root.legal_entity_id = p_legal_entity_id
     AND auth_root.authorization_ref = p_input ->> 'authorizationRef';
  IF v_schedule IS NULL THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'ZERO_FLOOR_AUTHORIZATION_SCHEDULE_ABSENT',
      'authorizationRef', p_input ->> 'authorizationRef');
  ELSE
    RETURN QUERY SELECT jsonb_build_object('outcome', 'ZERO_FLOOR_AUTHORIZATION_SCHEDULE',
      'schedule', v_schedule);
  END IF;
END;
$function$;

CREATE FUNCTION pricing.lookup_zero_floor_authorization_result_v1(
  p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb
)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_action_id text := p_input ->> 'actionInvocationId';
  v_principal_id text := p_input ->> 'actingPrincipalId';
  v_outcome jsonb;
BEGIN
  IF v_action_id IS NULL OR btrim(v_action_id) = ''
    OR v_principal_id IS NULL OR btrim(v_principal_id) = ''
    OR p_input <> jsonb_build_object(
      'actionInvocationId', v_action_id,
      'actingPrincipalId', v_principal_id
    )
  THEN
    RAISE EXCEPTION 'ZERO_FLOOR result lookup requires exact invocation and principal'
      USING ERRCODE = '22023';
  END IF;
  SELECT outcome INTO v_outcome FROM pricing.zero_floor_action_invocation_receipts
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
     AND action_invocation_id = v_action_id
     AND acting_principal_id = v_principal_id;
  IF FOUND THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'ZERO_FLOOR_AUTHORIZATION_RESULT_FOUND',
      'actionInvocationId', v_action_id, 'result', v_outcome);
  ELSE
    RETURN QUERY SELECT jsonb_build_object('outcome', 'ZERO_FLOOR_AUTHORIZATION_RESULT_ABSENT',
      'actionInvocationId', v_action_id);
  END IF;
END;
$function$;

CREATE FUNCTION pricing.read_current_zero_floor_authorization_set_v1(
  p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb
)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_query jsonb := p_input -> 'query';
  v_at timestamptz := (p_input #>> '{query,effectiveAt}')::timestamptz;
  v_now timestamptz := statement_timestamp();
  v_head pricing.zero_floor_set_heads%ROWTYPE;
  v_predicate_ref text;
  v_owner_revision text;
  v_completeness jsonb;
  v_authorizations jsonb;
  v_next_boundary timestamptz;
BEGIN
  IF v_query IS NULL OR v_at IS NULL
    OR v_query ->> 'tenantId' IS DISTINCT FROM p_tenant_id::text
    OR v_query #>> '{commercialScope,sellingLegalEntityId}' IS DISTINCT FROM p_legal_entity_id::text
    OR v_at > v_now
  THEN RAISE EXCEPTION 'ZERO_FLOOR Current-set predicate is invalid' USING ERRCODE = '22023'; END IF;
  v_predicate_ref := pricing.zero_floor_predicate_ref_v1(v_query);
  IF v_query ->> 'exactPredicateRef' IS DISTINCT FROM v_predicate_ref THEN
    RAISE EXCEPTION 'ZERO_FLOOR exact predicate reference mismatch' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_head FROM pricing.zero_floor_set_heads
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ZERO_FLOOR set authority is not initialized' USING ERRCODE = 'P0002';
  END IF;

  WITH schedules AS (
    SELECT revision.schedule FROM pricing.zero_floor_authorizations AS auth_root
      JOIN pricing.zero_floor_authorization_schedule_heads AS head
        ON head.tenant_id = auth_root.tenant_id
       AND head.legal_entity_id = auth_root.legal_entity_id
       AND head.zero_floor_authorization_id = auth_root.zero_floor_authorization_id
      JOIN pricing.zero_floor_authorization_revisions AS revision
        ON revision.zero_floor_authorization_revision_id = head.zero_floor_authorization_revision_id
     WHERE auth_root.tenant_id = p_tenant_id AND auth_root.legal_entity_id = p_legal_entity_id
  ), members AS (
    SELECT pricing.zero_floor_current_revision_v1(schedule, v_at) AS revision, schedule
      FROM schedules
  ), eligible AS (
    SELECT revision -> 'authorization' AS auth_value FROM members
     WHERE revision IS NOT NULL
       AND revision #>> '{authorization,businessScope,tenantId}' = p_tenant_id::text
       AND pricing.canonicalize_management_json_v1(revision #> '{authorization,businessScope,catalogSelection}') =
           pricing.canonicalize_management_json_v1(v_query -> 'catalogSelection')
       AND pricing.canonicalize_management_json_v1(revision #> '{authorization,businessScope,commercialScope}') =
           pricing.canonicalize_management_json_v1(v_query -> 'commercialScope')
       AND pricing.canonicalize_management_json_v1(revision #> '{authorization,businessScope,pricingBasis}') =
           pricing.canonicalize_management_json_v1(v_query -> 'pricingBasis')
       AND revision #>> '{authorization,currencyCode}' = v_query ->> 'currencyCode'
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements_text(v_query -> 'audienceRefs') AS requested(value)
          WHERE NOT (revision #> '{authorization,coveredMeaning,audienceRefs}' ? requested.value)
       )
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements_text(v_query -> 'materialRevisionRefs') AS requested(value)
          WHERE NOT (revision #> '{authorization,coveredMeaning,materialRevisionRefs}' ? requested.value)
       )
       AND pricing.zero_floor_approval_for_v1(p_tenant_id, p_legal_entity_id,
         revision -> 'authorization', v_at) IS NOT NULL
  ), boundaries AS (
    SELECT (item.value #>> '{authorization,effectivePeriod,startsAt}')::timestamptz AS boundary
      FROM schedules, LATERAL jsonb_array_elements(schedule -> 'revisions') AS item(value)
     WHERE item.value ->> 'scheduleState' IS DISTINCT FROM 'SUPERSEDED'
       AND (item.value #>> '{authorization,effectivePeriod,startsAt}')::timestamptz > v_at
    UNION ALL
    SELECT (item.value #>> '{authorization,effectivePeriod,endsAt}')::timestamptz
      FROM schedules, LATERAL jsonb_array_elements(schedule -> 'revisions') AS item(value)
     WHERE item.value ->> 'scheduleState' IS DISTINCT FROM 'SUPERSEDED'
       AND item.value #>> '{authorization,effectivePeriod,endsAt}' IS NOT NULL
       AND (item.value #>> '{authorization,effectivePeriod,endsAt}')::timestamptz > v_at
    UNION ALL
    SELECT valid_from FROM pricing.zero_floor_governance_approvals
     WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
       AND valid_from > v_at
    UNION ALL
    SELECT valid_until FROM pricing.zero_floor_governance_approvals
     WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
       AND valid_until > v_at
  )
    SELECT COALESCE((SELECT jsonb_agg(auth_value ORDER BY auth_value ->> 'authorizationRef')
    FROM eligible), '[]'::jsonb), (SELECT min(boundary) FROM boundaries)
    INTO v_authorizations, v_next_boundary;
  IF jsonb_array_length(v_authorizations) > 500 THEN
    RAISE EXCEPTION 'ZERO_FLOOR Current set exceeds bounded result' USING ERRCODE = '54000';
  END IF;
  v_owner_revision := 'pricing:zero-floor-set:generation:' || v_head.generation::text;
  v_completeness := jsonb_build_object('observedAt', pricing.zero_floor_instant_v1(v_now),
    'ownerRevision', v_owner_revision,
    'scope', jsonb_build_object('kind', 'EXACT_PREDICATE', 'predicateRef', v_predicate_ref));
  IF v_next_boundary IS NOT NULL THEN
    v_completeness := v_completeness || jsonb_build_object('nextApplicabilityBoundary',
      pricing.zero_floor_instant_v1(v_next_boundary));
  END IF;
  RETURN QUERY SELECT jsonb_build_object(
    'outcome', 'ZERO_FLOOR_AUTHORIZATION_SET_CURRENT',
    'authority', jsonb_build_object('generation', v_head.generation,
      'observedAt', pricing.zero_floor_instant_v1(v_now),
      'ownerRevision', v_owner_revision,
      'ownerRootRef', 'pricing:zero-floor-set:' || v_head.zero_floor_set_root_id::text,
      'predicateRef', v_predicate_ref,
      'verificationRef', 'pricing:zero-floor-set:' || v_head.zero_floor_set_root_id::text ||
        ':generation:' || v_head.generation::text || ':' || v_predicate_ref),
    'authorizationSet', jsonb_build_object('authorizations', v_authorizations,
      'completenessEvidence', v_completeness,
      'currentness', jsonb_build_object('evaluatedAt', pricing.zero_floor_instant_v1(v_at),
        'observedAt', pricing.zero_floor_instant_v1(v_now),
        'revalidatedAt', pricing.zero_floor_instant_v1(v_now), 'status', 'CURRENT'),
      'exactPredicateRef', v_predicate_ref, 'ownerRevision', v_owner_revision, 'query', v_query));
END;
$function$;

CREATE FUNCTION pricing.verify_zero_floor_authorization_set_generation_v1(
  p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb
)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_head pricing.zero_floor_set_heads%ROWTYPE;
  v_through timestamptz := (p_input ->> 'through')::timestamptz;
  v_observed_at timestamptz := (p_input ->> 'observedAt')::timestamptz;
  v_query jsonb := p_input -> 'query';
  v_next_boundary timestamptz;
  v_current boolean := false;
BEGIN
  IF v_query IS NULL OR v_through IS NULL OR v_observed_at IS NULL
    OR v_query ->> 'tenantId' IS DISTINCT FROM p_tenant_id::text
    OR v_query #>> '{commercialScope,sellingLegalEntityId}' IS DISTINCT FROM p_legal_entity_id::text
    OR v_query ->> 'exactPredicateRef' IS DISTINCT FROM pricing.zero_floor_predicate_ref_v1(v_query)
    OR v_through > statement_timestamp() OR v_through < v_observed_at
  THEN RAISE EXCEPTION 'ZERO_FLOOR generation predicate is invalid' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_head FROM pricing.zero_floor_set_heads
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id;
  IF FOUND THEN
    SELECT min(boundary) INTO v_next_boundary FROM (
      SELECT (item.value #>> '{authorization,effectivePeriod,startsAt}')::timestamptz AS boundary
        FROM pricing.zero_floor_authorizations AS auth_root
        JOIN pricing.zero_floor_authorization_schedule_heads AS head
          ON head.tenant_id = auth_root.tenant_id
         AND head.legal_entity_id = auth_root.legal_entity_id
         AND head.zero_floor_authorization_id = auth_root.zero_floor_authorization_id
        JOIN pricing.zero_floor_authorization_revisions AS revision
          ON revision.zero_floor_authorization_revision_id = head.zero_floor_authorization_revision_id
        CROSS JOIN LATERAL jsonb_array_elements(revision.schedule -> 'revisions') AS item(value)
       WHERE auth_root.tenant_id = p_tenant_id AND auth_root.legal_entity_id = p_legal_entity_id
         AND item.value ->> 'scheduleState' IS DISTINCT FROM 'SUPERSEDED'
         AND (item.value #>> '{authorization,effectivePeriod,startsAt}')::timestamptz >
           (v_query ->> 'effectiveAt')::timestamptz
      UNION ALL
      SELECT (item.value #>> '{authorization,effectivePeriod,endsAt}')::timestamptz
        FROM pricing.zero_floor_authorizations AS auth_root
        JOIN pricing.zero_floor_authorization_schedule_heads AS head
          ON head.tenant_id = auth_root.tenant_id
         AND head.legal_entity_id = auth_root.legal_entity_id
         AND head.zero_floor_authorization_id = auth_root.zero_floor_authorization_id
        JOIN pricing.zero_floor_authorization_revisions AS revision
          ON revision.zero_floor_authorization_revision_id = head.zero_floor_authorization_revision_id
        CROSS JOIN LATERAL jsonb_array_elements(revision.schedule -> 'revisions') AS item(value)
       WHERE auth_root.tenant_id = p_tenant_id AND auth_root.legal_entity_id = p_legal_entity_id
         AND item.value ->> 'scheduleState' IS DISTINCT FROM 'SUPERSEDED'
         AND item.value #>> '{authorization,effectivePeriod,endsAt}' IS NOT NULL
         AND (item.value #>> '{authorization,effectivePeriod,endsAt}')::timestamptz >
           (v_query ->> 'effectiveAt')::timestamptz
      UNION ALL
      SELECT valid_from FROM pricing.zero_floor_governance_approvals
       WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
         AND valid_from > (v_query ->> 'effectiveAt')::timestamptz
      UNION ALL
      SELECT valid_until FROM pricing.zero_floor_governance_approvals
       WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
         AND valid_until > (v_query ->> 'effectiveAt')::timestamptz
    ) AS boundaries;
    v_current := v_head.generation = (p_input ->> 'generation')::integer
      AND p_input ->> 'ownerRevision' = 'pricing:zero-floor-set:generation:' || v_head.generation::text
      AND p_input ->> 'ownerRootRef' = 'pricing:zero-floor-set:' || v_head.zero_floor_set_root_id::text
      AND (v_query ->> 'effectiveAt')::timestamptz <= v_observed_at
      AND v_observed_at <= v_through
      AND (v_next_boundary IS NULL OR v_through < v_next_boundary);
  END IF;
  IF v_current THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'ZERO_FLOOR_AUTHORIZATION_SET_GENERATION_CURRENT',
      'generation', v_head.generation,
      'ownerRevision', 'pricing:zero-floor-set:generation:' || v_head.generation::text,
      'ownerRootRef', 'pricing:zero-floor-set:' || v_head.zero_floor_set_root_id::text,
      'verifiedThrough', pricing.zero_floor_instant_v1(v_through));
  ELSE
    RETURN QUERY SELECT jsonb_build_object('outcome', 'ZERO_FLOOR_AUTHORIZATION_SET_GENERATION_CHANGED',
      'verifiedThrough', pricing.zero_floor_instant_v1(v_through));
  END IF;
END;
$function$;

CREATE FUNCTION pricing.read_current_zero_floor_authorization_governance_proof_v1(
  p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb
)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_authorization jsonb := p_input -> 'authorization';
  v_at timestamptz := (p_input ->> 'effectiveAt')::timestamptz;
  v_now timestamptz := statement_timestamp();
  v_approval jsonb;
  v_head pricing.zero_floor_set_heads%ROWTYPE;
  v_owner_revision text;
  v_predicate_ref text;
BEGIN
  IF v_authorization IS NULL OR v_at IS NULL
    OR v_authorization #>> '{businessScope,tenantId}' IS DISTINCT FROM p_tenant_id::text
    OR v_authorization #>> '{businessScope,commercialScope,sellingLegalEntityId}' IS DISTINCT FROM p_legal_entity_id::text
    OR v_at > v_now
  THEN RAISE EXCEPTION 'ZERO_FLOOR governance proof scope is invalid' USING ERRCODE = '22023'; END IF;
  v_approval := pricing.zero_floor_approval_for_v1(p_tenant_id, p_legal_entity_id, v_authorization, v_at);
  IF v_approval IS NULL
    OR (v_approval #>> '{validityPeriod,endsAt}')::timestamptz <= v_now
  THEN RAISE EXCEPTION 'ZERO_FLOOR governance approval is absent or stale' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO v_head FROM pricing.zero_floor_set_heads
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ZERO_FLOOR set authority is not initialized' USING ERRCODE = 'P0002';
  END IF;
  v_owner_revision := 'pricing:zero-floor-set:generation:' || v_head.generation::text;
  v_predicate_ref := 'pricing:zero-floor-governance-approval:v1:' ||
    pricing.zero_floor_authorization_fingerprint_v1(v_authorization);
  RETURN QUERY SELECT jsonb_build_object('outcome', 'ZERO_FLOOR_AUTHORIZATION_GOVERNANCE_PROOF_CURRENT',
    'governanceProof', jsonb_build_object('approvalEvidence', v_approval, 'authorization', v_authorization,
      'completenessEvidence', jsonb_build_object('observedAt', pricing.zero_floor_instant_v1(v_now),
        'ownerRevision', v_owner_revision,
        'nextApplicabilityBoundary', v_approval #> '{validityPeriod,endsAt}',
        'scope', jsonb_build_object('kind', 'EXACT_PREDICATE', 'predicateRef', v_predicate_ref)),
      'currentness', jsonb_build_object('evaluatedAt', pricing.zero_floor_instant_v1(v_at),
        'observedAt', pricing.zero_floor_instant_v1(v_now),
        'revalidatedAt', pricing.zero_floor_instant_v1(v_now), 'status', 'CURRENT'),
      'exactPredicateRef', v_predicate_ref, 'ownerRevision', v_owner_revision));
END;
$function$;

CREATE FUNCTION pricing.create_zero_floor_authorization_v1(
  p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb
)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_authorization jsonb := p_input -> 'authorization';
  v_ref text := p_input #>> '{authorization,authorizationRef}';
  v_action_id text := p_input ->> 'actionInvocationId';
  v_at timestamptz := (p_input ->> 'trustedOperationAt')::timestamptz;
  v_fingerprint text := pricing.management_fingerprint_v1(
    p_input - 'trustedOperationAt' - 'requestCorrelationId' - 'governanceProof');
  v_receipt pricing.zero_floor_action_invocation_receipts%ROWTYPE;
  v_head pricing.zero_floor_set_heads%ROWTYPE;
  v_root pricing.zero_floor_authorizations%ROWTYPE;
  v_schedule jsonb;
  v_revision jsonb;
  v_revision_id uuid;
  v_result jsonb;
  v_generation integer;
BEGIN
  IF v_authorization IS NULL OR v_ref IS NULL OR v_action_id IS NULL
    OR p_input ->> 'actingPrincipalId' IS NULL
    OR p_input ->> 'expectedSetGeneration' IS NULL OR v_at IS NULL
    OR v_authorization #>> '{businessScope,tenantId}' IS DISTINCT FROM p_tenant_id::text
    OR v_authorization #>> '{businessScope,commercialScope,sellingLegalEntityId}' IS DISTINCT FROM p_legal_entity_id::text
    OR v_at > statement_timestamp()
  THEN RAISE EXCEPTION 'ZERO_FLOOR CREATE scope or time is invalid' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':zero-floor-action:' || v_action_id, 0));
  SELECT * INTO v_receipt FROM pricing.zero_floor_action_invocation_receipts
   WHERE tenant_id = p_tenant_id AND action_invocation_id = v_action_id;
  IF FOUND THEN
    IF v_receipt.legal_entity_id = p_legal_entity_id
      AND v_receipt.acting_principal_id = p_input ->> 'actingPrincipalId'
      AND v_receipt.command_fingerprint = v_fingerprint THEN
      RETURN QUERY SELECT v_receipt.outcome;
    ELSE
      RETURN QUERY SELECT jsonb_build_object('outcome', 'ZERO_FLOOR_AUTHORIZATION_CONFLICT',
        'authorizationRef', v_ref, 'reason', 'IDEMPOTENCY_CONFLICT');
    END IF;
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || p_legal_entity_id::text ||
    ':zero-floor-ref:' || v_ref, 0));
  PERFORM pricing.ensure_zero_floor_set_v1(p_tenant_id, p_legal_entity_id, v_action_id || ':initialize');
  SELECT * INTO STRICT v_head FROM pricing.zero_floor_set_heads
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id FOR UPDATE;
  IF v_head.generation <> (p_input ->> 'expectedSetGeneration')::integer THEN
    v_result := jsonb_build_object('outcome', 'ZERO_FLOOR_AUTHORIZATION_CONFLICT',
      'authorizationRef', v_ref, 'reason', 'EXPECTED_GENERATION_STALE');
  ELSIF pricing.zero_floor_governance_proof_matches_v1(
    p_tenant_id, p_legal_entity_id, v_authorization, p_input -> 'governanceProof', v_at) IS NOT TRUE THEN
    RAISE EXCEPTION 'ZERO_FLOOR CREATE lacks current persisted governance approval' USING ERRCODE = 'P0002';
  END IF;
  IF v_result IS NULL THEN
    SELECT * INTO v_root FROM pricing.zero_floor_authorizations
     WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
       AND authorization_ref = v_ref;
    IF FOUND THEN
      SELECT revision.schedule INTO v_schedule
        FROM pricing.zero_floor_authorization_schedule_heads AS head
        JOIN pricing.zero_floor_authorization_revisions AS revision
          ON revision.zero_floor_authorization_revision_id = head.zero_floor_authorization_revision_id
       WHERE head.tenant_id = p_tenant_id AND head.legal_entity_id = p_legal_entity_id
         AND head.zero_floor_authorization_id = v_root.zero_floor_authorization_id;
      v_revision := v_schedule #> '{revisions,0}';
      IF jsonb_array_length(v_schedule -> 'revisions') = 1
        AND pricing.canonicalize_management_json_v1(v_revision -> 'authorization') =
          pricing.canonicalize_management_json_v1(v_authorization)
      THEN
        v_result := jsonb_build_object('outcome', 'ZERO_FLOOR_AUTHORIZATION_REUSED',
          'revision', v_revision, 'setGeneration', v_head.generation);
      ELSE
        v_result := jsonb_build_object('outcome', 'ZERO_FLOOR_AUTHORIZATION_CONFLICT',
          'authorizationRef', v_ref, 'reason', 'AUTHORIZATION_REF_ALREADY_BOUND');
      END IF;
    ELSE
      v_revision := jsonb_build_object('authorization', v_authorization,
        'lineage', jsonb_build_object('rootAuthorizationRef', v_ref, 'transition', 'CREATED'),
        'recordedAt', pricing.zero_floor_instant_v1(v_at), 'revisionNumber', 1, 'scheduleRevision', 1,
        'scheduleState', 'SCHEDULED');
      v_schedule := jsonb_build_object('authorizationRef', v_ref,
        'revisions', jsonb_build_array(v_revision), 'scheduleRevision', 1,
        'tenantId', p_tenant_id::text);
      INSERT INTO pricing.zero_floor_authorizations (
        tenant_id, legal_entity_id, authorization_ref, created_by_action_invocation_id
      ) VALUES (p_tenant_id, p_legal_entity_id, v_ref, v_action_id)
      RETURNING * INTO v_root;
      INSERT INTO pricing.zero_floor_authorization_revisions (
        tenant_id, legal_entity_id, zero_floor_authorization_id, schedule_revision,
        schedule, action_invocation_id, command_fingerprint, acting_principal_id, reason
      ) VALUES (p_tenant_id, p_legal_entity_id, v_root.zero_floor_authorization_id, 1,
        v_schedule, v_action_id, v_fingerprint, p_input ->> 'actingPrincipalId', p_input ->> 'reason')
      RETURNING zero_floor_authorization_revision_id INTO v_revision_id;
      INSERT INTO pricing.zero_floor_authorization_schedule_heads (
        tenant_id, legal_entity_id, zero_floor_authorization_id,
        zero_floor_authorization_revision_id, schedule_revision
      ) VALUES (p_tenant_id, p_legal_entity_id, v_root.zero_floor_authorization_id, v_revision_id, 1);
      v_generation := pricing.advance_zero_floor_set_v1(
        p_tenant_id, p_legal_entity_id, v_action_id, 'AUTHORIZATION_CREATED');
      v_result := jsonb_build_object('outcome', 'ZERO_FLOOR_AUTHORIZATION_CREATED',
        'revision', v_revision, 'setGeneration', v_generation);
    END IF;
  END IF;
  INSERT INTO pricing.zero_floor_action_invocation_receipts (
    tenant_id, legal_entity_id, action_invocation_id, acting_principal_id,
    command_fingerprint, outcome
  ) VALUES (p_tenant_id, p_legal_entity_id, v_action_id,
    p_input ->> 'actingPrincipalId', v_fingerprint, v_result);
  RETURN QUERY SELECT v_result;
END;
$function$;

CREATE FUNCTION pricing.manage_zero_floor_authorization_v1(
  p_tenant_id uuid, p_legal_entity_id uuid, p_input jsonb
)
RETURNS TABLE(payload jsonb) LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_authorization jsonb := p_input -> 'authorization';
  v_ref text := p_input #>> '{authorization,authorizationRef}';
  v_intent text := p_input ->> 'intent';
  v_action_id text := p_input ->> 'actionInvocationId';
  v_principal_id text := p_input ->> 'actingPrincipalId';
  v_authorization_fingerprint text := pricing.zero_floor_authorization_fingerprint_v1(v_authorization);
  v_at timestamptz := (p_input ->> 'trustedOperationAt')::timestamptz;
  v_fingerprint text := pricing.management_fingerprint_v1(
    p_input - 'trustedOperationAt' - 'requestCorrelationId' - 'governanceProof' - 'acknowledgement');
  v_receipt pricing.zero_floor_action_invocation_receipts%ROWTYPE;
  v_head pricing.zero_floor_set_heads%ROWTYPE;
  v_root pricing.zero_floor_authorizations%ROWTYPE;
  v_schedule_head pricing.zero_floor_authorization_schedule_heads%ROWTYPE;
  v_approval pricing.zero_floor_governance_approvals%ROWTYPE;
  v_schedule jsonb;
  v_current jsonb;
  v_target jsonb;
  v_revisions jsonb;
  v_new_revision jsonb;
  v_ack jsonb;
  v_ack_row pricing.zero_floor_schedule_acknowledgements%ROWTYPE;
  v_ack_core jsonb;
  v_ack_fingerprint text;
  v_schedule_fingerprint text;
  v_payload_fingerprint text;
  v_future_count integer;
  v_approval_id uuid;
  v_approval_evidence jsonb;
  v_revision_id uuid;
  v_schedule_number integer;
  v_revision_number integer;
  v_generation integer;
  v_result jsonb;
  v_outcome text;
BEGIN
  IF v_authorization IS NULL OR v_ref IS NULL OR v_action_id IS NULL OR v_principal_id IS NULL
    OR p_input ->> 'expectedSetGeneration' IS NULL OR v_at IS NULL
    OR v_authorization #>> '{businessScope,tenantId}' IS DISTINCT FROM p_tenant_id::text
    OR v_authorization #>> '{businessScope,commercialScope,sellingLegalEntityId}' IS DISTINCT FROM p_legal_entity_id::text
    OR v_at > statement_timestamp()
    OR v_intent NOT IN ('APPROVE', 'SUCCESSOR', 'END_CURRENT', 'CORRECT_REVISION')
  THEN RAISE EXCEPTION 'ZERO_FLOOR management command scope, time, or intent is invalid' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':zero-floor-action:' || v_action_id, 0));
  SELECT * INTO v_receipt FROM pricing.zero_floor_action_invocation_receipts
   WHERE tenant_id = p_tenant_id AND action_invocation_id = v_action_id;
  IF FOUND THEN
    IF v_receipt.legal_entity_id = p_legal_entity_id
      AND v_receipt.acting_principal_id = v_principal_id
      AND v_receipt.command_fingerprint = v_fingerprint THEN
      RETURN QUERY SELECT v_receipt.outcome;
    ELSE
      RETURN QUERY SELECT jsonb_build_object('outcome', 'ZERO_FLOOR_AUTHORIZATION_CONFLICT',
        'authorizationRef', v_ref, 'reason', 'IDEMPOTENCY_CONFLICT');
    END IF;
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || p_legal_entity_id::text ||
    ':zero-floor-ref:' || v_ref, 0));
  PERFORM pricing.ensure_zero_floor_set_v1(p_tenant_id, p_legal_entity_id, v_action_id || ':initialize');
  SELECT * INTO STRICT v_head FROM pricing.zero_floor_set_heads
   WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id FOR UPDATE;
  IF v_head.generation <> (p_input ->> 'expectedSetGeneration')::integer THEN
    v_result := jsonb_build_object('outcome', 'ZERO_FLOOR_AUTHORIZATION_CONFLICT',
      'authorizationRef', v_ref, 'reason', 'EXPECTED_GENERATION_STALE');
  END IF;

  IF v_result IS NULL AND v_intent = 'APPROVE' THEN
    IF p_input ->> 'approvalRevision' IS NULL OR p_input -> 'validityPeriod' IS NULL
      OR v_principal_id IS DISTINCT FROM v_authorization #>> '{governanceEvidence,approvedByPrincipalRef}'
      OR (p_input #>> '{validityPeriod,startsAt}')::timestamptz > v_at
      OR v_at >= (p_input #>> '{validityPeriod,endsAt}')::timestamptz
    THEN RAISE EXCEPTION 'ZERO_FLOOR approval principal or validity is invalid' USING ERRCODE = '22023'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'zero-floor-approval-ref:' || p_tenant_id::text || ':' || p_legal_entity_id::text || ':' ||
      (v_authorization #>> '{governanceEvidence,approvalEvidenceRef}') || ':' ||
      (p_input ->> 'approvalRevision'), 0
    ));
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'zero-floor-approval-fingerprint:' || p_tenant_id::text || ':' || p_legal_entity_id::text || ':' ||
      v_authorization_fingerprint || ':' || (p_input ->> 'approvalRevision'), 0
    ));
    SELECT * INTO v_approval FROM pricing.zero_floor_governance_approvals
     WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
       AND approval_revision = p_input ->> 'approvalRevision'
       AND (
         approval_evidence_ref = v_authorization #>> '{governanceEvidence,approvalEvidenceRef}'
         OR authorization_fingerprint = v_authorization_fingerprint
       )
     ORDER BY approved_at DESC
     LIMIT 1;
    IF FOUND THEN
      IF v_approval.approval_evidence_ref = v_authorization #>> '{governanceEvidence,approvalEvidenceRef}'
        AND v_approval.approval_revision = p_input ->> 'approvalRevision'
        AND v_approval.authorization_fingerprint = v_authorization_fingerprint
        AND v_approval.approved_by_principal_id = v_principal_id
        AND v_approval.valid_from = (p_input #>> '{validityPeriod,startsAt}')::timestamptz
        AND v_approval.valid_until = (p_input #>> '{validityPeriod,endsAt}')::timestamptz
      THEN
        v_result := jsonb_build_object('outcome', 'ZERO_FLOOR_GOVERNANCE_APPROVAL_REUSED',
          'approvalEvidence', v_approval.approval_evidence, 'setGeneration', v_head.generation);
      ELSE
        v_result := jsonb_build_object('outcome', 'ZERO_FLOOR_AUTHORIZATION_CONFLICT',
          'authorizationRef', v_ref, 'reason', 'AUTHORIZATION_REF_ALREADY_BOUND');
      END IF;
    ELSE
      v_approval_id := gen_random_uuid();
      v_approval_evidence := jsonb_build_object(
        'approvalEvidenceRef', v_authorization #>> '{governanceEvidence,approvalEvidenceRef}',
        'approvalRevision', p_input ->> 'approvalRevision',
        'approvedAt', pricing.zero_floor_instant_v1(v_at),
        'approvedByPrincipalRef', v_principal_id,
        'approvedEffectivePeriod', v_authorization -> 'effectivePeriod',
        'authorityRef', 'pricing:zero-floor-governance-approval:' || v_approval_id::text,
        'authorization', v_authorization,
        'authorizationFingerprint', pricing.zero_floor_authorization_fingerprint_v1(v_authorization),
        'sellingLegalEntityId', p_legal_entity_id::text,
        'tenantId', p_tenant_id::text,
        'validityPeriod', p_input -> 'validityPeriod');
      INSERT INTO pricing.zero_floor_governance_approvals (
        zero_floor_governance_approval_id, tenant_id, legal_entity_id,
        approval_evidence_ref, approval_revision, authorization_fingerprint,
        approval_evidence, approved_by_principal_id, approved_at, valid_from, valid_until,
        action_invocation_id
      ) VALUES (v_approval_id, p_tenant_id, p_legal_entity_id,
        v_authorization #>> '{governanceEvidence,approvalEvidenceRef}',
        p_input ->> 'approvalRevision',
        v_authorization_fingerprint,
        v_approval_evidence, v_principal_id, v_at,
        (p_input #>> '{validityPeriod,startsAt}')::timestamptz,
        (p_input #>> '{validityPeriod,endsAt}')::timestamptz, v_action_id);
      v_generation := pricing.advance_zero_floor_set_v1(
        p_tenant_id, p_legal_entity_id, v_action_id, 'GOVERNANCE_APPROVAL_RECORDED');
      v_result := jsonb_build_object('outcome', 'ZERO_FLOOR_GOVERNANCE_APPROVAL_RECORDED',
        'approvalEvidence', v_approval_evidence, 'setGeneration', v_generation);
    END IF;
  END IF;

  IF v_result IS NULL AND v_intent <> 'APPROVE' THEN
    SELECT * INTO v_root FROM pricing.zero_floor_authorizations
     WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
       AND authorization_ref = v_ref;
    IF NOT FOUND THEN
      v_result := jsonb_build_object('outcome', 'ZERO_FLOOR_AUTHORIZATION_CONFLICT',
        'authorizationRef', v_ref, 'reason', 'EXPECTED_CURRENT_STALE');
    ELSE
      SELECT * INTO v_schedule_head FROM pricing.zero_floor_authorization_schedule_heads
       WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
         AND zero_floor_authorization_id = v_root.zero_floor_authorization_id FOR UPDATE;
      SELECT schedule INTO v_schedule FROM pricing.zero_floor_authorization_revisions
       WHERE zero_floor_authorization_revision_id = v_schedule_head.zero_floor_authorization_revision_id;
      v_current := pricing.zero_floor_current_revision_v1(v_schedule, v_at);
      IF v_intent IN ('SUCCESSOR', 'END_CURRENT') THEN
        IF v_current IS NULL OR
          pricing.canonicalize_management_json_v1(p_input -> 'expectedCurrent') <>
          pricing.canonicalize_management_json_v1(jsonb_build_object(
            'authorizationRef', v_ref,
            'authorizationRevision', v_current #>> '{authorization,authorizationRevision}',
            'effectivePeriod', v_current #> '{authorization,effectivePeriod}',
            'scheduleRevision', v_schedule_head.schedule_revision))
        THEN
          v_result := jsonb_build_object('outcome', 'ZERO_FLOOR_AUTHORIZATION_CONFLICT',
            'authorizationRef', v_ref, 'reason', 'EXPECTED_CURRENT_STALE');
        END IF;
      ELSIF (p_input ->> 'expectedScheduleRevision')::integer <> v_schedule_head.schedule_revision THEN
        v_result := jsonb_build_object('outcome', 'ZERO_FLOOR_AUTHORIZATION_CONFLICT',
          'authorizationRef', v_ref, 'reason', 'EXPECTED_SCHEDULE_STALE');
      ELSE
        SELECT value INTO v_target FROM jsonb_array_elements(v_schedule -> 'revisions') AS item(value)
         WHERE value #>> '{authorization,authorizationRevision}' = p_input ->> 'targetRevision';
        IF v_target IS NULL THEN
          v_result := jsonb_build_object('outcome', 'ZERO_FLOOR_AUTHORIZATION_CONFLICT',
            'authorizationRef', v_ref, 'reason', 'TARGET_REVISION_NOT_FOUND');
        END IF;
      END IF;
    END IF;
  END IF;

  IF v_result IS NULL AND v_intent <> 'APPROVE' THEN
    IF v_intent = 'CORRECT_REVISION' AND (
      pricing.canonicalize_management_json_v1(v_authorization -> 'businessScope') IS DISTINCT FROM
        pricing.canonicalize_management_json_v1(v_target #> '{authorization,businessScope}')
      OR v_authorization ->> 'currencyCode' IS DISTINCT FROM
        v_target #>> '{authorization,currencyCode}'
      OR ((v_target #> '{authorization,coveredMeaning,audienceRefs}') @>
        (v_authorization #> '{coveredMeaning,audienceRefs}')) IS NOT TRUE
      OR ((v_target #> '{authorization,coveredMeaning,materialRevisionRefs}') @>
        (v_authorization #> '{coveredMeaning,materialRevisionRefs}')) IS NOT TRUE
      OR (v_authorization #>> '{economicCoverage,minimumRawAmount}')::numeric <
        (v_target #>> '{authorization,economicCoverage,minimumRawAmount}')::numeric
      OR (v_authorization #>> '{economicCoverage,maximumFloorAdjustment}')::numeric >
        (v_target #>> '{authorization,economicCoverage,maximumFloorAdjustment}')::numeric
      OR (v_authorization #>> '{effectivePeriod,startsAt}')::timestamptz <
        (v_target #>> '{authorization,effectivePeriod,startsAt}')::timestamptz
      OR (
        v_target #>> '{authorization,effectivePeriod,endsAt}' IS NOT NULL
        AND (
          v_authorization #>> '{effectivePeriod,endsAt}' IS NULL
          OR (v_authorization #>> '{effectivePeriod,endsAt}')::timestamptz >
            (v_target #>> '{authorization,effectivePeriod,endsAt}')::timestamptz
        )
      )
    ) THEN
      v_result := jsonb_build_object('outcome', 'ZERO_FLOOR_AUTHORIZATION_CONFLICT',
        'authorizationRef', v_ref, 'reason', 'SCOPE_EXPANSION_REQUIRES_SUCCESSOR');
    END IF;
  END IF;

  IF v_result IS NULL AND v_intent <> 'APPROVE' THEN
    SELECT count(*) INTO v_future_count FROM jsonb_array_elements(v_schedule -> 'revisions') AS item(value)
     WHERE value ->> 'scheduleState' IS DISTINCT FROM 'SUPERSEDED'
       AND (value #>> '{authorization,effectivePeriod,startsAt}')::timestamptz > v_at;
    IF v_future_count > 0 THEN
      v_schedule_fingerprint := pricing.management_fingerprint_v1(v_schedule);
      v_payload_fingerprint := pricing.management_fingerprint_v1(
        p_input - 'acknowledgement' - 'governanceProof' - 'trustedOperationAt' -
          'requestCorrelationId' - 'actionInvocationId' - 'reason');
      v_ack_core := jsonb_build_object(
        'actingPrincipalId', v_principal_id, 'authorizationRef', v_ref,
        'expectedSetGeneration', v_head.generation,
        'intent', v_intent,
        'presentedSchedule', v_schedule,
        'presentedScheduleFingerprint', v_schedule_fingerprint,
        'proposedAuthorization', v_authorization,
        'proposedPayloadFingerprint', v_payload_fingerprint,
        'tenantId', p_tenant_id::text);
      IF v_intent IN ('SUCCESSOR', 'END_CURRENT') THEN
        v_ack_core := v_ack_core || jsonb_build_object('expectedCurrent', p_input -> 'expectedCurrent');
      END IF;
      IF v_intent = 'END_CURRENT' THEN
        v_ack_core := v_ack_core || jsonb_build_object('effectiveTo', p_input ->> 'effectiveTo');
      END IF;
      IF v_intent = 'CORRECT_REVISION' THEN
        v_ack_core := v_ack_core || jsonb_build_object('expectedScheduleRevision',
          v_schedule_head.schedule_revision, 'targetRevision', p_input ->> 'targetRevision');
      END IF;
      IF p_input -> 'acknowledgement' IS NULL THEN
        SELECT * INTO v_ack_row FROM pricing.zero_floor_schedule_acknowledgements
         WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
           AND authorization_ref = v_ref
           AND proposed_payload_fingerprint = v_payload_fingerprint
           AND issued_by_principal_id = v_principal_id
           AND valid_until > statement_timestamp()
           AND pricing.canonicalize_management_json_v1(
             acknowledgement - 'fingerprint' - 'issuedAt' - 'validUntil') =
             pricing.canonicalize_management_json_v1(v_ack_core)
         ORDER BY issued_at DESC LIMIT 1;
        IF FOUND THEN
          v_ack := v_ack_row.acknowledgement;
        ELSE
          v_ack_fingerprint := pricing.management_fingerprint_v1(
            v_ack_core || jsonb_build_object('challengeNonce', gen_random_uuid()));
          v_ack := v_ack_core || jsonb_build_object('fingerprint', v_ack_fingerprint,
            'issuedAt', pricing.zero_floor_instant_v1(statement_timestamp()),
            'validUntil', pricing.zero_floor_instant_v1(statement_timestamp() + interval '15 minutes'));
          INSERT INTO pricing.zero_floor_schedule_acknowledgements (
            tenant_id, legal_entity_id, authorization_ref, fingerprint,
            proposed_payload_fingerprint, acknowledgement, issued_by_principal_id,
            issued_at, valid_until
          ) VALUES (p_tenant_id, p_legal_entity_id, v_ref, v_ack_fingerprint,
            v_payload_fingerprint, v_ack, v_principal_id,
            (v_ack ->> 'issuedAt')::timestamptz, (v_ack ->> 'validUntil')::timestamptz);
        END IF;
        RETURN QUERY SELECT jsonb_build_object(
          'outcome', 'ZERO_FLOOR_AUTHORIZATION_ACKNOWLEDGEMENT_REQUIRED',
          'acknowledgement', v_ack);
        RETURN;
      END IF;
      SELECT * INTO v_ack_row FROM pricing.zero_floor_schedule_acknowledgements
       WHERE tenant_id = p_tenant_id AND legal_entity_id = p_legal_entity_id
         AND fingerprint = p_input #>> '{acknowledgement,fingerprint}'
         AND authorization_ref = v_ref;
      IF v_ack_row.zero_floor_schedule_acknowledgement_id IS NULL
        OR v_ack_row.valid_until <= statement_timestamp()
        OR v_ack_row.issued_by_principal_id <> v_principal_id
        OR v_ack_row.proposed_payload_fingerprint <> v_payload_fingerprint
        OR pricing.canonicalize_management_json_v1(
          v_ack_row.acknowledgement - 'fingerprint' - 'issuedAt' - 'validUntil') <>
          pricing.canonicalize_management_json_v1(v_ack_core)
        OR pricing.canonicalize_management_json_v1(p_input -> 'acknowledgement') <>
          pricing.canonicalize_management_json_v1(v_ack_row.acknowledgement)
      THEN
        v_result := jsonb_build_object('outcome', 'ZERO_FLOOR_AUTHORIZATION_CONFLICT',
          'authorizationRef', v_ref, 'reason', 'ACKNOWLEDGEMENT_STALE');
      END IF;
    ELSIF p_input -> 'acknowledgement' IS NOT NULL THEN
      v_result := jsonb_build_object('outcome', 'ZERO_FLOOR_AUTHORIZATION_CONFLICT',
        'authorizationRef', v_ref, 'reason', 'ACKNOWLEDGEMENT_STALE');
    END IF;
  END IF;

  IF v_result IS NULL AND v_intent IN ('SUCCESSOR', 'CORRECT_REVISION')
    AND pricing.zero_floor_governance_proof_matches_v1(
      p_tenant_id, p_legal_entity_id, v_authorization, p_input -> 'governanceProof', v_at) IS NOT TRUE
  THEN RAISE EXCEPTION 'ZERO_FLOOR proposed revision lacks current persisted governance approval'
    USING ERRCODE = 'P0002'; END IF;

  IF v_result IS NULL AND v_intent = 'SUCCESSOR' THEN
    IF pricing.canonicalize_management_json_v1(v_current -> 'authorization') =
        pricing.canonicalize_management_json_v1(v_authorization) THEN
      v_result := jsonb_build_object('outcome', 'ZERO_FLOOR_AUTHORIZATION_UNCHANGED',
        'schedule', v_schedule, 'setGeneration', v_head.generation);
    ELSIF EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_schedule -> 'revisions') AS item(value)
       WHERE value #>> '{authorization,authorizationRevision}' =
         v_authorization #>> '{authorizationRevision}'
    ) THEN
      v_result := jsonb_build_object('outcome', 'ZERO_FLOOR_AUTHORIZATION_CONFLICT',
        'authorizationRef', v_ref, 'reason', 'AUTHORIZATION_REF_ALREADY_BOUND');
    ELSIF (v_authorization #>> '{effectivePeriod,startsAt}')::timestamptz < v_at
      OR (v_authorization #>> '{effectivePeriod,startsAt}')::timestamptz <
        (v_current #>> '{authorization,effectivePeriod,startsAt}')::timestamptz
      OR v_authorization #>> '{effectivePeriod,endsAt}' IS DISTINCT FROM
        v_current #>> '{authorization,effectivePeriod,endsAt}'
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_schedule -> 'revisions') AS item(value)
         WHERE value ->> 'scheduleState' IS DISTINCT FROM 'SUPERSEDED'
           AND (value #>> '{authorization,effectivePeriod,startsAt}')::timestamptz > v_at
           AND (v_authorization #>> '{effectivePeriod,endsAt}' IS NULL OR
             (v_authorization #>> '{effectivePeriod,endsAt}')::timestamptz >
             (value #>> '{authorization,effectivePeriod,startsAt}')::timestamptz)
      )
    THEN
      v_result := jsonb_build_object('outcome', 'ZERO_FLOOR_AUTHORIZATION_CONFLICT',
        'authorizationRef', v_ref, 'reason', 'BOUNDARY_CROSSED');
    ELSE
      v_outcome := 'ZERO_FLOOR_AUTHORIZATION_SUCCEEDED';
      v_schedule_number := v_schedule_head.schedule_revision + 1;
      SELECT max((value ->> 'revisionNumber')::integer) + 1 INTO v_revision_number
        FROM jsonb_array_elements(v_schedule -> 'revisions') AS item(value);
      v_new_revision := jsonb_build_object('authorization', v_authorization,
        'lineage', jsonb_build_object('rootAuthorizationRef', v_ref, 'transition', 'SUCCESSOR',
          'predecessorRevision', v_current #>> '{authorization,authorizationRevision}'),
        'recordedAt', pricing.zero_floor_instant_v1(v_at), 'revisionNumber', v_revision_number,
        'scheduleRevision', v_schedule_number, 'scheduleState', 'SCHEDULED');
      SELECT jsonb_agg(CASE WHEN value #>> '{authorization,authorizationRevision}' =
          v_current #>> '{authorization,authorizationRevision}' THEN
          CASE WHEN v_authorization #>> '{effectivePeriod,startsAt}' =
              v_current #>> '{authorization,effectivePeriod,startsAt}'
            THEN value || jsonb_build_object('scheduleState', 'SUPERSEDED')
            ELSE jsonb_set(value, '{authorization,effectivePeriod,endsAt}',
              v_authorization #> '{effectivePeriod,startsAt}') END
          ELSE value END ORDER BY ordinality)
        INTO v_revisions FROM jsonb_array_elements(v_schedule -> 'revisions')
          WITH ORDINALITY AS item(value, ordinality);
      v_revisions := v_revisions || jsonb_build_array(v_new_revision);
    END IF;
  END IF;

  IF v_result IS NULL AND v_intent = 'END_CURRENT' THEN
    IF v_authorization #>> '{authorizationRevision}' <>
        v_current #>> '{authorization,authorizationRevision}'
      OR pricing.canonicalize_management_json_v1(v_authorization) <>
        pricing.canonicalize_management_json_v1(v_current -> 'authorization')
      OR (p_input ->> 'effectiveTo')::timestamptz < v_at
      OR (p_input ->> 'effectiveTo')::timestamptz <=
        (v_current #>> '{authorization,effectivePeriod,startsAt}')::timestamptz
      OR (v_current #>> '{authorization,effectivePeriod,endsAt}' IS NOT NULL
        AND (p_input ->> 'effectiveTo')::timestamptz >
          (v_current #>> '{authorization,effectivePeriod,endsAt}')::timestamptz)
    THEN
      v_result := jsonb_build_object('outcome', 'ZERO_FLOOR_AUTHORIZATION_CONFLICT',
        'authorizationRef', v_ref, 'reason', 'BOUNDARY_CROSSED');
    ELSE
      v_outcome := 'ZERO_FLOOR_AUTHORIZATION_ENDED';
      v_schedule_number := v_schedule_head.schedule_revision + 1;
      SELECT jsonb_agg(CASE WHEN value #>> '{authorization,authorizationRevision}' =
          v_current #>> '{authorization,authorizationRevision}'
        THEN jsonb_set(value, '{authorization,effectivePeriod,endsAt}',
          to_jsonb(pricing.zero_floor_instant_v1((p_input ->> 'effectiveTo')::timestamptz)))
        ELSE value END ORDER BY ordinality)
        INTO v_revisions FROM jsonb_array_elements(v_schedule -> 'revisions')
          WITH ORDINALITY AS item(value, ordinality);
    END IF;
  END IF;

  IF v_result IS NULL AND v_intent = 'CORRECT_REVISION' THEN
    IF v_target ->> 'scheduleState' = 'SUPERSEDED'
      OR v_authorization ->> 'authorizationRevision' = p_input ->> 'targetRevision'
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_schedule -> 'revisions') AS item(value)
         WHERE value #>> '{authorization,authorizationRevision}' =
           v_authorization #>> '{authorizationRevision}'
      )
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_schedule -> 'revisions') AS item(value)
         WHERE value ->> 'scheduleState' IS DISTINCT FROM 'SUPERSEDED'
           AND value #>> '{authorization,authorizationRevision}' <> p_input ->> 'targetRevision'
           AND (value #>> '{authorization,effectivePeriod,endsAt}' IS NULL OR
             (value #>> '{authorization,effectivePeriod,endsAt}')::timestamptz >
             (v_authorization #>> '{effectivePeriod,startsAt}')::timestamptz)
           AND (v_authorization #>> '{effectivePeriod,endsAt}' IS NULL OR
             (v_authorization #>> '{effectivePeriod,endsAt}')::timestamptz >
             (value #>> '{authorization,effectivePeriod,startsAt}')::timestamptz)
      )
    THEN
      v_result := jsonb_build_object('outcome', 'ZERO_FLOOR_AUTHORIZATION_CONFLICT',
        'authorizationRef', v_ref, 'reason', 'OVERLAPPING_SCHEDULE');
    ELSE
      v_outcome := 'ZERO_FLOOR_AUTHORIZATION_CORRECTED';
      v_schedule_number := v_schedule_head.schedule_revision + 1;
      SELECT max((value ->> 'revisionNumber')::integer) + 1 INTO v_revision_number
        FROM jsonb_array_elements(v_schedule -> 'revisions') AS item(value);
      v_new_revision := jsonb_build_object('authorization', v_authorization,
        'lineage', jsonb_build_object('rootAuthorizationRef', v_ref, 'transition', 'CORRECTED',
          'predecessorRevision', p_input ->> 'targetRevision',
          'correctedRevision', p_input ->> 'targetRevision'),
        'recordedAt', pricing.zero_floor_instant_v1(v_at), 'revisionNumber', v_revision_number,
        'scheduleRevision', v_schedule_number, 'scheduleState', 'SCHEDULED');
      SELECT jsonb_agg(CASE WHEN value #>> '{authorization,authorizationRevision}' =
          p_input ->> 'targetRevision'
        THEN value || jsonb_build_object('scheduleState', 'SUPERSEDED')
        ELSE value END ORDER BY ordinality)
        INTO v_revisions FROM jsonb_array_elements(v_schedule -> 'revisions')
          WITH ORDINALITY AS item(value, ordinality);
      v_revisions := v_revisions || jsonb_build_array(v_new_revision);
    END IF;
  END IF;

  IF v_result IS NULL AND v_outcome IS NOT NULL THEN
    v_schedule := jsonb_build_object('authorizationRef', v_ref, 'revisions', v_revisions,
      'scheduleRevision', v_schedule_number, 'tenantId', p_tenant_id::text);
    INSERT INTO pricing.zero_floor_authorization_revisions (
      tenant_id, legal_entity_id, zero_floor_authorization_id, schedule_revision,
      previous_zero_floor_authorization_revision_id, schedule,
      action_invocation_id, command_fingerprint, acting_principal_id, reason
    ) VALUES (p_tenant_id, p_legal_entity_id, v_root.zero_floor_authorization_id,
      v_schedule_number, v_schedule_head.zero_floor_authorization_revision_id,
      v_schedule, v_action_id, v_fingerprint, v_principal_id, p_input ->> 'reason')
    RETURNING zero_floor_authorization_revision_id INTO v_revision_id;
    UPDATE pricing.zero_floor_authorization_schedule_heads
       SET zero_floor_authorization_revision_id = v_revision_id,
         schedule_revision = v_schedule_number
     WHERE zero_floor_authorization_schedule_head_id =
       v_schedule_head.zero_floor_authorization_schedule_head_id
       AND schedule_revision = v_schedule_head.schedule_revision;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ZERO_FLOOR schedule changed concurrently' USING ERRCODE = '40001';
    END IF;
    v_generation := pricing.advance_zero_floor_set_v1(
      p_tenant_id, p_legal_entity_id, v_action_id, 'AUTHORIZATION_SCHEDULE_CHANGED');
    v_result := jsonb_build_object('outcome', v_outcome,
      'schedule', v_schedule, 'setGeneration', v_generation);
  END IF;
  INSERT INTO pricing.zero_floor_action_invocation_receipts (
    tenant_id, legal_entity_id, action_invocation_id, acting_principal_id,
    command_fingerprint, outcome
  ) VALUES (p_tenant_id, p_legal_entity_id, v_action_id,
    v_principal_id, v_fingerprint, v_result);
  RETURN QUERY SELECT v_result;
END;
$function$;

GRANT EXECUTE ON FUNCTION pricing.zero_floor_current_revision_v1(jsonb,timestamptz),
  pricing.zero_floor_instant_v1(timestamptz),
  pricing.zero_floor_approval_for_v1(uuid,uuid,jsonb,timestamptz),
  pricing.zero_floor_governance_proof_matches_v1(uuid,uuid,jsonb,jsonb,timestamptz)
TO pricing_management_routine_writer;

ALTER FUNCTION pricing.create_zero_floor_authorization_v1(uuid,uuid,jsonb) SECURITY DEFINER;
ALTER FUNCTION pricing.manage_zero_floor_authorization_v1(uuid,uuid,jsonb) SECURITY DEFINER;
GRANT CREATE ON SCHEMA pricing TO pricing_management_routine_writer;
ALTER FUNCTION pricing.create_zero_floor_authorization_v1(uuid,uuid,jsonb)
  OWNER TO pricing_management_routine_writer;
ALTER FUNCTION pricing.manage_zero_floor_authorization_v1(uuid,uuid,jsonb)
  OWNER TO pricing_management_routine_writer;
REVOKE CREATE ON SCHEMA pricing FROM pricing_management_routine_writer;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pricing FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pricing.zero_floor_current_revision_v1(jsonb, timestamptz) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.zero_floor_instant_v1(timestamptz) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.zero_floor_approval_for_v1(uuid, uuid, jsonb, timestamptz) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.zero_floor_governance_proof_matches_v1(uuid, uuid, jsonb, jsonb, timestamptz) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.create_zero_floor_authorization_v1(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.manage_zero_floor_authorization_v1(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.read_current_zero_floor_authorization_set_v1(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.read_current_zero_floor_authorization_governance_proof_v1(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.verify_zero_floor_authorization_set_generation_v1(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.read_zero_floor_authorization_schedule_v1(uuid, uuid, jsonb) TO ontos_runtime;
GRANT EXECUTE ON FUNCTION pricing.lookup_zero_floor_authorization_result_v1(uuid, uuid, jsonb) TO ontos_runtime;
