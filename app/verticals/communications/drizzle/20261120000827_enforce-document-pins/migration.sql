-- Document pins (#1409): forced Tenant isolation, least-privilege grants, an append-only guard and the scoped routines that
-- write and read the pin of a document of one Message Intent. Typed Drizzle owns the table, its keys, checks and policies in the
-- preceding generated migration. Forward only: the released read routine is replaced in place (same signature, same grants).
--
-- The table is written ONLY by `worker_pin_document`, so the runtime role can read it and nothing else. It is append-only
-- whatever the role: a pin is never edited, repointed or removed, which is how history never silently repoints and how a
-- Technical Retry keeps handing off the SAME Asset.
ALTER TABLE "communications"."intent_document_pins" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "communications"."intent_document_pins" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT SELECT ON TABLE "communications"."intent_document_pins" TO "ontos_runtime";
--> statement-breakpoint
CREATE TRIGGER "communications_document_pins_append_only" BEFORE UPDATE OR DELETE ON "communications"."intent_document_pins" FOR EACH ROW EXECUTE FUNCTION "communications"."reject_intake_fact_mutation"();
--> statement-breakpoint
-- The ONE read of the pre-handoff and recovery step, now with the pinned documents of the intent (references and a form only).
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
        'categories', coalesce((SELECT jsonb_agg(reason."value" ->> 'category') FROM jsonb_array_elements(stop."reasons") AS reason("value")), '[]'::jsonb))
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
--> statement-breakpoint
-- Pins ONE document of an intent: the first writer wins and the stored pin is always what is returned, so a second caller (or a
-- retry that resolved another Asset) adopts what was pinned and nothing is ever repointed. The Asset must be a Core Media Asset
-- V1 (the table checks it too). Outcomes: PINNED (this call stored it), EXISTS (a pin of that position was already stored),
-- MISSING (no such intent in this Tenant). The answer always carries the stored pin.
CREATE FUNCTION "communications"."worker_pin_document"(
  p_tenant_id uuid, p_intent_id uuid, p_position integer,
  p_document_module text, p_document_type text, p_document_id text, p_classification text, p_form text,
  p_asset_module text, p_asset_type text, p_asset_id text, p_revision integer
)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  inserted integer;
  pin "communications"."intent_document_pins"%ROWTYPE;
BEGIN
  PERFORM "communications"."assert_worker_scope"(p_tenant_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('communications.intent-handoff:' || p_tenant_id::text || ':' || p_intent_id::text, 0));
  IF NOT EXISTS (SELECT 1 FROM "communications"."message_intents" WHERE "tenant_id" = p_tenant_id AND "intent_id" = p_intent_id) THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'MISSING');
    RETURN;
  END IF;
  INSERT INTO "communications"."intent_document_pins" (
    "tenant_id", "intent_id", "position", "document_module", "document_type", "document_id", "classification", "form",
    "asset_module", "asset_type", "asset_id", "revision", "pinned_at")
  VALUES (
    p_tenant_id, p_intent_id, p_position, p_document_module, p_document_type, p_document_id, p_classification, p_form,
    p_asset_module, p_asset_type, p_asset_id, p_revision, clock_timestamp())
  ON CONFLICT ("tenant_id", "intent_id", "position") DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  SELECT * INTO pin FROM "communications"."intent_document_pins" AS stored
    WHERE stored."tenant_id" = p_tenant_id AND stored."intent_id" = p_intent_id AND stored."position" = p_position;
  RETURN QUERY SELECT jsonb_build_object(
    'outcome', CASE WHEN inserted = 1 THEN 'PINNED' ELSE 'EXISTS' END,
    'pin', jsonb_build_object(
      'position', pin."position",
      'document', jsonb_build_object('moduleId', pin."document_module", 'resourceType', pin."document_type", 'resourceId', pin."document_id"),
      'assetRef', jsonb_build_object('moduleId', pin."asset_module", 'resourceType', pin."asset_type", 'resourceId', pin."asset_id"),
      'classification', pin."classification",
      'form', pin."form",
      'revision', pin."revision"));
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "communications"."worker_pin_document"(uuid, uuid, integer, text, text, text, text, text, text, text, text, integer) FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "communications"."worker_pin_document"(uuid, uuid, integer, text, text, text, text, text, text, text, text, integer) TO "ontos_runtime";
