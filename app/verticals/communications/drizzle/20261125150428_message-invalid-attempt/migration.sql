ALTER TABLE "communications"."delivery_attempts" DROP CONSTRAINT "communications_attempts_state_ck", ADD CONSTRAINT "communications_attempts_state_ck" CHECK ("state" in ('ACCEPTED', 'INDETERMINATE', 'MESSAGE_INVALID', 'NOT_ATTEMPTED', 'PREPARED', 'REJECTED', 'UNAVAILABLE'));
--> statement-breakpoint
-- A certain failure is stored as one (#1402 T3-11, #1403): the Messaging Adapter PROVED that our own message was malformed and the
-- provider was never asked (the handoff contract carries that proof), so the attempt is finished as MESSAGE_INVALID instead of an
-- unknown effect that would wait for a reconciliation that can never come. Forward only; same signatures and grants as released.
-- The routine only writes the state: that the proof exists is the contract of the caller, which never infers it from a provider answer.
CREATE OR REPLACE FUNCTION "communications"."worker_finish_attempt"(p_tenant_id uuid, p_attempt_id uuid, p_state text, p_evidence jsonb)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  current_state text;
BEGIN
  PERFORM "communications"."assert_worker_scope"(p_tenant_id);
  IF p_state NOT IN ('ACCEPTED', 'REJECTED', 'UNAVAILABLE', 'INDETERMINATE', 'NOT_ATTEMPTED', 'MESSAGE_INVALID') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A delivery attempt can only be finished with a provider outcome, NOT_ATTEMPTED or a proven MESSAGE_INVALID';
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
-- An attempt whose provider was never asked has nothing to observe: an observation of it would read as evidence that contradicts
-- an absent effect, so it is answered NOT_SUBMITTED exactly like an attempt that made no request.
CREATE OR REPLACE FUNCTION "communications"."ingest_provider_observation"(
  p_tenant_id uuid, p_claimed_tenant_id uuid, p_intent_id uuid, p_attempt_id uuid, p_observation_id uuid,
  p_provider_key text, p_observation_key text, p_provider_ref text, p_kind text, p_observed_at timestamptz, p_evidence jsonb
)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  attempt_state text;
  attempt_evidence jsonb;
  existing "communications"."provider_observations"%ROWTYPE;
  fingerprint text;
BEGIN
  PERFORM "communications"."assert_worker_scope"(p_tenant_id);
  IF p_claimed_tenant_id IS DISTINCT FROM p_tenant_id THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'UNBOUND');
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('communications.provider-observation:' || p_tenant_id::text || ':' || p_attempt_id::text, 0));
  SELECT attempt."state", attempt."evidence" INTO attempt_state, attempt_evidence FROM "communications"."delivery_attempts" AS attempt
    WHERE attempt."tenant_id" = p_tenant_id AND attempt."intent_id" = p_intent_id AND attempt."attempt_id" = p_attempt_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'UNBOUND');
    RETURN;
  END IF;
  IF attempt_state IN ('NOT_ATTEMPTED', 'MESSAGE_INVALID')
    OR (attempt_state = 'UNAVAILABLE' AND (attempt_evidence ->> 'reason') = 'configuration') THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'NOT_SUBMITTED');
    RETURN;
  END IF;
  SELECT * INTO existing FROM "communications"."provider_observations" AS observation
    WHERE observation."tenant_id" = p_tenant_id AND observation."attempt_id" = p_attempt_id
      AND observation."provider_key" = p_provider_key AND observation."observation_key" = p_observation_key
      AND observation."kind" = p_kind;
  IF FOUND THEN
    IF existing."observed_at" = p_observed_at AND existing."evidence" = p_evidence
      AND existing."provider_ref" IS NOT DISTINCT FROM p_provider_ref THEN
      RETURN QUERY SELECT jsonb_build_object('outcome', 'DUPLICATE');
      RETURN;
    END IF;
    -- the same identity with another content: keep the first untouched and leave a durable trace of the disagreement
    fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.concat_ws('|',
      coalesce(p_provider_ref, ''), p_evidence::text, pg_catalog.to_char(p_observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')), 'UTF8')), 'hex');
    INSERT INTO "communications"."provider_observation_conflicts" (
      "conflict_id", "tenant_id", "intent_id", "attempt_id", "observation_id", "provider_key", "observation_key", "kind",
      "observed_at", "content_fingerprint", "recorded_at")
    VALUES (
      gen_random_uuid(), p_tenant_id, p_intent_id, p_attempt_id, existing."observation_id", p_provider_key, p_observation_key, p_kind,
      p_observed_at, fingerprint, clock_timestamp())
    ON CONFLICT ("tenant_id", "observation_id", "content_fingerprint") DO NOTHING;
    RETURN QUERY SELECT jsonb_build_object('outcome', 'CONFLICT');
    RETURN;
  END IF;
  -- the provider identity the attempt answered with, or the first observation bound to it, is the only one that may follow
  IF (attempt_evidence ->> 'providerKey') IS NOT NULL AND (attempt_evidence ->> 'providerKey') <> p_provider_key THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'PROVIDER_MISMATCH');
    RETURN;
  END IF;
  IF (attempt_evidence ->> 'providerRef') IS NOT NULL AND p_provider_ref IS NOT NULL AND (attempt_evidence ->> 'providerRef') <> p_provider_ref THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'PROVIDER_MISMATCH');
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM "communications"."provider_observations" AS observation
    WHERE observation."tenant_id" = p_tenant_id AND observation."attempt_id" = p_attempt_id
      AND (observation."provider_key" <> p_provider_key
        OR (observation."provider_ref" IS NOT NULL AND p_provider_ref IS NOT NULL AND observation."provider_ref" <> p_provider_ref))) THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'PROVIDER_MISMATCH');
    RETURN;
  END IF;
  INSERT INTO "communications"."provider_observations" (
    "observation_id", "tenant_id", "intent_id", "attempt_id", "provider_key", "observation_key", "provider_ref", "kind",
    "observed_at", "recorded_at", "evidence")
  VALUES (
    p_observation_id, p_tenant_id, p_intent_id, p_attempt_id, p_provider_key, p_observation_key, p_provider_ref, p_kind,
    p_observed_at, clock_timestamp(), p_evidence);
  RETURN QUERY SELECT jsonb_build_object('outcome', 'RECORDED');
END;
$$;
