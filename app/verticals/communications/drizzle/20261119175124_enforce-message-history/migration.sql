-- Forced Tenant isolation, least-privilege grants, append-only guards and the scoped routines of the truthful message
-- history (#1402). Typed Drizzle owns the tables, keys, checks and policies in the preceding generated migration; this one
-- adds what typed DDL cannot express. Forward only: nothing earlier is rewritten.
--
-- Provider observations and technical retry links are written ONLY through the scoped routines below, so the runtime role can
-- read them and nothing else. The Explicit Resend link is a fact the intake Action writes in its own transaction, so the
-- runtime role may insert it (and, like every fact, never update or delete it).
ALTER TABLE "communications"."provider_observations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "communications"."attempt_retry_links" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "communications"."intent_resend_links" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE
  "communications"."provider_observations",
  "communications"."attempt_retry_links",
  "communications"."intent_resend_links"
FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON SEQUENCE "communications"."provider_observations_recorded_seq_seq" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT SELECT ON TABLE "communications"."provider_observations", "communications"."attempt_retry_links" TO "ontos_runtime";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "communications"."intent_resend_links" TO "ontos_runtime";
--> statement-breakpoint
-- Every history fact is append-only whatever the role: an update or a delete is refused by trigger.
CREATE TRIGGER "communications_observations_append_only" BEFORE UPDATE OR DELETE ON "communications"."provider_observations" FOR EACH ROW EXECUTE FUNCTION "communications"."reject_intake_fact_mutation"();
--> statement-breakpoint
CREATE TRIGGER "communications_retry_links_append_only" BEFORE UPDATE OR DELETE ON "communications"."attempt_retry_links" FOR EACH ROW EXECUTE FUNCTION "communications"."reject_intake_fact_mutation"();
--> statement-breakpoint
CREATE TRIGGER "communications_resend_links_append_only" BEFORE UPDATE OR DELETE ON "communications"."intent_resend_links" FOR EACH ROW EXECUTE FUNCTION "communications"."reject_intake_fact_mutation"();
--> statement-breakpoint
-- An Explicit Resend is a NEW intent of a NEW request (never the original's own request) and never its own ancestor, so the
-- links form a forest and both directions of the link are unambiguous. The foreign keys prove both intents exist in the
-- Tenant; a missing one is left to them.
CREATE FUNCTION "communications"."enforce_resend_link"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  original_request uuid;
  resend_request uuid;
BEGIN
  SELECT intent."request_id" INTO original_request FROM "communications"."message_intents" AS intent
    WHERE intent."tenant_id" = NEW."tenant_id" AND intent."intent_id" = NEW."original_intent_id";
  SELECT intent."request_id" INTO resend_request FROM "communications"."message_intents" AS intent
    WHERE intent."tenant_id" = NEW."tenant_id" AND intent."intent_id" = NEW."resend_intent_id";
  IF original_request IS NULL OR resend_request IS NULL THEN
    RETURN NEW;
  END IF;
  IF original_request = resend_request THEN
    RAISE EXCEPTION 'an explicit resend belongs to a new communication request' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    WITH RECURSIVE ancestors("intent_id") AS (
      SELECT NEW."original_intent_id"
      UNION
      SELECT link."original_intent_id" FROM "communications"."intent_resend_links" AS link
        JOIN ancestors ON link."resend_intent_id" = ancestors."intent_id"
        WHERE link."tenant_id" = NEW."tenant_id")
    SELECT 1 FROM ancestors WHERE ancestors."intent_id" = NEW."resend_intent_id") THEN
    RAISE EXCEPTION 'an explicit resend cannot be an ancestor of its own original' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "communications"."enforce_resend_link"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "communications_resend_links_shape" BEFORE INSERT ON "communications"."intent_resend_links" FOR EACH ROW EXECUTE FUNCTION "communications"."enforce_resend_link"();
--> statement-breakpoint
-- Appends ONE provider observation to ONE delivery attempt, or says why it cannot be bound. It never creates, finishes or
-- changes an attempt and never schedules anything, so no observation can cause a second send. The answers carry no data of
-- any row: the same `UNBOUND` is given for an intent of another Tenant, an unknown intent and an attempt of another intent.
--   RECORDED          the observation is new and appended;
--   DUPLICATE         the very same observation (same identity, same content) was already recorded; nothing changes;
--   CONFLICT          the same identity arrived with another content; the first one stays, nothing changes;
--   UNBOUND           the Tenant, intent and attempt do not belong together;
--   NOT_SUBMITTED     the attempt provably submitted nothing (NOT_ATTEMPTED), so there is nothing to observe;
--   PROVIDER_MISMATCH the observation names another provider (or another provider reference) than the attempt or its earlier
--                     observations are already bound to: an outcome never moves to another provider identity.
CREATE FUNCTION "communications"."ingest_provider_observation"(
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
  IF attempt_state = 'NOT_ATTEMPTED' THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'NOT_SUBMITTED');
    RETURN;
  END IF;
  SELECT * INTO existing FROM "communications"."provider_observations" AS observation
    WHERE observation."tenant_id" = p_tenant_id AND observation."attempt_id" = p_attempt_id
      AND observation."provider_key" = p_provider_key AND observation."observation_key" = p_observation_key;
  IF FOUND THEN
    IF existing."kind" = p_kind AND existing."evidence" = p_evidence AND existing."provider_ref" IS NOT DISTINCT FROM p_provider_ref THEN
      RETURN QUERY SELECT jsonb_build_object('outcome', 'DUPLICATE');
    ELSE
      RETURN QUERY SELECT jsonb_build_object('outcome', 'CONFLICT');
    END IF;
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
--> statement-breakpoint
-- Links a LATER attempt of the SAME intent to the attempt it follows (Technical Retry). Structure only: it checks that both
-- attempts belong to the intent, that the later one is the very next number, that the earlier one is finished, and that the
-- basis named is a fact that exists (a NOT_ATTEMPTED attempt, or a recorded proof of non-acceptance of THAT attempt). Whether
-- a retry is allowed is decided by the recovery lane before it begins the attempt. Idempotent for the same link.
--   LINKED / EXISTS   the link was written / the same link already exists;
--   CONFLICT          the attempt is already linked to another previous attempt;
--   MISSING           an attempt does not belong to this intent in this Tenant;
--   ORDER             the later attempt is not the next number after the earlier one;
--   NOT_FINISHED      the earlier attempt is still PREPARED: its effect is unknown and nothing follows it;
--   BASIS_MISSING     the named basis does not exist for the earlier attempt.
CREATE FUNCTION "communications"."worker_link_retry_attempt"(
  p_tenant_id uuid, p_intent_id uuid, p_attempt_id uuid, p_previous_attempt_id uuid, p_reason_code text, p_basis_kind text,
  p_basis_observation_id uuid
)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  attempt_number integer;
  previous_number integer;
  previous_state text;
  existing_previous uuid;
BEGIN
  PERFORM "communications"."assert_worker_scope"(p_tenant_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('communications.intent-handoff:' || p_tenant_id::text || ':' || p_intent_id::text, 0));
  SELECT attempt."attempt_number" INTO attempt_number FROM "communications"."delivery_attempts" AS attempt
    WHERE attempt."tenant_id" = p_tenant_id AND attempt."intent_id" = p_intent_id AND attempt."attempt_id" = p_attempt_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'MISSING');
    RETURN;
  END IF;
  SELECT attempt."attempt_number", attempt."state" INTO previous_number, previous_state FROM "communications"."delivery_attempts" AS attempt
    WHERE attempt."tenant_id" = p_tenant_id AND attempt."intent_id" = p_intent_id AND attempt."attempt_id" = p_previous_attempt_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'MISSING');
    RETURN;
  END IF;
  SELECT link."previous_attempt_id" INTO existing_previous FROM "communications"."attempt_retry_links" AS link
    WHERE link."tenant_id" = p_tenant_id AND link."attempt_id" = p_attempt_id;
  IF FOUND THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', CASE WHEN existing_previous = p_previous_attempt_id THEN 'EXISTS' ELSE 'CONFLICT' END);
    RETURN;
  END IF;
  IF attempt_number <> previous_number + 1 THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'ORDER');
    RETURN;
  END IF;
  IF previous_state = 'PREPARED' THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'NOT_FINISHED');
    RETURN;
  END IF;
  IF p_basis_kind = 'PRIOR_NOT_ATTEMPTED' AND previous_state <> 'NOT_ATTEMPTED' THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'BASIS_MISSING');
    RETURN;
  END IF;
  IF p_basis_kind = 'RECONCILED_NON_ACCEPTANCE' AND NOT EXISTS (
    SELECT 1 FROM "communications"."provider_observations" AS observation
    WHERE observation."tenant_id" = p_tenant_id AND observation."attempt_id" = p_previous_attempt_id
      AND observation."observation_id" = p_basis_observation_id AND observation."kind" = 'NON_ACCEPTANCE_PROVEN') THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'BASIS_MISSING');
    RETURN;
  END IF;
  INSERT INTO "communications"."attempt_retry_links" (
    "attempt_id", "tenant_id", "intent_id", "previous_attempt_id", "reason_code", "basis_kind", "basis_observation_id", "linked_at")
  VALUES (p_attempt_id, p_tenant_id, p_intent_id, p_previous_attempt_id, p_reason_code, p_basis_kind, p_basis_observation_id, clock_timestamp());
  RETURN QUERY SELECT jsonb_build_object('outcome', 'LINKED');
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  "communications"."ingest_provider_observation"(uuid, uuid, uuid, uuid, uuid, text, text, text, text, timestamptz, jsonb),
  "communications"."worker_link_retry_attempt"(uuid, uuid, uuid, uuid, text, text, uuid)
FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  "communications"."ingest_provider_observation"(uuid, uuid, uuid, uuid, uuid, text, text, text, text, timestamptz, jsonb),
  "communications"."worker_link_retry_attempt"(uuid, uuid, uuid, uuid, text, text, uuid)
TO "ontos_runtime";
