ALTER TABLE "privacy"."legal_holds" ADD CONSTRAINT "privacy_legal_holds_governance_ck" CHECK (jsonb_typeof("hold_record") = 'object'
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
        and (("hold_record"->>'releasedAt' is null
          and "hold_record"->>'releaseRef' is null
          and "hold_record"->>'releaseReasonRef' is null
          and "hold_record"->>'releasedByPrincipalRef' is null
          and coalesce(jsonb_array_length("hold_record"->'releaseEvidenceRefs'), 0) = 0)
          or ("hold_record"->>'releasedAt' is not null
            and "hold_record"->>'releaseConditionRef' is not null
            and "hold_record"->>'releaseRef' is not null
            and "hold_record"->>'releaseReasonRef' is not null
            and "hold_record"->>'releasedByPrincipalRef' is not null
            and jsonb_typeof("hold_record"->'releaseEvidenceRefs') = 'array'
            and jsonb_array_length("hold_record"->'releaseEvidenceRefs') > 0))
        and (("hold_record"->>'reviewedAt' is not null)
          or coalesce(jsonb_array_length("hold_record"->'reviewEvidenceRefs'), 0) = 0));--> statement-breakpoint
ALTER TABLE "privacy"."retention_exceptions" ADD CONSTRAINT "privacy_retention_exceptions_governance_ck" CHECK (jsonb_typeof("exception_record") = 'object'
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
        and (("exception_record"->>'releasedAt' is null
          and "exception_record"->>'releaseRef' is null
          and "exception_record"->>'releaseReasonRef' is null
          and "exception_record"->>'releasedByPrincipalRef' is null
          and coalesce(jsonb_array_length("exception_record"->'releaseEvidenceRefs'), 0) = 0)
          or ("exception_record"->>'releasedAt' is not null
            and "exception_record"->>'releaseConditionRef' is not null
            and "exception_record"->>'releaseRef' is not null
            and "exception_record"->>'releaseReasonRef' is not null
            and "exception_record"->>'releasedByPrincipalRef' is not null
            and jsonb_typeof("exception_record"->'releaseEvidenceRefs') = 'array'
            and jsonb_array_length("exception_record"->'releaseEvidenceRefs') > 0))
        and (("exception_record"->>'reviewedAt' is not null)
          or coalesce(jsonb_array_length("exception_record"->'reviewEvidenceRefs'), 0) = 0));
--> statement-breakpoint
DO $privacy_retention_governance_reproof$
DECLARE
  function_definition text;
  replaced_definition text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(function_record.oid)
    INTO function_definition
    FROM pg_catalog.pg_proc AS function_record
    JOIN pg_catalog.pg_namespace AS namespace_record
      ON namespace_record.oid = function_record.pronamespace
   WHERE namespace_record.nspname = 'privacy'
     AND function_record.proname = 'process_retention_evaluation_work'
     AND function_record.pronargs = 5;

  IF function_definition IS NULL THEN
    RAISE EXCEPTION 'Privacy retention evaluation routine is missing';
  END IF;

  replaced_definition := replace(
    function_definition,
    $needle$OR latest.exception_record->>'exceptionRef' IS DISTINCT FROM latest.exception_ref$needle$,
    $replacement$OR latest.exception_record->>'exceptionRef' IS DISTINCT FROM latest.exception_ref
        OR latest.exception_record->>'authorityKind' IS DISTINCT FROM 'EXCEPTION_AUTHORITY'
        OR char_length(coalesce(btrim(latest.exception_record->>'authorityRef'), '')) NOT BETWEEN 1 AND 300
        OR char_length(coalesce(btrim(latest.exception_record->>'controllerRef'), '')) NOT BETWEEN 1 AND 300
        OR char_length(coalesce(btrim(latest.exception_record->>'policyRef'), '')) NOT BETWEEN 1 AND 300
        OR coalesce(latest.exception_record->>'policyVersion', '') !~ '^[1-9][0-9]*$'
        OR char_length(coalesce(btrim(latest.exception_record->>'provenanceRef'), '')) NOT BETWEEN 1 AND 300
        OR char_length(coalesce(btrim(latest.exception_record->>'reasonTypeRef'), '')) NOT BETWEEN 1 AND 300
        OR coalesce(latest.exception_record->>'reasonTypeVersion', '') !~ '^[1-9][0-9]*$'
        OR char_length(coalesce(btrim(latest.exception_record->>'reviewRef'), '')) NOT BETWEEN 1 AND 300
        OR jsonb_typeof(latest.exception_record->'evidenceRefs') IS DISTINCT FROM 'array'
        OR coalesce(jsonb_array_length(latest.exception_record->'evidenceRefs'), 0) = 0
        OR (latest.exception_record->>'releasedAt' IS NULL AND (
          latest.exception_record->>'releaseRef' IS NOT NULL
          OR latest.exception_record->>'releaseReasonRef' IS NOT NULL
          OR latest.exception_record->>'releasedByPrincipalRef' IS NOT NULL
          OR coalesce(jsonb_array_length(latest.exception_record->'releaseEvidenceRefs'), 0) <> 0
        ))
        OR (latest.exception_record->>'releasedAt' IS NOT NULL AND (
          latest.exception_record->>'releaseConditionRef' IS NULL
          OR latest.exception_record->>'releaseRef' IS NULL
          OR latest.exception_record->>'releaseReasonRef' IS NULL
          OR latest.exception_record->>'releasedByPrincipalRef' IS NULL
          OR jsonb_typeof(latest.exception_record->'releaseEvidenceRefs') IS DISTINCT FROM 'array'
          OR coalesce(jsonb_array_length(latest.exception_record->'releaseEvidenceRefs'), 0) = 0
        ))
        OR (latest.exception_record->>'reviewedAt' IS NOT NULL AND (
          jsonb_typeof(latest.exception_record->'reviewEvidenceRefs') IS DISTINCT FROM 'array'
          OR coalesce(jsonb_array_length(latest.exception_record->'reviewEvidenceRefs'), 0) = 0
        ))
        OR (latest.exception_record->>'reviewedAt' IS NULL
          AND coalesce(jsonb_array_length(latest.exception_record->'reviewEvidenceRefs'), 0) <> 0)$replacement$
  );
  IF replaced_definition = function_definition THEN
    RAISE EXCEPTION 'Privacy retention exception governance validation boundary changed';
  END IF;
  function_definition := replaced_definition;

  replaced_definition := replace(
    function_definition,
    $needle$OR latest.hold_record->>'holdRef' IS DISTINCT FROM latest.hold_ref$needle$,
    $replacement$OR latest.hold_record->>'holdRef' IS DISTINCT FROM latest.hold_ref
        OR latest.hold_record->>'authorityKind' IS DISTINCT FROM 'LEGAL_HOLD_AUTHORITY'
        OR char_length(coalesce(btrim(latest.hold_record->>'authorityRef'), '')) NOT BETWEEN 1 AND 300
        OR char_length(coalesce(btrim(latest.hold_record->>'controllerRef'), '')) NOT BETWEEN 1 AND 300
        OR char_length(coalesce(btrim(latest.hold_record->>'policyRef'), '')) NOT BETWEEN 1 AND 300
        OR coalesce(latest.hold_record->>'policyVersion', '') !~ '^[1-9][0-9]*$'
        OR char_length(coalesce(btrim(latest.hold_record->>'provenanceRef'), '')) NOT BETWEEN 1 AND 300
        OR char_length(coalesce(btrim(latest.hold_record->>'reasonTypeRef'), '')) NOT BETWEEN 1 AND 300
        OR coalesce(latest.hold_record->>'reasonTypeVersion', '') !~ '^[1-9][0-9]*$'
        OR char_length(coalesce(btrim(latest.hold_record->>'reviewRef'), '')) NOT BETWEEN 1 AND 300
        OR jsonb_typeof(latest.hold_record->'evidenceRefs') IS DISTINCT FROM 'array'
        OR coalesce(jsonb_array_length(latest.hold_record->'evidenceRefs'), 0) = 0
        OR (latest.hold_record->>'releasedAt' IS NULL AND (
          latest.hold_record->>'releaseRef' IS NOT NULL
          OR latest.hold_record->>'releaseReasonRef' IS NOT NULL
          OR latest.hold_record->>'releasedByPrincipalRef' IS NOT NULL
          OR coalesce(jsonb_array_length(latest.hold_record->'releaseEvidenceRefs'), 0) <> 0
        ))
        OR (latest.hold_record->>'releasedAt' IS NOT NULL AND (
          latest.hold_record->>'releaseConditionRef' IS NULL
          OR latest.hold_record->>'releaseRef' IS NULL
          OR latest.hold_record->>'releaseReasonRef' IS NULL
          OR latest.hold_record->>'releasedByPrincipalRef' IS NULL
          OR jsonb_typeof(latest.hold_record->'releaseEvidenceRefs') IS DISTINCT FROM 'array'
          OR coalesce(jsonb_array_length(latest.hold_record->'releaseEvidenceRefs'), 0) = 0
        ))
        OR (latest.hold_record->>'reviewedAt' IS NOT NULL AND (
          jsonb_typeof(latest.hold_record->'reviewEvidenceRefs') IS DISTINCT FROM 'array'
          OR coalesce(jsonb_array_length(latest.hold_record->'reviewEvidenceRefs'), 0) = 0
        ))
        OR (latest.hold_record->>'reviewedAt' IS NULL
          AND coalesce(jsonb_array_length(latest.hold_record->'reviewEvidenceRefs'), 0) <> 0)$replacement$
  );
  IF replaced_definition = function_definition THEN
    RAISE EXCEPTION 'Privacy legal hold governance validation boundary changed';
  END IF;

  EXECUTE replaced_definition;
END;
$privacy_retention_governance_reproof$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "privacy"."process_retention_evaluation_work"(uuid,uuid,text,uuid,timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "privacy"."process_retention_evaluation_work"(uuid,uuid,text,uuid,timestamptz) TO "ontos_runtime";
--> statement-breakpoint
DO $privacy_retention_decision_binding_reproof$
DECLARE
  function_definition text;
  replaced_definition text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(function_record.oid)
    INTO function_definition
    FROM pg_catalog.pg_proc AS function_record
    JOIN pg_catalog.pg_namespace AS namespace_record
      ON namespace_record.oid = function_record.pronamespace
   WHERE namespace_record.nspname = 'privacy'
     AND function_record.proname = 'process_retention_evaluation_work'
     AND function_record.pronargs = 5;

  IF function_definition IS NULL THEN
    RAISE EXCEPTION 'Privacy retention evaluation routine is missing';
  END IF;

  replaced_definition := replace(
    function_definition,
    $needle$OR decision.decision_record->>'outcome' IS DISTINCT FROM decision.outcome$needle$,
    $replacement$OR decision.decision_record->>'outcome' IS DISTINCT FROM decision.outcome
        OR decision.decision_record->>'evaluationRef' IS DISTINCT FROM v_work.work_ref
        OR decision.decision_record->>'controllerRef' IS DISTINCT FROM v_record->>'controllerRef'
        OR decision.decision_record->>'policyRef' IS DISTINCT FROM v_record->>'policyRef'
        OR decision.decision_record->'policyVersion' IS DISTINCT FROM v_record->'policyVersion'
        OR decision.decision_record->>'provenanceRef' IS DISTINCT FROM v_record->>'provenanceRef'$replacement$
  );
  IF replaced_definition = function_definition THEN
    RAISE EXCEPTION 'Privacy disposition decision binding validation boundary changed';
  END IF;
  function_definition := replaced_definition;

  replaced_definition := regexp_replace(
    function_definition,
    $regex$AND jsonb_array_length\(\(decision\.decision_record->'contentScopeRefs'\)\) =$regex$,
    $replacement$AND decision.decided_at <= p_evaluated_at
        AND decision.decision_record->>'evaluationRef' = v_work.work_ref
        AND decision.decision_record->>'controllerRef' = v_record->>'controllerRef'
        AND decision.decision_record->>'policyRef' = v_record->>'policyRef'
        AND decision.decision_record->'policyVersion' = v_record->'policyVersion'
        AND decision.decision_record->>'provenanceRef' = v_record->>'provenanceRef'
        AND jsonb_array_length((decision.decision_record->'contentScopeRefs')) =$replacement$,
    'g'
  );
  IF replaced_definition = function_definition THEN
    RAISE EXCEPTION 'Privacy disposition decision scope binding boundary changed';
  END IF;

  EXECUTE replaced_definition;
END;
$privacy_retention_decision_binding_reproof$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "privacy"."process_retention_evaluation_work"(uuid,uuid,text,uuid,timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "privacy"."process_retention_evaluation_work"(uuid,uuid,text,uuid,timestamptz) TO "ontos_runtime";
