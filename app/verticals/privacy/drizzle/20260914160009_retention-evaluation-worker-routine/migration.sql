CREATE OR REPLACE FUNCTION "privacy"."process_retention_evaluation_work"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_work_ref text,
  p_message_id uuid,
  p_evaluated_at timestamptz
)
RETURNS TABLE (
  outcome text,
  work_ref text,
  status text,
  evaluated_at timestamptz,
  work_record jsonb,
  blocker_refs text[],
  owner_outcome_ref text,
  reason text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, privacy
SET row_security = on
AS $retention_evaluation$
DECLARE
  v_work privacy.retention_evaluation_work%ROWTYPE;
  v_due_rule privacy.retention_rules%ROWTYPE;
  v_current_rule privacy.retention_rules%ROWTYPE;
  v_decision privacy.disposition_decisions%ROWTYPE;
  v_dispatch privacy.privacy_measure_dispatches%ROWTYPE;
  v_owner_outcome privacy.owner_execution_outcomes%ROWTYPE;
  v_count integer := 0;
  v_invalid_count integer := 0;
  v_result text := 'EVALUATED';
  v_status text := 'INDETERMINATE';
  v_reason text := 'RETENTION_EVALUATED';
  v_record jsonb;
  v_blocker_refs text[] := ARRAY[]::text[];
  v_owner_outcome_ref text := NULL;
  v_evaluated_text text;
BEGIN
  IF current_setting('ontos.tenant_id', true) IS DISTINCT FROM p_tenant_id::text
     OR current_setting('ontos.legal_entity_id', true) IS DISTINCT FROM p_legal_entity_id::text
  THEN
    RETURN QUERY SELECT
      'SCOPE_MISMATCH'::text,
      NULL::text,
      NULL::text,
      NULL::timestamptz,
      NULL::jsonb,
      ARRAY[]::text[],
      NULL::text,
      'VERIFIED_SCOPE_MISMATCH'::text;
    RETURN;
  END IF;

  IF p_tenant_id IS NULL
     OR p_legal_entity_id IS NULL
     OR p_message_id IS NULL
     OR p_evaluated_at IS NULL
     OR p_work_ref IS NULL
     OR char_length(btrim(p_work_ref)) NOT BETWEEN 1 AND 300
  THEN
    RETURN QUERY SELECT
      'INVALID_INPUT'::text,
      NULL::text,
      NULL::text,
      NULL::timestamptz,
      NULL::jsonb,
      ARRAY[]::text[],
      NULL::text,
      'ROUTINE_INPUT_INVALID'::text;
    RETURN;
  END IF;

  SELECT work.*
  INTO v_work
  FROM privacy.retention_evaluation_work AS work
  WHERE work.tenant_id = p_tenant_id
    AND work.legal_entity_id = p_legal_entity_id
    AND work.work_ref = btrim(p_work_ref)
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT
      'NOT_FOUND'::text,
      NULL::text,
      NULL::text,
      NULL::timestamptz,
      NULL::jsonb,
      ARRAY[]::text[],
      NULL::text,
      'WORK_NOT_FOUND_IN_SCOPE'::text;
    RETURN;
  END IF;

  v_record := v_work.work_record;
  v_evaluated_text := to_char(p_evaluated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  IF jsonb_typeof(v_record) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_record->'contentScopeRefs') IS DISTINCT FROM 'array'
  THEN
    v_result := 'STATE_AMBIGUOUS';
    v_reason := 'WORK_RECORD_INVALID';
  ELSIF jsonb_array_length(v_record->'contentScopeRefs') = 0
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(v_record->'contentScopeRefs') AS scope(value)
       WHERE jsonb_typeof(scope.value) IS DISTINCT FROM 'string'
          OR char_length(btrim(scope.value #>> '{}')) NOT BETWEEN 1 AND 300
     )
     OR v_record->>'workRef' IS DISTINCT FROM v_work.work_ref
     OR v_record->>'idempotencyRef' IS DISTINCT FROM v_work.idempotency_ref
     OR v_record->>'ruleRef' IS DISTINCT FROM v_work.rule_ref
     OR v_record->'ruleVersion' IS DISTINCT FROM to_jsonb(v_work.rule_version)
     OR v_record->>'status' IS DISTINCT FROM v_work.status
  THEN
    v_result := 'STATE_AMBIGUOUS';
    v_reason := 'WORK_RECORD_INVALID';
  END IF;

  IF v_result = 'EVALUATED' AND v_work.due_at > p_evaluated_at THEN
    RETURN QUERY SELECT
      'NOT_DUE'::text,
      v_work.work_ref,
      v_work.status,
      v_work.evaluated_at,
      v_work.work_record,
      ARRAY[]::text[],
      NULL::text,
      'WORK_NOT_DUE'::text;
    RETURN;
  END IF;

  IF v_result = 'EVALUATED'
     AND v_record#>>'{workerEvaluation,messageId}' = p_message_id::text
     AND v_work.status IN ('READY', 'BLOCKED', 'COMPLETED')
  THEN
    RETURN QUERY SELECT
      'REPLAY'::text,
      v_work.work_ref,
      v_work.status,
      v_work.evaluated_at,
      v_work.work_record,
      CASE
        WHEN jsonb_typeof(v_record#>'{workerEvaluation,blockerRefs}') = 'array'
        THEN ARRAY(
          SELECT jsonb_array_elements_text(v_record#>'{workerEvaluation,blockerRefs}')
          ORDER BY 1
        )
        ELSE ARRAY[]::text[]
      END,
      v_record#>>'{workerEvaluation,ownerOutcomeRef}',
      'IDEMPOTENT_REPLAY'::text;
    RETURN;
  END IF;

  IF v_result = 'EVALUATED' THEN
    SELECT count(*)::integer
    INTO v_count
    FROM privacy.retention_rules AS rule
    WHERE rule.tenant_id = p_tenant_id
      AND rule.legal_entity_id = p_legal_entity_id
      AND rule.rule_ref = v_work.rule_ref
      AND rule.effective_from <= v_work.due_at
      AND (rule.effective_to IS NULL OR v_work.due_at < rule.effective_to);

    IF v_count = 0 THEN
      v_result := 'STATE_UNAVAILABLE';
      v_reason := 'APPLICABLE_RULE_UNAVAILABLE';
    ELSIF v_count <> 1 THEN
      v_result := 'STATE_AMBIGUOUS';
      v_reason := 'APPLICABLE_RULE_AMBIGUOUS';
    ELSE
      SELECT rule.*
      INTO v_due_rule
      FROM privacy.retention_rules AS rule
      WHERE rule.tenant_id = p_tenant_id
        AND rule.legal_entity_id = p_legal_entity_id
        AND rule.rule_ref = v_work.rule_ref
        AND rule.effective_from <= v_work.due_at
        AND (rule.effective_to IS NULL OR v_work.due_at < rule.effective_to);

      IF v_due_rule.rule_version IS DISTINCT FROM v_work.rule_version
         OR jsonb_typeof(v_due_rule.rule_record) IS DISTINCT FROM 'object'
         OR v_due_rule.rule_record->>'ruleRef' IS DISTINCT FROM v_due_rule.rule_ref
         OR v_due_rule.rule_record->'ruleVersion' IS DISTINCT FROM to_jsonb(v_due_rule.rule_version)
         OR v_due_rule.rule_record->>'contentScopeRef' IS DISTINCT FROM v_due_rule.content_scope_ref
         OR jsonb_array_length(v_record->'contentScopeRefs') <> 1
         OR v_record->'contentScopeRefs'->>0 IS DISTINCT FROM v_due_rule.content_scope_ref
      THEN
        v_result := 'STATE_AMBIGUOUS';
        v_reason := 'APPLICABLE_RULE_MISMATCH';
      END IF;
    END IF;
  END IF;

  IF v_result = 'EVALUATED' THEN
    SELECT count(*)::integer
    INTO v_count
    FROM privacy.retention_rules AS rule
    WHERE rule.tenant_id = p_tenant_id
      AND rule.legal_entity_id = p_legal_entity_id
      AND rule.rule_ref = v_work.rule_ref
      AND rule.effective_from <= p_evaluated_at
      AND (rule.effective_to IS NULL OR p_evaluated_at < rule.effective_to);

    IF v_count = 0 THEN
      v_result := 'STATE_UNAVAILABLE';
      v_reason := 'CURRENT_RULE_UNAVAILABLE';
    ELSIF v_count <> 1 THEN
      v_result := 'STATE_AMBIGUOUS';
      v_reason := 'CURRENT_RULE_AMBIGUOUS';
    ELSE
      SELECT rule.*
      INTO v_current_rule
      FROM privacy.retention_rules AS rule
      WHERE rule.tenant_id = p_tenant_id
        AND rule.legal_entity_id = p_legal_entity_id
        AND rule.rule_ref = v_work.rule_ref
        AND rule.effective_from <= p_evaluated_at
        AND (rule.effective_to IS NULL OR p_evaluated_at < rule.effective_to);

      IF jsonb_typeof(v_current_rule.rule_record) IS DISTINCT FROM 'object'
         OR v_current_rule.rule_record->>'ruleRef' IS DISTINCT FROM v_current_rule.rule_ref
         OR v_current_rule.rule_record->'ruleVersion' IS DISTINCT FROM to_jsonb(v_current_rule.rule_version)
         OR v_current_rule.rule_record->>'contentScopeRef' IS DISTINCT FROM v_current_rule.content_scope_ref
         OR v_current_rule.rule_record->>'applicability' NOT IN ('PROSPECTIVE_ONLY', 'EXPLICIT_RETROACTIVE')
      THEN
        v_result := 'STATE_AMBIGUOUS';
        v_reason := 'CURRENT_RULE_INVALID';
      ELSIF v_current_rule.rule_version <> v_work.rule_version
         AND v_current_rule.rule_record->>'applicability' = 'EXPLICIT_RETROACTIVE'
      THEN
        v_result := 'STATE_AMBIGUOUS';
        v_reason := 'RETROACTIVE_RULE_REQUALIFICATION_REQUIRED';
      END IF;
    END IF;
  END IF;

  IF v_result = 'EVALUATED' THEN
    WITH latest AS (
      SELECT
        exception.*,
        max(exception.recorded_at) OVER (PARTITION BY exception.exception_ref) AS latest_recorded_at
      FROM privacy.retention_exceptions AS exception
      WHERE exception.tenant_id = p_tenant_id
        AND exception.legal_entity_id = p_legal_entity_id
        AND exception.recorded_at <= p_evaluated_at
    )
    SELECT count(*)::integer
    INTO v_invalid_count
    FROM latest
    WHERE latest.recorded_at = latest.latest_recorded_at
      AND (
        jsonb_typeof(latest.exception_record) IS DISTINCT FROM 'object'
        OR jsonb_typeof(latest.exception_record->'contentScopeRefs') IS DISTINCT FROM 'array'
        OR latest.exception_record->>'exceptionRef' IS DISTINCT FROM latest.exception_ref
      );

    WITH latest AS (
      SELECT
        exception.exception_ref,
        exception.recorded_at,
        max(exception.recorded_at) OVER (PARTITION BY exception.exception_ref) AS latest_recorded_at
      FROM privacy.retention_exceptions AS exception
      WHERE exception.tenant_id = p_tenant_id
        AND exception.legal_entity_id = p_legal_entity_id
        AND exception.recorded_at <= p_evaluated_at
    )
    SELECT count(*)::integer
    INTO v_count
    FROM (
      SELECT latest.exception_ref
      FROM latest
      WHERE latest.recorded_at = latest.latest_recorded_at
      GROUP BY latest.exception_ref
      HAVING count(*) <> 1
    ) AS ambiguous;

    IF v_invalid_count > 0 OR v_count > 0 THEN
      v_result := 'STATE_AMBIGUOUS';
      v_reason := 'RETENTION_EXCEPTION_STATE_AMBIGUOUS';
    END IF;
  END IF;

  IF v_result = 'EVALUATED' THEN
    WITH latest AS (
      SELECT
        hold.*,
        max(hold.recorded_at) OVER (PARTITION BY hold.hold_ref) AS latest_recorded_at
      FROM privacy.legal_holds AS hold
      WHERE hold.tenant_id = p_tenant_id
        AND hold.legal_entity_id = p_legal_entity_id
        AND hold.recorded_at <= p_evaluated_at
    )
    SELECT count(*)::integer
    INTO v_invalid_count
    FROM latest
    WHERE latest.recorded_at = latest.latest_recorded_at
      AND (
        jsonb_typeof(latest.hold_record) IS DISTINCT FROM 'object'
        OR jsonb_typeof(latest.hold_record->'contentScopeRefs') IS DISTINCT FROM 'array'
        OR latest.hold_record->>'holdRef' IS DISTINCT FROM latest.hold_ref
      );

    WITH latest AS (
      SELECT
        hold.hold_ref,
        hold.recorded_at,
        max(hold.recorded_at) OVER (PARTITION BY hold.hold_ref) AS latest_recorded_at
      FROM privacy.legal_holds AS hold
      WHERE hold.tenant_id = p_tenant_id
        AND hold.legal_entity_id = p_legal_entity_id
        AND hold.recorded_at <= p_evaluated_at
    )
    SELECT count(*)::integer
    INTO v_count
    FROM (
      SELECT latest.hold_ref
      FROM latest
      WHERE latest.recorded_at = latest.latest_recorded_at
      GROUP BY latest.hold_ref
      HAVING count(*) <> 1
    ) AS ambiguous;

    IF v_invalid_count > 0 OR v_count > 0 THEN
      v_result := 'STATE_AMBIGUOUS';
      v_reason := 'LEGAL_HOLD_STATE_AMBIGUOUS';
    END IF;
  END IF;

  IF v_result = 'EVALUATED' THEN
    WITH latest_exceptions AS (
      SELECT
        exception.*,
        max(exception.recorded_at) OVER (PARTITION BY exception.exception_ref) AS latest_recorded_at
      FROM privacy.retention_exceptions AS exception
      WHERE exception.tenant_id = p_tenant_id
        AND exception.legal_entity_id = p_legal_entity_id
        AND exception.recorded_at <= p_evaluated_at
    ),
    latest_holds AS (
      SELECT
        hold.*,
        max(hold.recorded_at) OVER (PARTITION BY hold.hold_ref) AS latest_recorded_at
      FROM privacy.legal_holds AS hold
      WHERE hold.tenant_id = p_tenant_id
        AND hold.legal_entity_id = p_legal_entity_id
        AND hold.recorded_at <= p_evaluated_at
    ),
    blockers AS (
      SELECT 'retention-exception:' || exception.exception_ref AS blocker_ref
      FROM latest_exceptions AS exception
      WHERE exception.recorded_at = exception.latest_recorded_at
        AND exception.effective_from <= p_evaluated_at
        AND p_evaluated_at < exception.effective_to
        AND (exception.released_at IS NULL OR p_evaluated_at < exception.released_at)
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(exception.exception_record->'contentScopeRefs') AS scope(value)
          WHERE v_record->'contentScopeRefs' ? scope.value
        )
      UNION ALL
      SELECT 'legal-hold:' || hold.hold_ref AS blocker_ref
      FROM latest_holds AS hold
      WHERE hold.recorded_at = hold.latest_recorded_at
        AND hold.effective_from <= p_evaluated_at
        AND p_evaluated_at < hold.effective_to
        AND (hold.released_at IS NULL OR p_evaluated_at < hold.released_at)
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(hold.hold_record->'contentScopeRefs') AS scope(value)
          WHERE v_record->'contentScopeRefs' ? scope.value
        )
    )
    SELECT coalesce(array_agg(blockers.blocker_ref ORDER BY blockers.blocker_ref), ARRAY[]::text[])
    INTO v_blocker_refs
    FROM blockers;

    IF cardinality(v_blocker_refs) > 0 THEN
      v_status := 'BLOCKED';
      v_reason := 'CURRENT_RETENTION_BLOCKER';
    ELSE
      v_status := 'READY';
      v_reason := 'NO_CURRENT_RETENTION_BLOCKER';
    END IF;
  END IF;

  IF v_result = 'EVALUATED' AND v_status = 'READY' THEN
    SELECT count(*)::integer
    INTO v_invalid_count
    FROM privacy.disposition_decisions AS decision
    WHERE decision.tenant_id = p_tenant_id
      AND decision.legal_entity_id = p_legal_entity_id
      AND decision.rule_ref = v_work.rule_ref
      AND decision.rule_version = v_work.rule_version
      AND (
        jsonb_typeof(decision.decision_record) IS DISTINCT FROM 'object'
        OR jsonb_typeof(decision.decision_record->'contentScopeRefs') IS DISTINCT FROM 'array'
        OR decision.decision_record->>'decisionRef' IS DISTINCT FROM decision.decision_ref
        OR decision.decision_record->>'outcome' IS DISTINCT FROM decision.outcome
      );

    IF v_invalid_count > 0 THEN
      v_result := 'STATE_AMBIGUOUS';
      v_reason := 'DISPOSITION_STATE_INVALID';
      v_status := 'INDETERMINATE';
    ELSE
      SELECT count(*)::integer
      INTO v_count
      FROM privacy.disposition_decisions AS decision
      WHERE decision.tenant_id = p_tenant_id
        AND decision.legal_entity_id = p_legal_entity_id
        AND decision.rule_ref = v_work.rule_ref
        AND decision.rule_version = v_work.rule_version
        AND jsonb_array_length(decision.decision_record->'contentScopeRefs') =
          jsonb_array_length(v_record->'contentScopeRefs')
        AND decision.decision_record->'contentScopeRefs' @> v_record->'contentScopeRefs'
        AND v_record->'contentScopeRefs' @> decision.decision_record->'contentScopeRefs';

      IF v_count > 1 THEN
        v_result := 'STATE_AMBIGUOUS';
        v_reason := 'DISPOSITION_STATE_AMBIGUOUS';
        v_status := 'INDETERMINATE';
      ELSIF v_count = 1 THEN
        SELECT decision.*
        INTO v_decision
        FROM privacy.disposition_decisions AS decision
        WHERE decision.tenant_id = p_tenant_id
          AND decision.legal_entity_id = p_legal_entity_id
          AND decision.rule_ref = v_work.rule_ref
          AND decision.rule_version = v_work.rule_version
          AND jsonb_array_length(decision.decision_record->'contentScopeRefs') =
            jsonb_array_length(v_record->'contentScopeRefs')
          AND decision.decision_record->'contentScopeRefs' @> v_record->'contentScopeRefs'
          AND v_record->'contentScopeRefs' @> decision.decision_record->'contentScopeRefs';

        IF v_decision.outcome = 'INDETERMINATE' THEN
          v_result := 'STATE_AMBIGUOUS';
          v_reason := 'DISPOSITION_DECISION_INDETERMINATE';
          v_status := 'INDETERMINATE';
        END IF;
      END IF;
    END IF;
  END IF;

  IF v_result = 'EVALUATED' AND v_status = 'READY' AND v_count = 1 AND v_decision.decision_ref IS NOT NULL THEN
    SELECT count(*)::integer
    INTO v_invalid_count
    FROM privacy.privacy_measure_dispatches AS dispatch
    WHERE dispatch.tenant_id = p_tenant_id
      AND dispatch.legal_entity_id = p_legal_entity_id
      AND dispatch.handoff_record->>'sourceDecisionRef' = v_decision.decision_ref
      AND (
        jsonb_typeof(dispatch.handoff_record) IS DISTINCT FROM 'object'
        OR jsonb_typeof(dispatch.handoff_record->'contentScopeRefs') IS DISTINCT FROM 'array'
        OR dispatch.handoff_record->>'measureId' IS DISTINCT FROM dispatch.measure_id
        OR dispatch.handoff_record->>'dispositionDecision' IS DISTINCT FROM v_decision.outcome
      );

    IF v_invalid_count > 0 THEN
      v_result := 'STATE_AMBIGUOUS';
      v_reason := 'OWNER_DISPATCH_INVALID';
      v_status := 'INDETERMINATE';
    ELSE
      SELECT count(*)::integer
      INTO v_count
      FROM privacy.privacy_measure_dispatches AS dispatch
      WHERE dispatch.tenant_id = p_tenant_id
        AND dispatch.legal_entity_id = p_legal_entity_id
        AND dispatch.handoff_record->>'sourceDecisionRef' = v_decision.decision_ref
        AND jsonb_array_length(dispatch.handoff_record->'contentScopeRefs') =
          jsonb_array_length(v_record->'contentScopeRefs')
        AND dispatch.handoff_record->'contentScopeRefs' @> v_record->'contentScopeRefs'
        AND v_record->'contentScopeRefs' @> dispatch.handoff_record->'contentScopeRefs';

      IF v_count > 1 THEN
        v_result := 'STATE_AMBIGUOUS';
        v_reason := 'OWNER_DISPATCH_AMBIGUOUS';
        v_status := 'INDETERMINATE';
      ELSIF v_count = 1 THEN
        SELECT dispatch.*
        INTO v_dispatch
        FROM privacy.privacy_measure_dispatches AS dispatch
        WHERE dispatch.tenant_id = p_tenant_id
          AND dispatch.legal_entity_id = p_legal_entity_id
          AND dispatch.handoff_record->>'sourceDecisionRef' = v_decision.decision_ref
          AND jsonb_array_length(dispatch.handoff_record->'contentScopeRefs') =
            jsonb_array_length(v_record->'contentScopeRefs')
          AND dispatch.handoff_record->'contentScopeRefs' @> v_record->'contentScopeRefs'
          AND v_record->'contentScopeRefs' @> dispatch.handoff_record->'contentScopeRefs';
      END IF;
    END IF;
  END IF;

  IF v_result = 'EVALUATED' AND v_status = 'READY' AND v_dispatch.measure_id IS NOT NULL THEN
    SELECT count(*)::integer
    INTO v_invalid_count
    FROM privacy.owner_execution_outcomes AS owner_outcome
    WHERE owner_outcome.tenant_id = p_tenant_id
      AND owner_outcome.legal_entity_id = p_legal_entity_id
      AND owner_outcome.measure_id = v_dispatch.measure_id
      AND (
        jsonb_typeof(owner_outcome.outcome_record) IS DISTINCT FROM 'object'
        OR owner_outcome.outcome_record->>'outcomeId' IS DISTINCT FROM owner_outcome.outcome_id
        OR owner_outcome.outcome_record->>'measureId' IS DISTINCT FROM owner_outcome.measure_id
        OR owner_outcome.outcome_record->>'status' IS DISTINCT FROM owner_outcome.status
        OR owner_outcome.outcome_record->>'sourceDecisionRef' IS DISTINCT FROM v_decision.decision_ref
      );

    IF v_invalid_count > 0 THEN
      v_result := 'STATE_AMBIGUOUS';
      v_reason := 'OWNER_OUTCOME_INVALID';
      v_status := 'INDETERMINATE';
    ELSE
      SELECT owner_outcome.*
      INTO v_owner_outcome
      FROM privacy.owner_execution_outcomes AS owner_outcome
      WHERE owner_outcome.tenant_id = p_tenant_id
        AND owner_outcome.legal_entity_id = p_legal_entity_id
        AND owner_outcome.measure_id = v_dispatch.measure_id
      ORDER BY owner_outcome.attempt DESC
      LIMIT 1;

      IF FOUND THEN
        v_owner_outcome_ref := v_owner_outcome.outcome_id;
        IF v_dispatch.status IS DISTINCT FROM v_owner_outcome.status THEN
          v_result := 'STATE_AMBIGUOUS';
          v_reason := 'OWNER_OUTCOME_STATUS_MISMATCH';
          v_status := 'INDETERMINATE';
        ELSIF v_owner_outcome.status = 'SUCCEEDED' THEN
          v_status := 'COMPLETED';
          v_reason := 'OWNER_EXECUTION_SUCCEEDED';
        ELSIF v_owner_outcome.status = 'BLOCKED' THEN
          v_status := 'BLOCKED';
          v_reason := 'OWNER_EXECUTION_BLOCKED';
        ELSIF v_owner_outcome.status IN ('PARTIAL', 'BUSINESS_REJECTED', 'NOT_APPLICABLE', 'TECHNICAL_FAILED', 'INDETERMINATE') THEN
          v_result := 'STATE_AMBIGUOUS';
          v_reason := 'OWNER_EXECUTION_REQUIRES_RECONCILIATION';
          v_status := 'INDETERMINATE';
        END IF;
      ELSIF v_dispatch.status NOT IN ('RECEIVED', 'IN_PROGRESS') THEN
        v_result := 'STATE_AMBIGUOUS';
        v_reason := 'OWNER_OUTCOME_UNAVAILABLE';
        v_status := 'INDETERMINATE';
      END IF;
    END IF;
  END IF;

  IF v_result IN ('STATE_AMBIGUOUS', 'STATE_UNAVAILABLE') THEN
    v_status := 'INDETERMINATE';
    v_blocker_refs := ARRAY[]::text[];
    v_owner_outcome_ref := NULL;
  END IF;

  IF v_status = 'COMPLETED' AND v_owner_outcome_ref IS NULL THEN
    v_result := 'STATE_AMBIGUOUS';
    v_status := 'INDETERMINATE';
    v_reason := 'OWNER_OUTCOME_REQUIRED_FOR_COMPLETION';
  END IF;

  v_record := jsonb_set(v_record, '{status}', to_jsonb(v_status), true);
  v_record := jsonb_set(v_record, '{evaluatedAt}', to_jsonb(v_evaluated_text), true);
  v_record := jsonb_set(
    v_record,
    '{workerEvaluation}',
    jsonb_build_object(
      'blockerRefs', to_jsonb(v_blocker_refs),
      'currentRuleVersion', v_current_rule.rule_version,
      'evaluatedAt', v_evaluated_text,
      'messageId', p_message_id::text,
      'ownerOutcomeRef', v_owner_outcome_ref,
      'reason', v_reason,
      'ruleRef', v_work.rule_ref,
      'ruleVersion', v_work.rule_version,
      'status', v_status
    ),
    true
  );

  UPDATE privacy.retention_evaluation_work AS work
  SET
    status = v_status,
    evaluated_at = p_evaluated_at,
    work_record = v_record
  WHERE work.tenant_id = p_tenant_id
    AND work.legal_entity_id = p_legal_entity_id
    AND work.work_ref = v_work.work_ref;

  IF NOT FOUND THEN
    RETURN QUERY SELECT
      'STATE_UNAVAILABLE'::text,
      v_work.work_ref,
      'INDETERMINATE'::text,
      p_evaluated_at,
      v_record,
      ARRAY[]::text[],
      NULL::text,
      'WORK_UPDATE_UNAVAILABLE'::text;
    RETURN;
  END IF;

  RETURN QUERY SELECT
    v_result,
    v_work.work_ref,
    v_status,
    p_evaluated_at,
    v_record,
    v_blocker_refs,
    v_owner_outcome_ref,
    v_reason;
END;
$retention_evaluation$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "privacy"."process_retention_evaluation_work"(uuid,uuid,text,uuid,timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "privacy"."process_retention_evaluation_work"(uuid,uuid,text,uuid,timestamptz) TO "ontos_runtime";
