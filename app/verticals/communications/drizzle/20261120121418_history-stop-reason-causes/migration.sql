-- A stop is shown under its SPECIFIC closed reason in the history (#1406, #1409): a source lifecycle stop is stored as the category
-- `SOURCE_STALE` with the cause that names which fact it was (expired, consumed, revoked, superseded, not resumable, no longer valid),
-- and the read routine used to return the category alone, so the history could not tell them apart. It now returns each stop reason as
-- its category AND cause, and the owner derives the one closed code it shows from them (one derivation in `stopReasonCodeOf`).
-- Forward only: the released read routine is replaced in place (same signature, same grants); only the shape of `stops` changes.
CREATE OR REPLACE FUNCTION "communications"."worker_read_intent"(p_tenant_id uuid, p_intent_id uuid)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM "communications"."assert_worker_scope"(p_tenant_id);
  RETURN QUERY
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'intent', jsonb_build_object(
      'intentId', intent."intent_id",
      'intentKey', intent."intent_key",
      'status', intent."status",
      'slotKey', intent."slot_key",
      'recipientRole', intent."recipient_role",
      'purpose', intent."purpose",
      'typeId', intent."type_id",
      'typeRevision', intent."type_revision",
      'originalBinding', intent."original_binding",
      'handoffPin', intent."handoff_pin",
      'endpointPin', intent."endpoint_pin",
      'processingScope', intent."processing_scope",
      'languageDecision', intent."language_decision"),
    'request', jsonb_build_object(
      'requestId', request."request_id",
      'payload', request."payload"),
    'attempts', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'attemptId', attempt."attempt_id",
        'attemptNumber', attempt."attempt_number",
        'state', attempt."state",
        'reason', attempt."evidence" ->> 'reason',
        'preparedAt', to_char(attempt."prepared_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'finishedAt', to_char(attempt."finished_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
        ORDER BY attempt."attempt_number")
      FROM "communications"."delivery_attempts" AS attempt
      WHERE attempt."tenant_id" = intent."tenant_id" AND attempt."intent_id" = intent."intent_id"), '[]'::jsonb),
    'observations', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'observationId', observation."observation_id",
        'attemptId', observation."attempt_id",
        'kind', observation."kind",
        'failureClass', observation."evidence" ->> 'failureClass',
        'observedAt', to_char(observation."observed_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'recordedAt', to_char(observation."recorded_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'recordedSeq', observation."recorded_seq")
        ORDER BY observation."recorded_seq")
      FROM "communications"."provider_observations" AS observation
      WHERE observation."tenant_id" = intent."tenant_id" AND observation."intent_id" = intent."intent_id"), '[]'::jsonb),
    'conflicts', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'conflictId', conflict."conflict_id",
        'observationId', conflict."observation_id",
        'attemptId', conflict."attempt_id",
        'kind', conflict."kind",
        'observedAt', to_char(conflict."observed_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'recordedAt', to_char(conflict."recorded_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'recordedSeq', conflict."recorded_seq",
        'resolvedAt', to_char(resolution."resolved_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
        ORDER BY conflict."recorded_seq")
      FROM "communications"."provider_observation_conflicts" AS conflict
      LEFT JOIN "communications"."provider_observation_conflict_resolutions" AS resolution
        ON resolution."tenant_id" = conflict."tenant_id" AND resolution."conflict_id" = conflict."conflict_id"
      WHERE conflict."tenant_id" = intent."tenant_id" AND conflict."intent_id" = intent."intent_id"), '[]'::jsonb),
    'stops', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'evaluationSeq', stop."evaluation_seq",
        'proven', stop."proven",
        'recordedAt', to_char(stop."recorded_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'reasons', coalesce((SELECT jsonb_agg(jsonb_build_object('category', reason."value" ->> 'category', 'cause', reason."value" ->> 'cause')) FROM jsonb_array_elements(stop."reasons") AS reason("value")), '[]'::jsonb))
        ORDER BY stop."evaluation_seq")
      FROM "communications"."intent_handoff_stops" AS stop
      WHERE stop."tenant_id" = intent."tenant_id" AND stop."intent_id" = intent."intent_id"), '[]'::jsonb),
    'recoveries', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'evaluationSeq', evaluation."evaluation_seq",
        'basisAttemptId', evaluation."basis_attempt_id",
        'outcome', evaluation."outcome",
        'code', evaluation."code",
        'proven', evaluation."proven",
        'recordedAt', to_char(evaluation."evaluated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
        ORDER BY evaluation."evaluation_seq")
      FROM "communications"."intent_recovery_evaluations" AS evaluation
      WHERE evaluation."tenant_id" = intent."tenant_id" AND evaluation."intent_id" = intent."intent_id"), '[]'::jsonb),
    'documents', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'position', pin."position",
        'document', jsonb_build_object('moduleId', pin."document_module", 'resourceType', pin."document_type", 'resourceId', pin."document_id"),
        'assetRef', jsonb_build_object('moduleId', pin."asset_module", 'resourceType', pin."asset_type", 'resourceId', pin."asset_id"),
        'classification', pin."classification",
        'form', pin."form",
        'revision', pin."revision")
        ORDER BY pin."position")
      FROM "communications"."intent_document_pins" AS pin
      WHERE pin."tenant_id" = intent."tenant_id" AND pin."intent_id" = intent."intent_id"), '[]'::jsonb)))
  FROM "communications"."message_intents" AS intent
  JOIN "communications"."communication_requests" AS request
    ON request."tenant_id" = intent."tenant_id" AND request."request_id" = intent."request_id"
  WHERE intent."tenant_id" = p_tenant_id AND intent."intent_id" = p_intent_id;
END;
$$;
