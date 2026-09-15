ALTER TABLE "privacy"."legal_holds" DROP CONSTRAINT "privacy_legal_holds_governance_ck", ADD CONSTRAINT "privacy_legal_holds_governance_ck" CHECK (jsonb_typeof("hold_record") = 'object'
        and "hold_record"->>'holdRef' = "hold_ref"
        and "hold_record"->>'authorityKind' = 'LEGAL_HOLD_AUTHORITY'
        and char_length(coalesce(btrim("hold_record"->>'authorityRef'), '')) between 1 and 300
        and char_length(coalesce(btrim("hold_record"->>'controllerRef'), '')) between 1 and 300
        and char_length(coalesce(btrim("hold_record"->>'policyRef'), '')) between 1 and 300
        and coalesce("hold_record"->>'policyVersion', '') ~ '^[1-9][0-9]*$'
        and char_length(coalesce(btrim("hold_record"->>'provenanceRef'), '')) between 1 and 300
        and char_length(coalesce(btrim("hold_record"->>'reasonTypeRef'), '')) between 1 and 300
        and coalesce("hold_record"->>'reasonTypeVersion', '') ~ '^[1-9][0-9]*$'
        and char_length(coalesce(btrim("hold_record"->>'reviewRef'), '')) between 1 and 300
        and jsonb_typeof("hold_record"->'evidenceRefs') = 'array'
        and jsonb_array_length("hold_record"->'evidenceRefs') > 0
        and jsonb_typeof("hold_record"->'releaseEvidenceRefs') = 'array'
        and (("hold_record"->>'releasedAt' is null and "released_at" is null)
          or ("hold_record"->>'releasedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$'
            and "released_at" is not null
            and ("hold_record"->>'releasedAt')::timestamptz = "released_at"))
        and (("hold_record"->>'releasedAt' is null
          and "hold_record"->>'releaseRef' is null
          and "hold_record"->>'releaseReasonRef' is null
          and "hold_record"->>'releasedByPrincipalRef' is null
          and jsonb_array_length("hold_record"->'releaseEvidenceRefs') = 0)
          or ("hold_record"->>'releasedAt' is not null
            and char_length(coalesce(btrim("hold_record"->>'releaseConditionRef'), '')) between 1 and 300
            and char_length(coalesce(btrim("hold_record"->>'releaseRef'), '')) between 1 and 300
            and char_length(coalesce(btrim("hold_record"->>'releaseReasonRef'), '')) between 1 and 300
            and char_length(coalesce(btrim("hold_record"->>'releasedByPrincipalRef'), '')) between 1 and 300
            and jsonb_array_length("hold_record"->'releaseEvidenceRefs') > 0))
        and (("hold_record"->>'reviewedAt' is not null)
          or coalesce(jsonb_array_length("hold_record"->'reviewEvidenceRefs'), 0) = 0));--> statement-breakpoint
ALTER TABLE "privacy"."retention_exceptions" DROP CONSTRAINT "privacy_retention_exceptions_governance_ck", ADD CONSTRAINT "privacy_retention_exceptions_governance_ck" CHECK (jsonb_typeof("exception_record") = 'object'
        and "exception_record"->>'exceptionRef' = "exception_ref"
        and "exception_record"->>'authorityKind' = 'EXCEPTION_AUTHORITY'
        and char_length(coalesce(btrim("exception_record"->>'authorityRef'), '')) between 1 and 300
        and char_length(coalesce(btrim("exception_record"->>'controllerRef'), '')) between 1 and 300
        and char_length(coalesce(btrim("exception_record"->>'policyRef'), '')) between 1 and 300
        and coalesce("exception_record"->>'policyVersion', '') ~ '^[1-9][0-9]*$'
        and char_length(coalesce(btrim("exception_record"->>'provenanceRef'), '')) between 1 and 300
        and char_length(coalesce(btrim("exception_record"->>'reasonTypeRef'), '')) between 1 and 300
        and coalesce("exception_record"->>'reasonTypeVersion', '') ~ '^[1-9][0-9]*$'
        and char_length(coalesce(btrim("exception_record"->>'reviewRef'), '')) between 1 and 300
        and jsonb_typeof("exception_record"->'evidenceRefs') = 'array'
        and jsonb_array_length("exception_record"->'evidenceRefs') > 0
        and jsonb_typeof("exception_record"->'releaseEvidenceRefs') = 'array'
        and (("exception_record"->>'releasedAt' is null and "released_at" is null)
          or ("exception_record"->>'releasedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$'
            and "released_at" is not null
            and ("exception_record"->>'releasedAt')::timestamptz = "released_at"))
        and (("exception_record"->>'releasedAt' is null
          and "exception_record"->>'releaseRef' is null
          and "exception_record"->>'releaseReasonRef' is null
          and "exception_record"->>'releasedByPrincipalRef' is null
          and jsonb_array_length("exception_record"->'releaseEvidenceRefs') = 0)
          or ("exception_record"->>'releasedAt' is not null
            and char_length(coalesce(btrim("exception_record"->>'releaseConditionRef'), '')) between 1 and 300
            and char_length(coalesce(btrim("exception_record"->>'releaseRef'), '')) between 1 and 300
            and char_length(coalesce(btrim("exception_record"->>'releaseReasonRef'), '')) between 1 and 300
            and char_length(coalesce(btrim("exception_record"->>'releasedByPrincipalRef'), '')) between 1 and 300
            and jsonb_array_length("exception_record"->'releaseEvidenceRefs') > 0))
        and (("exception_record"->>'reviewedAt' is not null)
          or coalesce(jsonb_array_length("exception_record"->'reviewEvidenceRefs'), 0) = 0));
--> statement-breakpoint
DO $privacy_retention_authoritative_due_reproof$
DECLARE
  function_definition text;
  replaced_definition text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'privacy.process_retention_evaluation_work(uuid,uuid,text,uuid,timestamptz)'::regprocedure
  )
  INTO function_definition;

  replaced_definition := replace(
    function_definition,
    $needle$  v_evidence_refs text[] := ARRAY[]::text[];$needle$,
    $replacement$  v_evidence_refs text[] := ARRAY[]::text[];
  v_authoritative_due_at timestamptz;
  v_business_start_at timestamptz;
  v_duration_days integer;
  v_work_record_due_at timestamptz;$replacement$
  );
  IF replaced_definition = function_definition THEN
    RAISE EXCEPTION 'Privacy retention due-at declaration boundary changed';
  END IF;
  function_definition := replaced_definition;

  replaced_definition := replace(
    function_definition,
    $needle$  IF v_result = 'EVALUATED' AND v_work.due_at > p_evaluated_at THEN$needle$,
    $replacement$  IF v_result = 'EVALUATED' THEN
    SELECT count(*)::integer
    INTO v_count
    FROM privacy.retention_rules AS rule
    WHERE rule.tenant_id = p_tenant_id
      AND rule.legal_entity_id = p_legal_entity_id
      AND rule.rule_ref = v_work.rule_ref
      AND rule.rule_version = v_work.rule_version;

    IF v_count = 0 THEN
      v_result := 'STATE_UNAVAILABLE';
      v_reason := 'AUTHORITATIVE_DUE_RULE_UNAVAILABLE';
    ELSIF v_count <> 1 THEN
      v_result := 'STATE_AMBIGUOUS';
      v_reason := 'AUTHORITATIVE_DUE_RULE_AMBIGUOUS';
    ELSE
      SELECT rule.*
      INTO v_due_rule
      FROM privacy.retention_rules AS rule
      WHERE rule.tenant_id = p_tenant_id
        AND rule.legal_entity_id = p_legal_entity_id
        AND rule.rule_ref = v_work.rule_ref
        AND rule.rule_version = v_work.rule_version;

      IF jsonb_typeof(v_due_rule.rule_record) IS DISTINCT FROM 'object'
         OR v_due_rule.rule_record->>'businessStartAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$'
         OR jsonb_typeof(v_due_rule.rule_record->'retentionWindow') IS DISTINCT FROM 'object'
         OR v_due_rule.rule_record#>>'{retentionWindow,kind}' NOT IN ('DURATION', 'END_AT')
      THEN
        v_result := 'STATE_UNAVAILABLE';
        v_reason := 'AUTHORITATIVE_DUE_INPUT_INVALID';
      ELSE
        BEGIN
          v_business_start_at := (v_due_rule.rule_record->>'businessStartAt')::timestamptz;
          IF v_due_rule.rule_record#>>'{retentionWindow,kind}' = 'DURATION' THEN
            IF jsonb_typeof(v_due_rule.rule_record#>'{retentionWindow,durationDays}') IS DISTINCT FROM 'number'
               OR v_due_rule.rule_record#>>'{retentionWindow,durationDays}' !~ '^[1-9][0-9]*$'
               OR char_length(v_due_rule.rule_record#>>'{retentionWindow,durationDays}') > 10
               OR (v_due_rule.rule_record#>>'{retentionWindow,durationDays}')::numeric > 2147483647
            THEN
              v_result := 'STATE_UNAVAILABLE';
              v_reason := 'AUTHORITATIVE_DUE_INPUT_INVALID';
            ELSE
              v_duration_days := (v_due_rule.rule_record#>>'{retentionWindow,durationDays}')::integer;
              v_authoritative_due_at := v_business_start_at + make_interval(days => v_duration_days);
            END IF;
          ELSIF v_due_rule.rule_record#>>'{retentionWindow,endAt}'
              !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$'
          THEN
            v_result := 'STATE_UNAVAILABLE';
            v_reason := 'AUTHORITATIVE_DUE_INPUT_INVALID';
          ELSE
            v_authoritative_due_at := (v_due_rule.rule_record#>>'{retentionWindow,endAt}')::timestamptz;
          END IF;
        EXCEPTION
          WHEN datetime_field_overflow OR invalid_datetime_format THEN
            v_result := 'STATE_UNAVAILABLE';
            v_reason := 'AUTHORITATIVE_DUE_INPUT_INVALID';
        END;

        IF v_result = 'EVALUATED' THEN
          IF v_record->>'dueAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$' THEN
            v_result := 'STATE_AMBIGUOUS';
            v_reason := 'AUTHORITATIVE_DUE_AT_MISMATCH';
          ELSE
            BEGIN
              v_work_record_due_at := (v_record->>'dueAt')::timestamptz;
            EXCEPTION
              WHEN datetime_field_overflow OR invalid_datetime_format THEN
                v_result := 'STATE_AMBIGUOUS';
                v_reason := 'AUTHORITATIVE_DUE_AT_MISMATCH';
            END;
          END IF;
        END IF;

        IF v_result = 'EVALUATED'
           AND (v_record->>'businessStartAt' IS DISTINCT FROM v_due_rule.rule_record->>'businessStartAt'
             OR v_work_record_due_at IS DISTINCT FROM v_authoritative_due_at
             OR v_work.due_at IS DISTINCT FROM v_authoritative_due_at)
        THEN
          v_result := 'STATE_AMBIGUOUS';
          v_reason := 'AUTHORITATIVE_DUE_AT_MISMATCH';
        END IF;
      END IF;
    END IF;
  END IF;

  IF v_result = 'EVALUATED' AND v_work.due_at > p_evaluated_at THEN$replacement$
  );
  IF replaced_definition = function_definition THEN
    RAISE EXCEPTION 'Privacy retention authoritative due-at boundary changed';
  END IF;
  function_definition := replaced_definition;

  replaced_definition := replace(
    function_definition,
    $needle$        OR decision.decision_record->>'outcome' IS DISTINCT FROM decision.outcome$needle$,
    $replacement$        OR decision.decision_record->>'outcome' IS DISTINCT FROM decision.outcome
        OR decision.outcome IS DISTINCT FROM v_current_rule.rule_record->>'dispositionOutcome'
        OR decision.decision_record->>'outcome' IS DISTINCT FROM v_current_rule.rule_record->>'dispositionOutcome'$replacement$
  );
  IF replaced_definition = function_definition THEN
    RAISE EXCEPTION 'Privacy disposition outcome validation boundary changed';
  END IF;
  function_definition := replaced_definition;

  replaced_definition := replace(
    function_definition,
    $needle$        AND decision.decision_record->>'evaluationRef' = v_work.work_ref$needle$,
    $replacement$        AND decision.outcome = v_current_rule.rule_record->>'dispositionOutcome'
        AND decision.decision_record->>'outcome' = v_current_rule.rule_record->>'dispositionOutcome'
        AND decision.decision_record->>'evaluationRef' = v_work.work_ref$replacement$
  );
  IF replaced_definition = function_definition THEN
    RAISE EXCEPTION 'Privacy disposition outcome lookup boundary changed';
  END IF;
  function_definition := replaced_definition;

  replaced_definition := replace(
    function_definition,
    $needle$        OR coalesce(jsonb_array_length(latest.exception_record->'evidenceRefs'), 0) = 0$needle$,
    $replacement$        OR coalesce(jsonb_array_length(latest.exception_record->'evidenceRefs'), 0) = 0
        OR jsonb_typeof(latest.exception_record->'releaseEvidenceRefs') IS DISTINCT FROM 'array'
        OR (latest.exception_record->>'releasedAt' IS NULL AND latest.released_at IS NOT NULL)
        OR (latest.exception_record->>'releasedAt' IS NOT NULL AND (
          latest.released_at IS NULL
          OR latest.exception_record->>'releasedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$'
          OR (latest.exception_record->>'releasedAt')::timestamptz IS DISTINCT FROM latest.released_at
          OR char_length(coalesce(btrim(latest.exception_record->>'releaseConditionRef'), '')) NOT BETWEEN 1 AND 300
          OR char_length(coalesce(btrim(latest.exception_record->>'releaseRef'), '')) NOT BETWEEN 1 AND 300
          OR char_length(coalesce(btrim(latest.exception_record->>'releaseReasonRef'), '')) NOT BETWEEN 1 AND 300
          OR char_length(coalesce(btrim(latest.exception_record->>'releasedByPrincipalRef'), '')) NOT BETWEEN 1 AND 300
        ))$replacement$
  );
  IF replaced_definition = function_definition THEN
    RAISE EXCEPTION 'Privacy retention exception release governance boundary changed';
  END IF;
  function_definition := replaced_definition;

  replaced_definition := replace(
    function_definition,
    $needle$        OR coalesce(jsonb_array_length(latest.hold_record->'evidenceRefs'), 0) = 0$needle$,
    $replacement$        OR coalesce(jsonb_array_length(latest.hold_record->'evidenceRefs'), 0) = 0
        OR jsonb_typeof(latest.hold_record->'releaseEvidenceRefs') IS DISTINCT FROM 'array'
        OR (latest.hold_record->>'releasedAt' IS NULL AND latest.released_at IS NOT NULL)
        OR (latest.hold_record->>'releasedAt' IS NOT NULL AND (
          latest.released_at IS NULL
          OR latest.hold_record->>'releasedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$'
          OR (latest.hold_record->>'releasedAt')::timestamptz IS DISTINCT FROM latest.released_at
          OR char_length(coalesce(btrim(latest.hold_record->>'releaseConditionRef'), '')) NOT BETWEEN 1 AND 300
          OR char_length(coalesce(btrim(latest.hold_record->>'releaseRef'), '')) NOT BETWEEN 1 AND 300
          OR char_length(coalesce(btrim(latest.hold_record->>'releaseReasonRef'), '')) NOT BETWEEN 1 AND 300
          OR char_length(coalesce(btrim(latest.hold_record->>'releasedByPrincipalRef'), '')) NOT BETWEEN 1 AND 300
        ))$replacement$
  );
  IF replaced_definition = function_definition THEN
    RAISE EXCEPTION 'Privacy legal hold release governance boundary changed';
  END IF;

  EXECUTE replaced_definition;
END;
$privacy_retention_authoritative_due_reproof$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "privacy"."process_retention_evaluation_work"(uuid,uuid,text,uuid,timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "privacy"."process_retention_evaluation_work"(uuid,uuid,text,uuid,timestamptz) TO "ontos_runtime";
