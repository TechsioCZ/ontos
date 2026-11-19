-- Forced Tenant isolation, least-privilege grants, append-only guards and the worker's scoped routines for the
-- Communication Request intake (#1401). Typed Drizzle owns the tables, keys, checks and policies in the preceding
-- generated migration; this one adds what typed DDL cannot express.
--
-- Facts are immutable: the runtime role may read and insert requests, decisions, intents and conflicts, never update or
-- delete them. Delivery attempts and handoff stops are written ONLY by the pre-handoff worker through the routines below
-- (the worker holds no table access), so the runtime role can only read them.
ALTER TABLE "communications"."communication_requests" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "communications"."communication_request_conflicts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "communications"."communication_decisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "communications"."message_intents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "communications"."delivery_attempts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "communications"."intent_handoff_stops" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE
  "communications"."communication_requests",
  "communications"."communication_request_conflicts",
  "communications"."communication_decisions",
  "communications"."message_intents",
  "communications"."delivery_attempts",
  "communications"."intent_handoff_stops"
FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE
  "communications"."communication_requests",
  "communications"."communication_request_conflicts",
  "communications"."communication_decisions",
  "communications"."message_intents"
TO "ontos_runtime";
--> statement-breakpoint
GRANT SELECT ON TABLE "communications"."delivery_attempts", "communications"."intent_handoff_stops" TO "ontos_runtime";
--> statement-breakpoint
CREATE FUNCTION "communications"."reject_intake_fact_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'communication intake facts are append-only' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "communications"."reject_intake_fact_mutation"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "communications_requests_append_only" BEFORE UPDATE OR DELETE ON "communications"."communication_requests" FOR EACH ROW EXECUTE FUNCTION "communications"."reject_intake_fact_mutation"();
--> statement-breakpoint
CREATE TRIGGER "communications_request_conflicts_append_only" BEFORE UPDATE OR DELETE ON "communications"."communication_request_conflicts" FOR EACH ROW EXECUTE FUNCTION "communications"."reject_intake_fact_mutation"();
--> statement-breakpoint
CREATE TRIGGER "communications_decisions_append_only" BEFORE UPDATE OR DELETE ON "communications"."communication_decisions" FOR EACH ROW EXECUTE FUNCTION "communications"."reject_intake_fact_mutation"();
--> statement-breakpoint
CREATE TRIGGER "communications_intents_append_only" BEFORE UPDATE OR DELETE ON "communications"."message_intents" FOR EACH ROW EXECUTE FUNCTION "communications"."reject_intake_fact_mutation"();
--> statement-breakpoint
CREATE TRIGGER "communications_handoff_stops_append_only" BEFORE UPDATE OR DELETE ON "communications"."intent_handoff_stops" FOR EACH ROW EXECUTE FUNCTION "communications"."reject_intake_fact_mutation"();
--> statement-breakpoint
-- A delivery attempt is PREPARED once, then finished once. A finished attempt is history and can never change or go.
CREATE FUNCTION "communications"."reject_finished_attempt_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD."state" <> 'PREPARED' THEN
    RAISE EXCEPTION 'a finished delivery attempt is append-only' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "communications"."reject_finished_attempt_mutation"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "communications_attempts_finished_append_only" BEFORE UPDATE OR DELETE ON "communications"."delivery_attempts" FOR EACH ROW EXECUTE FUNCTION "communications"."reject_finished_attempt_mutation"();
--> statement-breakpoint
-- Scoped routines of the owner worker. A worker holds no database executor: Core installs the verified Tenant in the
-- transaction and passes it as the first argument, and each routine refuses a Tenant that is not the installed one.
CREATE FUNCTION "communications"."assert_worker_scope"(p_tenant_id uuid)
RETURNS void
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id IS DISTINCT FROM nullif(current_setting('ontos.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Communications routine scope mismatch';
  END IF;
END;
$$;
--> statement-breakpoint
-- The Tenant's own latest language mode, read in its OWN sub-transaction: any failure of the read is the answer
-- `unreadable` and does not abort the caller's transaction. A Tenant without an own choice answers `none`.
CREATE FUNCTION "communications"."read_language_policy_snapshot"(p_tenant_id uuid)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM "communications"."assert_worker_scope"(p_tenant_id);
  BEGIN
    RETURN QUERY
    SELECT coalesce(
      (SELECT jsonb_build_object(
          'kind', 'own',
          'mode', version."mode",
          'policyVersionId', version."policy_version_id",
          'setAt', to_char(version."set_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'setByPrincipalId', version."set_by_principal_id",
          'versionNumber', version."version_number")
        FROM "communications"."tenant_language_mode_versions" AS version
        WHERE version."tenant_id" = p_tenant_id
        ORDER BY version."version_number" DESC
        LIMIT 1),
      jsonb_build_object('kind', 'none'));
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT jsonb_build_object('kind', 'unreadable');
  END;
END;
$$;
--> statement-breakpoint
-- Everything the last stoppable handoff needs about one intent: the pinned intent, the request it belongs to and the
-- state of its delivery attempt and stop. Read-only. An absent fact is an omitted key, never a null.
CREATE FUNCTION "communications"."worker_read_intent"(p_tenant_id uuid, p_intent_id uuid)
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
    'attempt', (SELECT jsonb_build_object('attemptId', attempt."attempt_id", 'state', attempt."state")
      FROM "communications"."delivery_attempts" AS attempt
      WHERE attempt."tenant_id" = intent."tenant_id" AND attempt."intent_id" = intent."intent_id"
        AND attempt."attempt_number" = 1),
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
-- The Template Types of one exact message type, channel and scope (both languages) with their activations, the
-- revisions an activation or the pin names (text included, as the owner's own port returns it) and their invalidations,
-- so the SAME domain code that resolved and verified pins in the Action can run in the worker over a consistent read.
CREATE FUNCTION "communications"."worker_read_template_snapshot"(
  p_tenant_id uuid, p_message_type text, p_channel text, p_scope_key text, p_pinned_revision_id uuid
)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM "communications"."assert_worker_scope"(p_tenant_id);
  RETURN QUERY
  WITH template_type AS (
    SELECT t.* FROM "communications"."template_types" AS t
    WHERE t."tenant_id" = p_tenant_id AND t."message_type" = p_message_type AND t."channel" = p_channel
      AND t."scope_key" = p_scope_key
  ),
  activation AS (
    SELECT a.* FROM "communications"."template_activations" AS a
    WHERE a."tenant_id" = p_tenant_id AND a."template_type_id" IN (SELECT "template_type_id" FROM template_type)
  ),
  revision AS (
    SELECT r.* FROM "communications"."template_revisions" AS r
    WHERE r."tenant_id" = p_tenant_id
      AND (r."revision_id" = p_pinned_revision_id OR r."revision_id" IN (SELECT "revision_id" FROM activation))
  )
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'now', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'types', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'templateTypeId', t."template_type_id", 'channel', t."channel", 'language', t."language",
        'legalEntityId', t."legal_entity_id", 'messageType', t."message_type", 'scopeKey', t."scope_key",
        'scopeKind', t."scope_kind", 'createdAt', to_char(t."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'createdByPrincipalId', t."created_by_principal_id")) FROM template_type AS t), '[]'::jsonb),
    'activations', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'activationId', a."activation_id", 'templateTypeId', a."template_type_id", 'revisionId', a."revision_id",
        'scopeKey', a."scope_key",
        'activatedAt', to_char(a."activated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'activatedByPrincipalId', a."activated_by_principal_id", 'activationReason', a."activation_reason",
        'endedAt', to_char(a."ended_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'endedByPrincipalId', a."ended_by_principal_id", 'endedKind', a."ended_kind", 'endReason', a."end_reason"))
      FROM activation AS a), '[]'::jsonb),
    'revisions', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'revisionId', r."revision_id", 'templateTypeId', r."template_type_id", 'revisionNumber', r."revision_number",
        'subject', r."subject", 'body', r."body", 'contentDigest', r."content_digest", 'reason', r."reason",
        'createdAt', to_char(r."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'createdByPrincipalId', r."created_by_principal_id",
        'optionalPlaceholders', r."optional_placeholders", 'requiredPlaceholders', r."required_placeholders",
        'placeholdersUsed', r."placeholders_used")) FROM revision AS r), '[]'::jsonb),
    'invalidations', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'revisionId', i."revision_id", 'reason', i."reason",
        'invalidatedAt', to_char(i."invalidated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'invalidatedByPrincipalId', i."invalidated_by_principal_id"))
      FROM "communications"."template_revision_invalidations" AS i
      WHERE i."tenant_id" = p_tenant_id AND i."revision_id" IN (SELECT "revision_id" FROM revision)), '[]'::jsonb)));
END;
$$;
--> statement-breakpoint
-- The single-flight guard of one intent's handoff. The attempt is recorded BEFORE the handoff is called, so a worker
-- that crashes after the call leaves evidence that an effect may exist; no later processing may then resend blindly.
-- Outcomes: BEGUN (this caller owns the one attempt), EXISTS (an attempt already exists: the caller must not call out),
-- STOPPED (the intent was stopped at an earlier handoff check) and MISSING (no such intent in this Tenant).
CREATE FUNCTION "communications"."worker_begin_attempt"(p_tenant_id uuid, p_intent_id uuid, p_attempt_id uuid)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  existing_state text;
BEGIN
  PERFORM "communications"."assert_worker_scope"(p_tenant_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('communications.intent-handoff:' || p_tenant_id::text || ':' || p_intent_id::text, 0));
  IF NOT EXISTS (SELECT 1 FROM "communications"."message_intents" WHERE "tenant_id" = p_tenant_id AND "intent_id" = p_intent_id) THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'MISSING');
    RETURN;
  END IF;
  SELECT attempt."state" INTO existing_state FROM "communications"."delivery_attempts" AS attempt
    WHERE attempt."tenant_id" = p_tenant_id AND attempt."intent_id" = p_intent_id AND attempt."attempt_number" = 1;
  IF FOUND THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'EXISTS', 'state', existing_state);
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM "communications"."intent_handoff_stops" AS stop WHERE stop."tenant_id" = p_tenant_id AND stop."intent_id" = p_intent_id) THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'STOPPED');
    RETURN;
  END IF;
  INSERT INTO "communications"."delivery_attempts" ("attempt_id", "tenant_id", "intent_id", "attempt_number", "state", "prepared_at")
  VALUES (p_attempt_id, p_tenant_id, p_intent_id, 1, 'PREPARED', clock_timestamp());
  RETURN QUERY SELECT jsonb_build_object('outcome', 'BEGUN');
END;
$$;
--> statement-breakpoint
-- Records why one intent stops at its last stoppable handoff. Idempotent; refused once an attempt exists, because a
-- message that may have left is reconciled, never "stopped".
CREATE FUNCTION "communications"."worker_record_stop"(p_tenant_id uuid, p_intent_id uuid, p_reasons jsonb)
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
  IF EXISTS (SELECT 1 FROM "communications"."delivery_attempts" AS attempt WHERE attempt."tenant_id" = p_tenant_id AND attempt."intent_id" = p_intent_id) THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', 'ATTEMPT_EXISTS');
    RETURN;
  END IF;
  INSERT INTO "communications"."intent_handoff_stops" ("tenant_id", "intent_id", "reasons", "recorded_at")
  VALUES (p_tenant_id, p_intent_id, p_reasons, clock_timestamp())
  ON CONFLICT ("tenant_id", "intent_id") DO NOTHING;
  RETURN QUERY SELECT jsonb_build_object('outcome', 'STOPPED');
END;
$$;
--> statement-breakpoint
-- Finishes the one PREPARED attempt with the provider evidence. Idempotent for the same final state; a different final
-- state for an already finished attempt is reported as CONFLICT and changes nothing.
CREATE FUNCTION "communications"."worker_finish_attempt"(p_tenant_id uuid, p_attempt_id uuid, p_state text, p_evidence jsonb)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  current_state text;
BEGIN
  PERFORM "communications"."assert_worker_scope"(p_tenant_id);
  IF p_state NOT IN ('ACCEPTED', 'REJECTED', 'UNAVAILABLE', 'INDETERMINATE') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A delivery attempt can only be finished with a provider outcome';
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
REVOKE ALL ON FUNCTION
  "communications"."assert_worker_scope"(uuid),
  "communications"."read_language_policy_snapshot"(uuid),
  "communications"."worker_read_intent"(uuid, uuid),
  "communications"."worker_read_template_snapshot"(uuid, text, text, text, uuid),
  "communications"."worker_begin_attempt"(uuid, uuid, uuid),
  "communications"."worker_record_stop"(uuid, uuid, jsonb),
  "communications"."worker_finish_attempt"(uuid, uuid, text, jsonb)
FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  "communications"."read_language_policy_snapshot"(uuid),
  "communications"."worker_read_intent"(uuid, uuid),
  "communications"."worker_read_template_snapshot"(uuid, text, text, text, uuid),
  "communications"."worker_begin_attempt"(uuid, uuid, uuid),
  "communications"."worker_record_stop"(uuid, uuid, jsonb),
  "communications"."worker_finish_attempt"(uuid, uuid, text, jsonb)
TO "ontos_runtime";
-- `assert_worker_scope` stays internal: the definer routines call it as their owner, so the runtime role needs no EXECUTE.
