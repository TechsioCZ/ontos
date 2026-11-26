-- Review hardening of the truthful message history (#1402). Forward only: nothing earlier is rewritten; the three scoped
-- routines and the resend guard are replaced in place (same signatures, same grants).
--
-- 1. A conflicting re-delivery (the SAME observation identity with DIFFERENT content) is no longer silently dropped: the
--    original observation stays untouched and the disagreement is appended to `provider_observation_conflicts` with safe
--    fields only (identity, claimed time, a content fingerprint). The identity of an observation now includes its evidence
--    kind, so an acceptance and a bounce that share one provider message id are two legitimate observations.
-- 2. A Technical Retry can follow a provider-REJECTED attempt (proven non-acceptance) and an attempt whose deployment was not
--    configured (no request was made); never an ACCEPTED, UNAVAILABLE or INDETERMINATE one without a reconciliation, and never
--    an attempt whose evidence contradicts the basis.
-- 3. The Explicit Resend guard also requires the resend to be strictly NEWER than its original, and serializes the whole check
--    per Tenant, so two opposite inserts cannot both pass.
ALTER TABLE "communications"."provider_observation_conflicts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "communications"."provider_observation_conflicts" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON SEQUENCE "communications"."provider_observation_conflicts_recorded_seq_seq" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT SELECT ON TABLE "communications"."provider_observation_conflicts" TO "ontos_runtime";
--> statement-breakpoint
CREATE TRIGGER "communications_observation_conflicts_append_only" BEFORE UPDATE OR DELETE ON "communications"."provider_observation_conflicts" FOR EACH ROW EXECUTE FUNCTION "communications"."reject_intake_fact_mutation"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "communications"."enforce_resend_link"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  original_request uuid;
  original_created timestamptz;
  resend_request uuid;
  resend_created timestamptz;
BEGIN
  -- every link of a Tenant is checked one at a time: the checks below read the committed links, so two opposite inserts
  -- cannot both pass (the second one waits here and then sees the first)
  PERFORM pg_advisory_xact_lock(hashtextextended('communications.resend-links:' || NEW."tenant_id"::text, 0));
  SELECT intent."request_id", intent."created_at" INTO original_request, original_created FROM "communications"."message_intents" AS intent
    WHERE intent."tenant_id" = NEW."tenant_id" AND intent."intent_id" = NEW."original_intent_id";
  SELECT intent."request_id", intent."created_at" INTO resend_request, resend_created FROM "communications"."message_intents" AS intent
    WHERE intent."tenant_id" = NEW."tenant_id" AND intent."intent_id" = NEW."resend_intent_id";
  -- the foreign keys prove both intents exist in the Tenant (another Tenant's intent is never found here); a missing one is left to them
  IF original_request IS NULL OR resend_request IS NULL THEN
    RETURN NEW;
  END IF;
  IF original_request = resend_request THEN
    RAISE EXCEPTION 'an explicit resend belongs to a new communication request' USING ERRCODE = '23514';
  END IF;
  IF resend_created <= original_created THEN
    RAISE EXCEPTION 'an explicit resend is created after its original' USING ERRCODE = '23514';
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
-- Appends ONE provider observation to ONE delivery attempt, or says why it cannot be bound. It never creates, finishes or
-- changes an attempt and never schedules anything, so no observation can cause a second send. The answers carry no data of
-- any row: the same `UNBOUND` is given for an intent of another Tenant, an unknown intent and an attempt of another intent.
--   RECORDED          the observation is new and appended;
--   DUPLICATE         the very same observation (same identity, same content INCLUDING the time it claims) was already
--                     recorded; nothing changes;
--   CONFLICT          the same identity (Tenant, attempt, provider, key, evidence kind) arrived with another content: the
--                     first one stays untouched and the disagreement is appended to the conflict trace (once per content);
--   UNBOUND           the Tenant, intent and attempt do not belong together;
--   NOT_SUBMITTED     the attempt provably submitted nothing (NOT_ATTEMPTED, or no request made because the deployment was not
--                     configured), so there is nothing to observe;
--   PROVIDER_MISMATCH the observation names another provider (or another provider reference) than the attempt or its earlier
--                     observations are already bound to: an outcome never moves to another provider identity.
-- The same provider key with ANOTHER evidence kind is a new observation (a bounce after an acceptance keeps the acceptance).
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
  IF attempt_state = 'NOT_ATTEMPTED'
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
--> statement-breakpoint
-- Links a LATER attempt of the SAME intent to the attempt it follows (Technical Retry). Structure only: it checks that both
-- attempts belong to the intent, that the later one is the very next number, that the earlier one is finished, and that the
-- basis named is a fact that exists and is not contradicted. Whether a retry is allowed is decided by the recovery lane before
-- it begins the attempt. Idempotent for the same link. The bases:
--   PRIOR_NOT_ATTEMPTED        nothing was submitted: the attempt is NOT_ATTEMPTED, or no request was made because the
--                              deployment was not configured (UNAVAILABLE with reason `configuration`);
--   PRIOR_REJECTED             the provider provably refused the submission: nothing was accepted (REJECTED);
--   RECONCILED_NON_ACCEPTANCE  a recorded proof of non-acceptance of THAT attempt (the unknown effect of an unavailable or
--                              indeterminate attempt ends only here).
-- An ACCEPTED attempt has no basis at all, and an attempt with an observation that proves a presence (acceptance, delivery,
-- a failure after acceptance) never has one: contradictory evidence is never resolved in favour of sending.
--   LINKED / EXISTS   the link was written / the same link already exists;
--   CONFLICT          the attempt is already linked to another previous attempt;
--   MISSING           an attempt does not belong to this intent in this Tenant;
--   ORDER             the later attempt is not the next number after the earlier one;
--   NOT_FINISHED      the earlier attempt is still PREPARED: its effect is unknown and nothing follows it;
--   BASIS_MISSING     the named basis does not exist for the earlier attempt, or its evidence contradicts it.
CREATE OR REPLACE FUNCTION "communications"."worker_link_retry_attempt"(
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
  previous_evidence jsonb;
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
  SELECT attempt."attempt_number", attempt."state", attempt."evidence" INTO previous_number, previous_state, previous_evidence FROM "communications"."delivery_attempts" AS attempt
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
  IF p_basis_kind NOT IN ('PRIOR_NOT_ATTEMPTED', 'PRIOR_REJECTED', 'RECONCILED_NON_ACCEPTANCE') OR previous_state = 'ACCEPTED' THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'BASIS_MISSING');
    RETURN;
  END IF;
  IF p_basis_kind = 'PRIOR_NOT_ATTEMPTED' AND NOT (
    previous_state = 'NOT_ATTEMPTED' OR (previous_state = 'UNAVAILABLE' AND (previous_evidence ->> 'reason') = 'configuration')) THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'BASIS_MISSING');
    RETURN;
  END IF;
  IF p_basis_kind = 'PRIOR_REJECTED' AND previous_state <> 'REJECTED' THEN
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
  IF EXISTS (
    SELECT 1 FROM "communications"."provider_observations" AS observation
    WHERE observation."tenant_id" = p_tenant_id AND observation."attempt_id" = p_previous_attempt_id
      AND observation."kind" IN ('ACCEPTANCE_PROVEN', 'DELIVERY_FAILED', 'DELIVERY_PROVEN')) THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'BASIS_MISSING');
    RETURN;
  END IF;
  INSERT INTO "communications"."attempt_retry_links" (
    "attempt_id", "tenant_id", "intent_id", "previous_attempt_id", "reason_code", "basis_kind", "basis_observation_id", "linked_at")
  VALUES (p_attempt_id, p_tenant_id, p_intent_id, p_previous_attempt_id, p_reason_code, p_basis_kind, p_basis_observation_id, clock_timestamp());
  RETURN QUERY SELECT jsonb_build_object('outcome', 'LINKED');
END;
$$;
