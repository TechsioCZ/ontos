-- The document of one stored Privacy measure handoff also names the original Privacy dispatch invocation it was delivered
-- under (#1410, E19). The column was always written by `worker_record_privacy_measure_handoff` and is a Core correlation id,
-- never personal data. The human evidence Action needs it to name that exact dispatch in its continuation message, so Shell
-- can prove the dispatch natively instead of trusting a caller. Forward only: no table, row, grant or other routine changes.
CREATE OR REPLACE FUNCTION "communications"."privacy_measure_handoff_json"(p_handoff "communications"."privacy_measure_handoffs")
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'idempotencyKey', p_handoff."idempotency_key",
    'measureId', p_handoff."measure_id",
    'taskId', p_handoff."task_id",
    'sourceDecisionRef', p_handoff."source_decision_ref",
    'sourceDecisionRevision', p_handoff."source_decision_revision",
    'handoffFingerprint', p_handoff."handoff_fingerprint",
    'scopeDigest', p_handoff."scope_digest",
    'targetContentRefs', p_handoff."target_content_refs",
    'originatorInvocationId', p_handoff."originator_invocation_id",
    'receivedAt', to_char(p_handoff."received_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
$$;
