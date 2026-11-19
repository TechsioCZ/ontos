-- Closing an attempt that never recorded an answer (#1403 review). Reconciliation may end an attempt that was begun and never
-- answered as an unanswered INDETERMINATE once a reconciliation proved non-acceptance, so it can be the basis of a Technical
-- Retry. It may NOT do so while the provider call of that attempt can still be running: a late ACCEPTED answer would then meet
-- a closed attempt and the next attempt would duplicate it.
--
-- "Cannot still be running" is decided HERE, on the database clock that stamped `prepared_at`, so no clock difference between
-- two processes can move it. The bound is the lease of the owner's Core Outbox worker, passed in by the caller (the same
-- number the worker bounds its provider call with): the call is interrupted when it passes, so an attempt prepared longer ago
-- than the lease has no call that can still answer. Forward only: no earlier routine is changed.
--
-- Outcomes: CLOSED (the attempt is now an unanswered INDETERMINATE), IN_FLIGHT (its call may still be running: nothing changed),
-- NOT_PREPARED (it already has an answer, or was closed: nothing changed, and `state` says which), MISSING.
CREATE FUNCTION "communications"."worker_close_unanswered_attempt"(p_tenant_id uuid, p_attempt_id uuid, p_lease_ms integer)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  current_state text;
  prepared timestamptz;
BEGIN
  PERFORM "communications"."assert_worker_scope"(p_tenant_id);
  IF p_lease_ms IS NULL OR p_lease_ms < 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'The call lease of an attempt must be a non-negative number of milliseconds';
  END IF;
  SELECT attempt."state", attempt."prepared_at" INTO current_state, prepared FROM "communications"."delivery_attempts" AS attempt
    WHERE attempt."tenant_id" = p_tenant_id AND attempt."attempt_id" = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'MISSING');
    RETURN;
  END IF;
  IF current_state <> 'PREPARED' THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'NOT_PREPARED', 'state', current_state);
    RETURN;
  END IF;
  IF clock_timestamp() < prepared + (p_lease_ms * interval '1 millisecond') THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'IN_FLIGHT');
    RETURN;
  END IF;
  UPDATE "communications"."delivery_attempts"
    SET "state" = 'INDETERMINATE', "evidence" = jsonb_build_object('kind', 'INDETERMINATE', 'reason', 'no_answer_recorded'), "finished_at" = clock_timestamp()
    WHERE "tenant_id" = p_tenant_id AND "attempt_id" = p_attempt_id;
  RETURN QUERY SELECT jsonb_build_object('outcome', 'CLOSED');
END;
$$;
--> statement-breakpoint
-- The same fact in the stop routine (#1403 review): "an attempt that may have left" is the ONE technical fact used by the
-- timeline and the step, namely any attempt that is not NOT_ATTEMPTED and not an UNAVAILABLE answer with the reason
-- `configuration` (no request was made at all). An intent whose attempts all provably submitted nothing can therefore be
-- stopped, and a proven stop is final. Same signature and grants as the released routine.
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
  IF EXISTS (SELECT 1 FROM "communications"."delivery_attempts" AS attempt
      WHERE attempt."tenant_id" = p_tenant_id AND attempt."intent_id" = p_intent_id AND attempt."state" <> 'NOT_ATTEMPTED'
        AND NOT (attempt."state" = 'UNAVAILABLE' AND (attempt."evidence" ->> 'reason') = 'configuration')) THEN
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
-- A recovery STOP identical to the latest evaluation (same outcome, code, basis attempt and reasons) is not appended again,
-- exactly like a halt: a redelivery of the same message cannot flood the history with the same unproven stop. A different
-- reason, another attempt or a different outcome in between is the next evaluation. Same signature and grants as released.
CREATE OR REPLACE FUNCTION "communications"."worker_record_recovery_evaluation"(
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
    IF latest."outcome" = p_outcome AND latest."code" = p_code AND latest."basis_attempt_id" = p_basis_attempt_id
      AND latest."reasons" = p_reasons THEN
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
REVOKE ALL ON FUNCTION "communications"."worker_close_unanswered_attempt"(uuid, uuid, integer) FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "communications"."worker_close_unanswered_attempt"(uuid, uuid, integer) TO "ontos_runtime";
