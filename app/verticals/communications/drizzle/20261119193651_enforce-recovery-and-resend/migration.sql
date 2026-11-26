-- Technical Retry, Reconciliation and Explicit Resend (#1403): forced Tenant isolation, least-privilege grants, append-only
-- guards and the scoped routines of the recovery lane. Typed Drizzle owns the new tables, keys, checks and policies in the
-- preceding generated migration. Forward only: nothing earlier is rewritten; the released routines are replaced in place
-- (same signatures, same grants) or added next to them.
--
-- The two new tables are written ONLY by scoped routines, so the runtime role can read them and nothing else. Both are
-- append-only whatever the role.
ALTER TABLE "communications"."provider_observation_conflict_resolutions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "communications"."intent_recovery_evaluations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE
  "communications"."provider_observation_conflict_resolutions",
  "communications"."intent_recovery_evaluations"
FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT SELECT ON TABLE
  "communications"."provider_observation_conflict_resolutions",
  "communications"."intent_recovery_evaluations"
TO "ontos_runtime";
--> statement-breakpoint
CREATE TRIGGER "communications_conflict_resolutions_append_only" BEFORE UPDATE OR DELETE ON "communications"."provider_observation_conflict_resolutions" FOR EACH ROW EXECUTE FUNCTION "communications"."reject_intake_fact_mutation"();
--> statement-breakpoint
CREATE TRIGGER "communications_recovery_evaluations_append_only" BEFORE UPDATE OR DELETE ON "communications"."intent_recovery_evaluations" FOR EACH ROW EXECUTE FUNCTION "communications"."reject_intake_fact_mutation"();
--> statement-breakpoint
-- The ONE read of the pre-handoff and recovery step: the pinned intent, its request and EVERY stored fact the recovery
-- evaluation needs (all attempts with their closed answer reason, every provider observation, every conflict with the time its
-- resolution was appended, every handoff stop and every recovery evaluation). It never reads an address, a secret or a
-- provider payload: the evidence of an observation is closed and only its kind and failure class are exposed.
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
      WHERE evaluation."tenant_id" = intent."tenant_id" AND evaluation."intent_id" = intent."intent_id"), '[]'::jsonb)))
  FROM "communications"."message_intents" AS intent
  JOIN "communications"."communication_requests" AS request
    ON request."tenant_id" = intent."tenant_id" AND request."request_id" = intent."request_id"
  WHERE intent."tenant_id" = p_tenant_id AND intent."intent_id" = p_intent_id;
END;
$$;
--> statement-breakpoint
-- The FIRST attempt of an intent. Every later attempt is a Technical Retry and begins only through `worker_begin_retry_attempt`,
-- which records why the earlier one no longer blocks it. Outcomes: BEGUN (this caller owns the attempt), EXISTS (an attempt
-- exists; the caller continues only through the retry routine), STOPPED (a PROVEN stop is final; an UNPROVEN one is superseded
-- by the Current evaluation that cleared this call), NOT_PENDING, STALE (the number is not 1: re-read), MISSING.
CREATE OR REPLACE FUNCTION "communications"."worker_begin_attempt"(p_tenant_id uuid, p_intent_id uuid, p_attempt_id uuid, p_attempt_number integer)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  intent_status text;
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
  SELECT attempt."state" INTO latest_state FROM "communications"."delivery_attempts" AS attempt
    WHERE attempt."tenant_id" = p_tenant_id AND attempt."intent_id" = p_intent_id
    ORDER BY attempt."attempt_number" DESC LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'EXISTS', 'state', latest_state);
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM "communications"."intent_handoff_stops" AS stop WHERE stop."tenant_id" = p_tenant_id AND stop."intent_id" = p_intent_id AND stop."proven") THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'STOPPED');
    RETURN;
  END IF;
  IF p_attempt_number IS DISTINCT FROM 1 THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'STALE');
    RETURN;
  END IF;
  INSERT INTO "communications"."delivery_attempts" ("attempt_id", "tenant_id", "intent_id", "attempt_number", "state", "prepared_at")
  VALUES (p_attempt_id, p_tenant_id, p_intent_id, p_attempt_number, 'PREPARED', clock_timestamp());
  RETURN QUERY SELECT jsonb_build_object('outcome', 'BEGUN');
END;
$$;
--> statement-breakpoint
-- A Technical Retry: the NEXT attempt of the SAME intent, begun together with the link that says why the earlier one no longer
-- blocks it, in one statement. The attempt row carries no recipient, language or template, so a retry cannot change any pin.
-- Nothing is begun unless: the intent is pending, no PROVEN stop exists, the attempt is the very next number after the latest
-- one and follows exactly that one, no provider observation conflict is unresolved, no attempt of the intent is known to have
-- been accepted, and `worker_link_retry_attempt` accepts the basis (which proves the earlier attempt provably submitted
-- nothing, was provably refused, or has a recorded reconciliation proving non-acceptance). A rejected basis rolls the new
-- attempt back inside this call and writes nothing. Outcomes: BEGUN; EXISTS (an attempt with that number already exists: the
-- caller never calls the provider); STOPPED; NOT_PENDING; MISSING; STALE; BASIS_MISSING; CONFLICT_UNRESOLVED.
CREATE FUNCTION "communications"."worker_begin_retry_attempt"(
  p_tenant_id uuid, p_intent_id uuid, p_attempt_id uuid, p_attempt_number integer, p_previous_attempt_id uuid,
  p_basis_kind text, p_basis_observation_id uuid, p_reason_code text
)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  intent_status text;
  latest_id uuid;
  latest_number integer;
  latest_state text;
  link_outcome text;
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
  SELECT attempt."attempt_id", attempt."attempt_number", attempt."state" INTO latest_id, latest_number, latest_state
    FROM "communications"."delivery_attempts" AS attempt
    WHERE attempt."tenant_id" = p_tenant_id AND attempt."intent_id" = p_intent_id
    ORDER BY attempt."attempt_number" DESC LIMIT 1;
  IF NOT FOUND THEN
    -- a retry follows an attempt: the first attempt of an intent is `worker_begin_attempt`
    RETURN QUERY SELECT jsonb_build_object('outcome', 'STALE');
    RETURN;
  END IF;
  IF latest_number >= p_attempt_number THEN
    -- a racing caller (or an earlier delivery of this very step) already began this number: it owns the attempt
    RETURN QUERY SELECT jsonb_build_object('outcome', 'EXISTS', 'state', latest_state);
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM "communications"."intent_handoff_stops" AS stop
    WHERE stop."tenant_id" = p_tenant_id AND stop."intent_id" = p_intent_id AND stop."proven")
    OR EXISTS (
    SELECT 1 FROM "communications"."intent_recovery_evaluations" AS evaluation
    WHERE evaluation."tenant_id" = p_tenant_id AND evaluation."intent_id" = p_intent_id AND evaluation."outcome" = 'STOPPED' AND evaluation."proven") THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'STOPPED');
    RETURN;
  END IF;
  IF p_attempt_number <> latest_number + 1 OR p_previous_attempt_id IS DISTINCT FROM latest_id THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'STALE');
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM "communications"."provider_observation_conflicts" AS conflict
    WHERE conflict."tenant_id" = p_tenant_id AND conflict."intent_id" = p_intent_id
      AND NOT EXISTS (
        SELECT 1 FROM "communications"."provider_observation_conflict_resolutions" AS resolution
        WHERE resolution."tenant_id" = conflict."tenant_id" AND resolution."conflict_id" = conflict."conflict_id")) THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'CONFLICT_UNRESOLVED');
    RETURN;
  END IF;
  -- no attempt of this intent is, or is evidenced to have been, accepted: a second send would duplicate it
  IF EXISTS (
    SELECT 1 FROM "communications"."delivery_attempts" AS attempt
    WHERE attempt."tenant_id" = p_tenant_id AND attempt."intent_id" = p_intent_id AND attempt."state" = 'ACCEPTED')
    OR EXISTS (
    SELECT 1 FROM "communications"."provider_observations" AS observation
    WHERE observation."tenant_id" = p_tenant_id AND observation."intent_id" = p_intent_id
      AND observation."kind" IN ('ACCEPTANCE_PROVEN', 'DELIVERY_FAILED', 'DELIVERY_PROVEN')) THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'BASIS_MISSING');
    RETURN;
  END IF;
  BEGIN
    INSERT INTO "communications"."delivery_attempts" ("attempt_id", "tenant_id", "intent_id", "attempt_number", "state", "prepared_at")
    VALUES (p_attempt_id, p_tenant_id, p_intent_id, p_attempt_number, 'PREPARED', clock_timestamp());
    SELECT link."result" ->> 'outcome' INTO link_outcome
      FROM "communications"."worker_link_retry_attempt"(
        p_tenant_id, p_intent_id, p_attempt_id, p_previous_attempt_id, p_reason_code, p_basis_kind, p_basis_observation_id) AS link;
    IF link_outcome IS DISTINCT FROM 'LINKED' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'retry basis refused';
    END IF;
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    -- the sub-transaction undid the new attempt: nothing was begun and nothing may be sent
    RETURN QUERY SELECT jsonb_build_object('outcome', 'BASIS_MISSING');
    RETURN;
  END;
  RETURN QUERY SELECT jsonb_build_object('outcome', 'BEGUN');
END;
$$;
--> statement-breakpoint
-- Records the stop of one intent that has NO attempt which may have left, per EVALUATION. A PROVEN stop is final: no later
-- evaluation is appended after it. An UNPROVEN stop (an owner could not answer) never is: every later Current evaluation is
-- appended as the next `evaluation_seq` and no row is ever edited or removed, so history shows every evaluation that was made.
-- Outcomes: STOPPED (with the evaluation recorded or the final proven stop that already exists), ATTEMPT_EXISTS (an attempt that
-- may have left exists: it is reconciled, never stopped), MISSING.
CREATE OR REPLACE FUNCTION "communications"."worker_record_stop"(p_tenant_id uuid, p_intent_id uuid, p_reasons jsonb)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  latest_seq integer;
  latest_proven boolean;
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
  SELECT stop."evaluation_seq", stop."proven" INTO latest_seq, latest_proven FROM "communications"."intent_handoff_stops" AS stop
    WHERE stop."tenant_id" = p_tenant_id AND stop."intent_id" = p_intent_id
    ORDER BY stop."evaluation_seq" DESC LIMIT 1;
  IF FOUND AND latest_proven THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'STOPPED', 'evaluationSeq', latest_seq);
    RETURN;
  END IF;
  INSERT INTO "communications"."intent_handoff_stops" ("tenant_id", "intent_id", "evaluation_seq", "reasons", "recorded_at")
  VALUES (p_tenant_id, p_intent_id, coalesce(latest_seq, 0) + 1, p_reasons, clock_timestamp());
  RETURN QUERY SELECT jsonb_build_object('outcome', 'STOPPED', 'evaluationSeq', coalesce(latest_seq, 0) + 1);
END;
$$;
--> statement-breakpoint
-- Records one evaluation that did NOT lead to another attempt of an intent that already has one (see the table). The basis
-- attempt must belong to the intent. A PROVEN stop is final (FINAL, nothing appended). A halt identical to the latest one on the
-- same attempt is not appended again (UNCHANGED), so a redelivery cannot flood the history; anything else is the next
-- evaluation (RECORDED). Outcomes: RECORDED, UNCHANGED, FINAL, MISSING.
CREATE FUNCTION "communications"."worker_record_recovery_evaluation"(
  p_tenant_id uuid, p_intent_id uuid, p_basis_attempt_id uuid, p_outcome text, p_code text, p_reasons jsonb
)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  latest "communications"."intent_recovery_evaluations"%ROWTYPE;
  next_seq integer := 1;
BEGIN
  PERFORM "communications"."assert_worker_scope"(p_tenant_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('communications.intent-handoff:' || p_tenant_id::text || ':' || p_intent_id::text, 0));
  IF NOT EXISTS (
    SELECT 1 FROM "communications"."delivery_attempts" AS attempt
    WHERE attempt."tenant_id" = p_tenant_id AND attempt."intent_id" = p_intent_id AND attempt."attempt_id" = p_basis_attempt_id) THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'MISSING');
    RETURN;
  END IF;
  SELECT * INTO latest FROM "communications"."intent_recovery_evaluations" AS evaluation
    WHERE evaluation."tenant_id" = p_tenant_id AND evaluation."intent_id" = p_intent_id
    ORDER BY evaluation."evaluation_seq" DESC LIMIT 1;
  IF FOUND THEN
    next_seq := latest."evaluation_seq" + 1;
    IF latest."outcome" = 'STOPPED' AND latest."proven" THEN
      RETURN QUERY SELECT jsonb_build_object('outcome', 'FINAL', 'evaluationSeq', latest."evaluation_seq");
      RETURN;
    END IF;
    IF p_outcome = 'HALTED' AND latest."outcome" = 'HALTED' AND latest."code" = p_code AND latest."basis_attempt_id" = p_basis_attempt_id THEN
      RETURN QUERY SELECT jsonb_build_object('outcome', 'UNCHANGED', 'evaluationSeq', latest."evaluation_seq");
      RETURN;
    END IF;
  END IF;
  INSERT INTO "communications"."intent_recovery_evaluations" (
    "tenant_id", "intent_id", "evaluation_seq", "basis_attempt_id", "outcome", "code", "reasons", "evaluated_at")
  VALUES (
    p_tenant_id, p_intent_id, next_seq, p_basis_attempt_id, p_outcome, p_code, p_reasons, clock_timestamp());
  RETURN QUERY SELECT jsonb_build_object('outcome', 'RECORDED');
END;
$$;
--> statement-breakpoint
-- Appends the RESOLUTION of one provider observation conflict: a later RECONCILIATION observation of the SAME attempt, recorded
-- at or after the conflict, settles the doubt the conflict raised. It never edits or removes the conflict or any observation,
-- and one conflict has at most one resolution. Outcomes: RESOLVED, EXISTS (already resolved by this very basis), MISSING (no
-- such conflict of this intent in this Tenant), BASIS_INVALID (the basis is not a reconciliation observation of the conflict's
-- attempt recorded at or after the conflict, or the conflict is already resolved by another one).
CREATE FUNCTION "communications"."worker_resolve_observation_conflict"(
  p_tenant_id uuid, p_intent_id uuid, p_conflict_id uuid, p_basis_observation_id uuid, p_reason_code text
)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  conflict "communications"."provider_observation_conflicts"%ROWTYPE;
  existing_basis uuid;
BEGIN
  PERFORM "communications"."assert_worker_scope"(p_tenant_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('communications.intent-handoff:' || p_tenant_id::text || ':' || p_intent_id::text, 0));
  SELECT * INTO conflict FROM "communications"."provider_observation_conflicts" AS candidate
    WHERE candidate."tenant_id" = p_tenant_id AND candidate."intent_id" = p_intent_id AND candidate."conflict_id" = p_conflict_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'MISSING');
    RETURN;
  END IF;
  SELECT resolution."basis_observation_id" INTO existing_basis FROM "communications"."provider_observation_conflict_resolutions" AS resolution
    WHERE resolution."tenant_id" = p_tenant_id AND resolution."conflict_id" = p_conflict_id;
  IF FOUND THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', CASE WHEN existing_basis = p_basis_observation_id THEN 'EXISTS' ELSE 'BASIS_INVALID' END);
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "communications"."provider_observations" AS observation
    WHERE observation."tenant_id" = p_tenant_id AND observation."observation_id" = p_basis_observation_id
      AND observation."intent_id" = p_intent_id AND observation."attempt_id" = conflict."attempt_id"
      AND (observation."evidence" ->> 'basis') = 'RECONCILIATION'
      AND observation."recorded_at" >= conflict."recorded_at") THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'BASIS_INVALID');
    RETURN;
  END IF;
  INSERT INTO "communications"."provider_observation_conflict_resolutions" (
    "resolution_id", "tenant_id", "conflict_id", "intent_id", "attempt_id", "basis_observation_id", "reason_code", "resolved_at")
  VALUES (
    gen_random_uuid(), p_tenant_id, p_conflict_id, p_intent_id, conflict."attempt_id", p_basis_observation_id, p_reason_code, clock_timestamp());
  RETURN QUERY SELECT jsonb_build_object('outcome', 'RESOLVED');
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  "communications"."worker_begin_retry_attempt"(uuid, uuid, uuid, integer, uuid, text, uuid, text),
  "communications"."worker_record_recovery_evaluation"(uuid, uuid, uuid, text, text, jsonb),
  "communications"."worker_resolve_observation_conflict"(uuid, uuid, uuid, uuid, text)
FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  "communications"."worker_begin_retry_attempt"(uuid, uuid, uuid, integer, uuid, text, uuid, text),
  "communications"."worker_record_recovery_evaluation"(uuid, uuid, uuid, text, text, jsonb),
  "communications"."worker_resolve_observation_conflict"(uuid, uuid, uuid, uuid, text)
TO "ontos_runtime";
