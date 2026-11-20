-- Privacy measure handoff and execution evidence (#1410): forced Tenant isolation, least-privilege grants, append-only guards and the
-- scoped routines that record and read them. Typed Drizzle owns the tables, their keys, checks and policies in the preceding generated
-- migration. Forward only.
--
-- Both tables are written ONLY by their routines, so the runtime role can read them and nothing else, and both are append-only whatever
-- the role: a recorded handoff and a recorded piece of evidence are never edited or removed. The tables hold only Privacy's opaque
-- identities, digests, links to owner records, a correlation id and a system write time: no subject, lookup, address, actor or free text.
-- The evidence only RECORDS what a human confirmed; nothing here executes anything.
ALTER TABLE "communications"."privacy_measure_handoffs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "communications"."privacy_execution_evidence" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "communications"."privacy_measure_handoffs" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON TABLE "communications"."privacy_execution_evidence" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT SELECT ON TABLE "communications"."privacy_measure_handoffs" TO "ontos_runtime";
--> statement-breakpoint
GRANT SELECT ON TABLE "communications"."privacy_execution_evidence" TO "ontos_runtime";
--> statement-breakpoint
CREATE TRIGGER "communications_privacy_handoffs_append_only" BEFORE UPDATE OR DELETE ON "communications"."privacy_measure_handoffs" FOR EACH ROW EXECUTE FUNCTION "communications"."reject_intake_fact_mutation"();
--> statement-breakpoint
CREATE TRIGGER "communications_privacy_evidence_append_only" BEFORE UPDATE OR DELETE ON "communications"."privacy_execution_evidence" FOR EACH ROW EXECUTE FUNCTION "communications"."reject_intake_fact_mutation"();
--> statement-breakpoint
-- The document of one stored handoff, exactly as every routine answers it. Only the routines below call it.
CREATE FUNCTION "communications"."privacy_measure_handoff_json"(p_handoff "communications"."privacy_measure_handoffs")
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
    'receivedAt', to_char(p_handoff."received_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
$$;
--> statement-breakpoint
-- The document of one stored piece of evidence, exactly as every routine answers it. Only the routines below call it.
CREATE FUNCTION "communications"."privacy_execution_evidence_json"(p_evidence "communications"."privacy_execution_evidence")
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'evidenceRef', p_evidence."evidence_ref",
    'phase', p_evidence."phase",
    'results', p_evidence."results",
    'scopeDigest', p_evidence."scope_digest",
    'confirmationInvocationId', p_evidence."confirmation_invocation_id",
    'recordedAt', to_char(p_evidence."recorded_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "communications"."privacy_measure_handoff_json"("communications"."privacy_measure_handoffs") FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "communications"."privacy_execution_evidence_json"("communications"."privacy_execution_evidence") FROM PUBLIC;
--> statement-breakpoint
-- Records that Privacy handed over ONE measure: the first writer of an idempotency key wins and the stored record is always what is
-- returned. Outcomes: RECORDED (this call stored it), EXISTS (the same handoff, by its fingerprint, was already stored), CONFLICT (a
-- stored record under this key has a different fingerprint; the stored one is returned and nothing changes).
CREATE FUNCTION "communications"."worker_record_privacy_measure_handoff"(
  p_tenant_id uuid, p_idempotency_key text, p_measure_id text, p_task_id text, p_source_decision_ref text,
  p_source_decision_revision integer, p_handoff_fingerprint text, p_scope_digest text, p_target_content_refs jsonb,
  p_originator_invocation_id uuid
)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  inserted integer;
  stored "communications"."privacy_measure_handoffs"%ROWTYPE;
BEGIN
  PERFORM "communications"."assert_worker_scope"(p_tenant_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('communications.privacy-handoff:' || p_tenant_id::text || ':' || p_idempotency_key, 0));
  INSERT INTO "communications"."privacy_measure_handoffs" (
    "tenant_id", "idempotency_key", "measure_id", "task_id", "source_decision_ref", "source_decision_revision",
    "handoff_fingerprint", "scope_digest", "target_content_refs", "originator_invocation_id", "received_at")
  VALUES (
    p_tenant_id, p_idempotency_key, p_measure_id, p_task_id, p_source_decision_ref, p_source_decision_revision,
    p_handoff_fingerprint, p_scope_digest, p_target_content_refs, p_originator_invocation_id, clock_timestamp())
  ON CONFLICT ("tenant_id", "idempotency_key") DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  SELECT * INTO stored FROM "communications"."privacy_measure_handoffs" AS handoff
    WHERE handoff."tenant_id" = p_tenant_id AND handoff."idempotency_key" = p_idempotency_key;
  RETURN QUERY SELECT jsonb_build_object(
    'outcome', CASE
      WHEN inserted = 1 THEN 'RECORDED'
      WHEN stored."handoff_fingerprint" = p_handoff_fingerprint THEN 'EXISTS'
      ELSE 'CONFLICT' END,
    'record', "communications"."privacy_measure_handoff_json"(stored));
END;
$$;
--> statement-breakpoint
-- Reads the handoff of one idempotency key and every piece of evidence recorded for it (oldest first). `record` is null when no
-- handoff was recorded under the key.
CREATE FUNCTION "communications"."read_privacy_measure_handoff"(p_tenant_id uuid, p_idempotency_key text)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM "communications"."assert_worker_scope"(p_tenant_id);
  RETURN QUERY SELECT jsonb_build_object(
    'record', (
      SELECT "communications"."privacy_measure_handoff_json"(handoff)
      FROM "communications"."privacy_measure_handoffs" AS handoff
      WHERE handoff."tenant_id" = p_tenant_id AND handoff."idempotency_key" = p_idempotency_key),
    'evidence', coalesce((
      SELECT jsonb_agg("communications"."privacy_execution_evidence_json"(evidence) ORDER BY evidence."recorded_at", evidence."evidence_ref")
      FROM "communications"."privacy_execution_evidence" AS evidence
      WHERE evidence."tenant_id" = p_tenant_id AND evidence."idempotency_key" = p_idempotency_key), '[]'::jsonb));
END;
$$;
--> statement-breakpoint
-- Records ONE piece of human-confirmed evidence about the execution of a handed-over measure. It only records: nothing here executes
-- anything. Outcomes: NO_HANDOFF (no handoff was recorded under the key), SCOPE_MISMATCH (the evidence is about another scope than
-- the handoff's digest), TARGET_MISMATCH (a result names a content ref the handoff does not target), RECORDED (this call stored it),
-- EXISTS (the same evidence ref was already stored with identical content) and CONFLICT (the same evidence ref is stored with
-- different content; the stored one is returned and nothing changes). The answer carries the stored evidence of the ref when there is one.
CREATE FUNCTION "communications"."record_privacy_execution_evidence"(
  p_tenant_id uuid, p_evidence_ref text, p_idempotency_key text, p_phase text, p_results jsonb, p_scope_digest text,
  p_confirmation_invocation_id uuid
)
RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  inserted integer := 0;
  outcome text;
  has_stored boolean;
  handoff "communications"."privacy_measure_handoffs"%ROWTYPE;
  stored "communications"."privacy_execution_evidence"%ROWTYPE;
BEGIN
  PERFORM "communications"."assert_worker_scope"(p_tenant_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('communications.privacy-handoff:' || p_tenant_id::text || ':' || p_idempotency_key, 0));
  SELECT * INTO handoff FROM "communications"."privacy_measure_handoffs" AS recorded
    WHERE recorded."tenant_id" = p_tenant_id AND recorded."idempotency_key" = p_idempotency_key;
  IF NOT FOUND THEN
    outcome := 'NO_HANDOFF';
  ELSIF p_scope_digest IS DISTINCT FROM handoff."scope_digest" THEN
    outcome := 'SCOPE_MISMATCH';
  ELSIF jsonb_typeof(p_results) = 'array' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_results) AS item("value")
    WHERE jsonb_typeof(item."value" -> 'contentRef') = 'string'
      AND NOT handoff."target_content_refs" @> jsonb_build_array(item."value" ->> 'contentRef')
  ) THEN
    outcome := 'TARGET_MISMATCH';
  ELSE
    INSERT INTO "communications"."privacy_execution_evidence" (
      "tenant_id", "evidence_ref", "idempotency_key", "phase", "results", "scope_digest", "confirmation_invocation_id",
      "recorded_at")
    VALUES (
      p_tenant_id, p_evidence_ref, p_idempotency_key, p_phase, p_results, p_scope_digest, p_confirmation_invocation_id,
      clock_timestamp())
    ON CONFLICT ("tenant_id", "evidence_ref") DO NOTHING;
    GET DIAGNOSTICS inserted = ROW_COUNT;
  END IF;
  SELECT * INTO stored FROM "communications"."privacy_execution_evidence" AS evidence
    WHERE evidence."tenant_id" = p_tenant_id AND evidence."evidence_ref" = p_evidence_ref;
  has_stored := FOUND;
  IF outcome IS NULL THEN
    outcome := CASE
      WHEN inserted = 1 THEN 'RECORDED'
      WHEN stored."idempotency_key" = p_idempotency_key AND stored."phase" = p_phase AND stored."results" = p_results
        AND stored."scope_digest" = p_scope_digest AND stored."confirmation_invocation_id" = p_confirmation_invocation_id THEN 'EXISTS'
      ELSE 'CONFLICT' END;
  END IF;
  IF has_stored THEN
    RETURN QUERY SELECT jsonb_build_object('outcome', outcome, 'evidence', "communications"."privacy_execution_evidence_json"(stored));
  ELSE
    RETURN QUERY SELECT jsonb_build_object('outcome', outcome);
  END IF;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "communications"."worker_record_privacy_measure_handoff"(uuid, text, text, text, text, integer, text, text, jsonb, uuid) FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "communications"."worker_record_privacy_measure_handoff"(uuid, text, text, text, text, integer, text, text, jsonb, uuid) TO "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "communications"."read_privacy_measure_handoff"(uuid, text) FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "communications"."read_privacy_measure_handoff"(uuid, text) TO "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "communications"."record_privacy_execution_evidence"(uuid, text, text, text, jsonb, text, uuid) FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "communications"."record_privacy_execution_evidence"(uuid, text, text, text, jsonb, text, uuid) TO "ontos_runtime";
