DO $fix_retention_evaluation_jsonb_comparisons$
DECLARE
  routine_definition text;
  original_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'privacy.process_retention_evaluation_work(uuid,uuid,text,uuid,timestamptz)'::regprocedure
  )
  INTO routine_definition;
  original_definition := routine_definition;

  routine_definition := replace(
    routine_definition,
    'v_record->''contentScopeRefs''',
    '(v_record->''contentScopeRefs'')'
  );
  routine_definition := replace(
    routine_definition,
    'decision.decision_record->''contentScopeRefs''',
    '(decision.decision_record->''contentScopeRefs'')'
  );
  routine_definition := replace(
    routine_definition,
    'dispatch.handoff_record->''contentScopeRefs''',
    '(dispatch.handoff_record->''contentScopeRefs'')'
  );

  IF routine_definition = original_definition
     OR routine_definition LIKE '%decision.decision_record->''contentScopeRefs'' @> v_record->''contentScopeRefs''%'
     OR routine_definition LIKE '%dispatch.handoff_record->''contentScopeRefs'' @> v_record->''contentScopeRefs''%'
  THEN
    RAISE EXCEPTION 'privacy retention evaluation JSONB comparison repair did not apply';
  END IF;

  EXECUTE routine_definition;
END;
$fix_retention_evaluation_jsonb_comparisons$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "privacy"."process_retention_evaluation_work"(uuid,uuid,text,uuid,timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "privacy"."process_retention_evaluation_work"(uuid,uuid,text,uuid,timestamptz) TO "ontos_runtime";
