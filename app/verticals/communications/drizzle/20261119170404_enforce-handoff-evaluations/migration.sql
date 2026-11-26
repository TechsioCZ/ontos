-- Pre-handoff worker routines after review of #1401. Forward only: the committed routines stay as they were released.
-- 1. `worker_begin_attempt` refuses an intent that is not PENDING_HANDOFF itself (defense in depth: the worker checks it too)
--    and now carries the attempt NUMBER, so a stale caller can never write an attempt under a number it did not read.
--    The only finished attempt after which the NEXT number may begin is NOT_ATTEMPTED (no adapter: provably nothing was
--    submitted); every real provider answer, and a PREPARED attempt, still blocks a second one (I-09).
-- 2. `worker_read_intent` answers with the LATEST attempt and its number.
-- 3. `worker_record_stop` is refused only by an attempt that may have left (anything but NOT_ATTEMPTED) and records
--    evaluation 1; later evaluations of a stop are the recovery lane's (d21-10) append-only rows.
-- 4. `worker_finish_attempt` accepts NOT_ATTEMPTED.
DROP FUNCTION "communications"."worker_begin_attempt"(uuid, uuid, uuid);
--> statement-breakpoint
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
    'attempt', (SELECT jsonb_build_object('attemptId', attempt."attempt_id", 'attemptNumber', attempt."attempt_number", 'state', attempt."state")
      FROM "communications"."delivery_attempts" AS attempt
      WHERE attempt."tenant_id" = intent."tenant_id" AND attempt."intent_id" = intent."intent_id"
      ORDER BY attempt."attempt_number" DESC LIMIT 1),
    'stopped', EXISTS (
      SELECT 1 FROM "communications"."intent_handoff_stops" AS stop
      WHERE stop."tenant_id" = intent."tenant_id" AND stop."intent_id" = intent."intent_id")))
  FROM "communications"."message_intents" AS intent
  JOIN "communications"."communication_requests" AS request
    ON request."tenant_id" = intent."tenant_id" AND request."request_id" = intent."request_id"
  WHERE intent."tenant_id" = p_tenant_id AND intent."intent_id" = p_intent_id;
END;
$$;
--> statement-breakpoint
-- Outcomes: BEGUN (this caller owns the attempt), EXISTS (an attempt that may have left exists), STOPPED, NOT_PENDING (the
-- intent is not pending a handoff), STALE (the number is not the next one: re-read), MISSING (no such intent in this Tenant).
CREATE FUNCTION "communications"."worker_begin_attempt"(p_tenant_id uuid, p_intent_id uuid, p_attempt_id uuid, p_attempt_number integer)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  intent_status text;
  latest_number integer;
  latest_state text;
BEGIN
  PERFORM "communications"."assert_worker_scope"(p_tenant_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('communications.intent-handoff:' || p_tenant_id::text || ':' || p_intent_id::text, 0));
  SELECT intent."status" INTO intent_status FROM "communications"."message_intents" AS intent
    WHERE intent."tenant_id" = p_tenant_id AND intent."intent_id" = p_intent_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'MISSING');
    RETURN;
  END IF;
  IF intent_status <> 'PENDING_HANDOFF' THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'NOT_PENDING');
    RETURN;
  END IF;
  SELECT attempt."attempt_number", attempt."state" INTO latest_number, latest_state FROM "communications"."delivery_attempts" AS attempt
    WHERE attempt."tenant_id" = p_tenant_id AND attempt."intent_id" = p_intent_id
    ORDER BY attempt."attempt_number" DESC LIMIT 1;
  IF FOUND AND latest_state <> 'NOT_ATTEMPTED' THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'EXISTS', 'state', latest_state);
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM "communications"."intent_handoff_stops" AS stop WHERE stop."tenant_id" = p_tenant_id AND stop."intent_id" = p_intent_id) THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'STOPPED');
    RETURN;
  END IF;
  IF p_attempt_number IS DISTINCT FROM coalesce(latest_number, 0) + 1 THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'STALE');
    RETURN;
  END IF;
  INSERT INTO "communications"."delivery_attempts" ("attempt_id", "tenant_id", "intent_id", "attempt_number", "state", "prepared_at")
  VALUES (p_attempt_id, p_tenant_id, p_intent_id, p_attempt_number, 'PREPARED', clock_timestamp());
  RETURN QUERY SELECT jsonb_build_object('outcome', 'BEGUN');
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "communications"."worker_record_stop"(p_tenant_id uuid, p_intent_id uuid, p_reasons jsonb)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM "communications"."assert_worker_scope"(p_tenant_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('communications.intent-handoff:' || p_tenant_id::text || ':' || p_intent_id::text, 0));
  IF NOT EXISTS (SELECT 1 FROM "communications"."message_intents" WHERE "tenant_id" = p_tenant_id AND "intent_id" = p_intent_id) THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'MISSING');
    RETURN;
  END IF;
  -- an attempt that may have left is reconciled, never "stopped"; a NOT_ATTEMPTED one provably left nothing
  IF EXISTS (SELECT 1 FROM "communications"."delivery_attempts" AS attempt
      WHERE attempt."tenant_id" = p_tenant_id AND attempt."intent_id" = p_intent_id AND attempt."state" <> 'NOT_ATTEMPTED') THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'ATTEMPT_EXISTS');
    RETURN;
  END IF;
  INSERT INTO "communications"."intent_handoff_stops" ("tenant_id", "intent_id", "evaluation_seq", "reasons", "recorded_at")
  VALUES (p_tenant_id, p_intent_id, 1, p_reasons, clock_timestamp())
  ON CONFLICT ("tenant_id", "intent_id", "evaluation_seq") DO NOTHING;
  RETURN QUERY SELECT jsonb_build_object('outcome', 'STOPPED');
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "communications"."worker_finish_attempt"(p_tenant_id uuid, p_attempt_id uuid, p_state text, p_evidence jsonb)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  current_state text;
BEGIN
  PERFORM "communications"."assert_worker_scope"(p_tenant_id);
  IF p_state NOT IN ('ACCEPTED', 'REJECTED', 'UNAVAILABLE', 'INDETERMINATE', 'NOT_ATTEMPTED') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A delivery attempt can only be finished with a provider outcome or NOT_ATTEMPTED';
  END IF;
  SELECT attempt."state" INTO current_state FROM "communications"."delivery_attempts" AS attempt
    WHERE attempt."tenant_id" = p_tenant_id AND attempt."attempt_id" = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'MISSING');
    RETURN;
  END IF;
  IF current_state = p_state THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'FINISHED', 'state', current_state);
    RETURN;
  END IF;
  IF current_state <> 'PREPARED' THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'CONFLICT', 'state', current_state);
    RETURN;
  END IF;
  UPDATE "communications"."delivery_attempts" SET "state" = p_state, "evidence" = p_evidence, "finished_at" = clock_timestamp()
    WHERE "tenant_id" = p_tenant_id AND "attempt_id" = p_attempt_id;
  RETURN QUERY SELECT jsonb_build_object('outcome', 'FINISHED', 'state', p_state);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "communications"."worker_begin_attempt"(uuid, uuid, uuid, integer) FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "communications"."worker_begin_attempt"(uuid, uuid, uuid, integer) TO "ontos_runtime";
