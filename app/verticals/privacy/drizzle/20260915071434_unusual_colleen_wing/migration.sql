ALTER TABLE "privacy"."disposition_decisions" DROP CONSTRAINT "privacy_disposition_decisions_outcome_ck", ADD CONSTRAINT "privacy_disposition_decisions_outcome_ck" CHECK ("outcome" in ('RETAIN', 'RESTRICT', 'ANONYMIZE', 'DELETE'));
--> statement-breakpoint
DO $privacy_retention_followup$
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
    $old$  v_evaluated_text text;$old$,
    $new$  v_evaluated_text text;
  v_evaluation_outcome text;
  v_policy_ref text;
  v_policy_version integer;
  v_controller_ref text;
  v_provenance_ref text;
  v_evidence_refs text[] := ARRAY[]::text[];$new$
  );
  IF replaced_definition = function_definition THEN
    RAISE EXCEPTION 'Privacy retention evaluation routine declaration shape changed';
  END IF;
  function_definition := replaced_definition;

  replaced_definition := replace(
    function_definition,
    $old$  v_record := jsonb_set(v_record, '{status}', to_jsonb(v_status), true);$old$,
    $new$  IF v_result = 'EVALUATED' THEN
    v_evaluation_outcome := v_current_rule.rule_record->>'dispositionOutcome';
    v_policy_ref := v_current_rule.rule_record->>'policyRef';
    v_controller_ref := v_current_rule.rule_record->>'controllerRef';
    v_provenance_ref := v_current_rule.rule_record->>'provenanceRef';
    IF (v_current_rule.rule_record->>'policyVersion') ~ '^[1-9][0-9]*$'
       AND char_length(v_current_rule.rule_record->>'policyVersion') <= 10
       AND (v_current_rule.rule_record->>'policyVersion')::numeric <= 2147483647
    THEN
      v_policy_version := (v_current_rule.rule_record->>'policyVersion')::integer;
    END IF;
    IF v_evaluation_outcome NOT IN ('RETAIN', 'RESTRICT', 'ANONYMIZE', 'DELETE')
       OR v_policy_ref IS NULL OR char_length(btrim(v_policy_ref)) NOT BETWEEN 1 AND 300
       OR v_policy_version IS NULL OR v_controller_ref IS NULL
       OR char_length(btrim(v_controller_ref)) NOT BETWEEN 1 AND 300
       OR v_provenance_ref IS NULL OR char_length(btrim(v_provenance_ref)) NOT BETWEEN 1 AND 300
       OR jsonb_typeof(v_current_rule.rule_record->'evidenceRefs') IS DISTINCT FROM 'array'
       OR (CASE
            WHEN jsonb_typeof(v_current_rule.rule_record->'evidenceRefs') = 'array'
            THEN jsonb_array_length(v_current_rule.rule_record->'evidenceRefs')
            ELSE 0
          END) = 0
       OR EXISTS (
         SELECT 1
         FROM jsonb_array_elements(v_current_rule.rule_record->'evidenceRefs') AS evidence(value)
         WHERE jsonb_typeof(evidence.value) IS DISTINCT FROM 'string'
            OR char_length(btrim(evidence.value #>> '{}')) NOT BETWEEN 1 AND 300
       )
    THEN
      v_result := 'STATE_UNAVAILABLE';
      v_status := 'INDETERMINATE';
      v_reason := 'AUTHORITATIVE_EVALUATION_INCOMPLETE';
    ELSE
      v_evidence_refs := ARRAY(
        SELECT jsonb_array_elements_text(v_current_rule.rule_record->'evidenceRefs')
        ORDER BY 1
      );
    END IF;
  END IF;

  v_record := jsonb_set(v_record, '{status}', to_jsonb(v_status), true);$new$
  );
  IF replaced_definition = function_definition THEN
    RAISE EXCEPTION 'Privacy retention evaluation routine evaluation boundary changed';
  END IF;
  function_definition := replaced_definition;

  replaced_definition := replace(
    function_definition,
    $old$      'blockerRefs', to_jsonb(v_blocker_refs),$old$,
    $new$      'blockerRefs', to_jsonb(v_blocker_refs),
      'controllerRef', v_controller_ref,
      'evaluationRef', v_work.work_ref,
      'evidenceRefs', to_jsonb(v_evidence_refs),
      'outcome', v_evaluation_outcome,
      'policyRef', v_policy_ref,
      'policyVersion', v_policy_version,
      'provenanceRef', v_provenance_ref,$new$
  );
  IF replaced_definition = function_definition THEN
    RAISE EXCEPTION 'Privacy retention evaluation routine evidence shape changed';
  END IF;

  EXECUTE replaced_definition;
END;
$privacy_retention_followup$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "privacy"."process_retention_evaluation_work"(uuid,uuid,text,uuid,timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "privacy"."process_retention_evaluation_work"(uuid,uuid,text,uuid,timestamptz) TO "ontos_runtime";
