ALTER TABLE "commerce_customer_context"."market_retirement_reservations" ADD COLUMN "composition_revision" text;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."market_retirement_reservations" ADD COLUMN "original_actor_principal_id" uuid;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."market_retirement_reservations" ADD COLUMN "original_assessment" jsonb;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."market_retirement_reservations" ADD COLUMN "original_reason" text;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."market_retirement_reservations" ADD COLUMN "original_reservation_version" integer;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."market_retirement_reservations" ADD COLUMN "release_guard_hash" text;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."market_retirement_reservations" ADD COLUMN "source_action_invocation_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "ccc_market_retirement_reservations_source_uk" ON "commerce_customer_context"."market_retirement_reservations" ("tenant_id","legal_entity_id","original_actor_principal_id","source_action_invocation_id") WHERE "source_action_invocation_id" is not null;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."market_retirement_reservations" ADD CONSTRAINT "ccc_market_retirement_reservations_source_ck" CHECK ((
      "source_action_invocation_id" is null and "original_actor_principal_id" is null
      and "original_reason" is null and "composition_revision" is null
      and "release_guard_hash" is null and "original_reservation_version" is null
      and "original_assessment" is null
    ) or (
      "source_action_invocation_id" is not null and "original_actor_principal_id" is not null
      and "original_reason" is not null and length(btrim("original_reason")) between 1 and 500
      and "original_reason" = btrim("original_reason")
      and "composition_revision" is not null and "composition_revision" ~ '^[a-f0-9]{64}$'
      and "release_guard_hash" is not null and "release_guard_hash" ~ '^[a-f0-9]{64}$'
      and "original_reservation_version" is not null and "original_reservation_version" = 1
      and "original_assessment" is not null and jsonb_typeof("original_assessment") = 'object'
      and ("original_assessment"->>'outcome') is not distinct from 'VERIFIED'
    ));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "commerce_customer_context"."reserve_market_retirement"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_input jsonb
) RETURNS TABLE(result jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, commerce_customer_context, pg_temp
AS $routine$
DECLARE
  v_action_invocation_id uuid;
  v_actor_principal_id uuid;
  v_source_action_invocation_id uuid;
  v_admitted_composition_revision text;
  v_release_guard_hash text;
  v_release_proof text;
  v_original_assessment jsonb;
  v_assessment jsonb;
  v_assessment_digest text;
  v_composition_evidence jsonb;
  v_composition_module text;
  v_composition_observed_at text;
  v_composition_revision text;
  v_composition_valid_until text;
  v_current_local_evidence jsonb;
  v_digest_input jsonb;
  v_evaluated_at timestamptz;
  v_existing market_retirement_reservations%ROWTYPE;
  v_market_resource_id text;
  v_market_revision integer;
  v_operation text;
  v_reason text;
  v_reservation_token uuid;
  v_reservation_version integer;
  v_sorted_source_evidence jsonb;
  v_source_evidence jsonb;
  v_supplied_local_evidence jsonb;
  v_expected_assessment_digest text;
BEGIN
  PERFORM assert_customer_commerce_policy_scope(p_tenant_id, p_legal_entity_id);
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid Market retirement reservation input'
      USING ERRCODE = '22023', CONSTRAINT = 'market_retirement_reservation_invalid';
  END IF;
  BEGIN
    v_action_invocation_id := (p_input->>'actionInvocationId')::uuid;
    v_actor_principal_id := (p_input->>'actorPrincipalId')::uuid;
    v_source_action_invocation_id := nullif(p_input->>'sourceActionInvocationId', '')::uuid;
    v_market_revision := (p_input->>'marketRevision')::integer;
    v_reservation_token := nullif(p_input->>'reservationToken', '')::uuid;
    v_reservation_version := nullif(p_input->>'reservationVersion', '')::integer;
    v_evaluated_at := nullif(p_input->>'evaluatedAt', '')::timestamptz;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN
    RAISE EXCEPTION 'invalid Market retirement reservation input'
      USING ERRCODE = '22023', CONSTRAINT = 'market_retirement_reservation_invalid';
  END;
  v_admitted_composition_revision := p_input->>'compositionRevision';
  v_release_guard_hash := p_input->>'releaseGuardHash';
  v_release_proof := p_input->>'releaseProof';
  v_original_assessment := p_input->'originalAssessment';
  v_operation := p_input->>'operation';
  v_reason := nullif(btrim(p_input->>'reason'), '');
  v_market_resource_id := p_input->'marketRef'->>'resourceId';
  v_assessment_digest := p_input->>'assessmentDigest';
  v_source_evidence := p_input->'sourceEvidence';

  IF v_action_invocation_id IS NULL OR v_actor_principal_id IS NULL
     OR v_operation IS NULL OR v_operation NOT IN ('RESERVE', 'COMMIT', 'RELEASE')
     OR (v_source_action_invocation_id IS NOT NULL AND (
       v_operation <> 'RESERVE' OR v_admitted_composition_revision IS NULL
       OR v_admitted_composition_revision !~ '^[a-f0-9]{64}$'
       OR v_release_guard_hash IS NULL OR v_release_guard_hash !~ '^[a-f0-9]{64}$'
     ))
     OR (v_source_action_invocation_id IS NULL AND (v_release_guard_hash IS NOT NULL OR v_original_assessment IS NOT NULL))
     OR (v_release_proof IS NOT NULL AND v_operation <> 'RELEASE')
     OR v_reason IS NULL OR length(v_reason) > 500
     OR v_market_resource_id IS NULL OR v_market_resource_id <> btrim(v_market_resource_id)
     OR length(v_market_resource_id) NOT BETWEEN 1 AND 1000
     OR v_market_revision IS NULL OR v_market_revision < 1
     OR p_input->>'tenantId' IS DISTINCT FROM p_tenant_id::text
     OR p_input->'marketRef'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
     OR p_input->'marketRef'->>'moduleId' IS DISTINCT FROM 'commerce.market-catalog'
     OR p_input->'marketRef'->>'resourceType' IS DISTINCT FROM 'commerce.market-catalog.market'
  THEN
    RAISE EXCEPTION 'invalid Market retirement reservation input'
      USING ERRCODE = '22023', CONSTRAINT = 'market_retirement_reservation_invalid';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text || ':' || p_legal_entity_id::text || ':market-retirement:' || v_market_resource_id,
    0
  ));

  IF v_operation = 'RESERVE' THEN
    IF v_reservation_token IS NOT NULL OR v_reservation_version IS NOT NULL
       OR v_evaluated_at IS NULL OR v_evaluated_at > statement_timestamp()
       OR v_assessment_digest IS NULL OR v_assessment_digest !~ '^[0-9a-f]{64}$'
       OR jsonb_typeof(v_source_evidence) IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_source_evidence) <> 4
       OR (SELECT count(*) FROM jsonb_array_elements(v_source_evidence))
          <> (SELECT count(DISTINCT item->>'sourceId') FROM jsonb_array_elements(v_source_evidence) AS evidence(item))
       OR EXISTS (
         SELECT 1
         FROM (VALUES
           ('commerce.customer-context.market-bootstrap-policy'),
           ('commerce.customer-context.purchase-proposals'),
           ('application-composition:commerce.cart:UNIMPLEMENTED'),
           ('application-composition:commerce.order:UNIMPLEMENTED')
         ) AS required(source_id)
         WHERE (SELECT count(*) FROM jsonb_array_elements(v_source_evidence) AS evidence(item)
                WHERE item->>'sourceId' = required.source_id) <> 1
       )
    THEN
      RAISE EXCEPTION 'invalid Market retirement reservation input'
        USING ERRCODE = '22023', CONSTRAINT = 'market_retirement_reservation_invalid';
    END IF;

    BEGIN
      IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_source_evidence) AS evidence(item)
        WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
           OR item->>'currentness' IS DISTINCT FROM 'CURRENT'
           OR item->>'ownerRevision' IS NULL
           OR item->>'ownerRevision' IS DISTINCT FROM item->'completenessEvidence'->>'ownerRevision'
           OR item->>'generation' IS DISTINCT FROM item->>'ownerRevision'
           OR item->>'digest' !~ '^[0-9a-f]{64}$'
           OR (item->'completenessEvidence'->>'observedAt')::timestamptz > v_evaluated_at
           OR (
             item->'completenessEvidence' ? 'nextApplicabilityBoundary'
             AND (item->'completenessEvidence'->>'nextApplicabilityBoundary')::timestamptz <= statement_timestamp()
           )
      ) THEN
        RAISE EXCEPTION 'Market retirement source evidence is stale or internally inconsistent'
          USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_conflict';
      END IF;
    EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
      RAISE EXCEPTION 'Market retirement source evidence timestamps are invalid'
        USING ERRCODE = '22023', CONSTRAINT = 'market_retirement_reservation_invalid';
    END;

    FOR v_composition_module IN SELECT unnest(ARRAY['commerce.cart', 'commerce.order']) LOOP
      SELECT item INTO v_composition_evidence
      FROM jsonb_array_elements(v_source_evidence) AS evidence(item)
      WHERE item->>'sourceId' = format('application-composition:%s:UNIMPLEMENTED', v_composition_module);
      IF v_composition_evidence->'completenessEvidence'->>'nextApplicabilityBoundary' IS NULL
         OR v_composition_evidence->'completenessEvidence'->'scope'->>'kind' IS DISTINCT FROM 'SAFELY_BROADER_SCOPE'
         OR v_composition_evidence->'completenessEvidence'->'scope'->>'predicateRef'
            IS DISTINCT FROM format('application-composition:module:%s:absent', v_composition_module)
         OR v_composition_evidence->'completenessEvidence'->'scope'->>'declaredScopeRef'
            IS DISTINCT FROM format('application-composition:%s', v_composition_evidence->>'ownerRevision')
         OR v_composition_evidence->>'digest' IS DISTINCT FROM encode(sha256(
           convert_to(v_composition_evidence->>'ownerRevision', 'UTF8') || decode('00', 'hex') ||
           convert_to(v_composition_module, 'UTF8') || decode('00', 'hex') ||
           convert_to('UNIMPLEMENTED', 'UTF8')
         ), 'hex')
      THEN
        RAISE EXCEPTION 'Application Composition absence proof is missing or substituted'
          USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_conflict';
      END IF;
      IF v_composition_revision IS NULL THEN
        v_composition_revision := v_composition_evidence->>'ownerRevision';
        v_composition_observed_at := v_composition_evidence->'completenessEvidence'->>'observedAt';
        v_composition_valid_until := v_composition_evidence->'completenessEvidence'->>'nextApplicabilityBoundary';
      ELSIF v_composition_evidence->>'ownerRevision' IS DISTINCT FROM v_composition_revision
         OR v_composition_evidence->'completenessEvidence'->>'observedAt' IS DISTINCT FROM v_composition_observed_at
         OR v_composition_evidence->'completenessEvidence'->>'nextApplicabilityBoundary'
            IS DISTINCT FROM v_composition_valid_until
      THEN
        RAISE EXCEPTION 'Application Composition proofs do not describe one active snapshot'
          USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_conflict';
      END IF;
    END LOOP;
    IF v_source_action_invocation_id IS NOT NULL
       AND v_admitted_composition_revision IS DISTINCT FROM v_composition_revision THEN
      RAISE EXCEPTION 'reservation source revision does not match authoritative Composition evidence'
        USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_conflict';
    END IF;
    SELECT jsonb_agg(item ORDER BY item->>'sourceId')
      INTO v_source_evidence
      FROM jsonb_array_elements(v_source_evidence) AS evidence(item);

    IF v_source_action_invocation_id IS NOT NULL AND (
      jsonb_typeof(v_original_assessment) IS DISTINCT FROM 'object'
      OR v_original_assessment->>'outcome' IS DISTINCT FROM 'VERIFIED'
      OR v_original_assessment->'marketRef' IS DISTINCT FROM p_input->'marketRef'
      OR v_original_assessment->>'tenantId' IS DISTINCT FROM p_tenant_id::text
      OR v_original_assessment->'marketRevision' IS DISTINCT FROM p_input->'marketRevision'
      OR v_original_assessment->>'evaluatedAt' IS DISTINCT FROM p_input->>'evaluatedAt'
      OR v_original_assessment->>'assessmentDigest' IS DISTINCT FROM v_assessment_digest
      OR v_original_assessment->'sourceEvidence' IS DISTINCT FROM v_source_evidence
    ) THEN
      RAISE EXCEPTION 'original assessment does not match reservation identity and evidence'
        USING ERRCODE = '22023', CONSTRAINT = 'market_retirement_reservation_invalid';
    END IF;

    SELECT reservation.* INTO v_existing
      FROM market_retirement_reservations AS reservation
     WHERE reservation.tenant_id = p_tenant_id
       AND reservation.legal_entity_id = p_legal_entity_id
       AND reservation.action_invocation_id = v_action_invocation_id
     FOR UPDATE;
    IF FOUND THEN
      IF v_existing.market_resource_id IS DISTINCT FROM v_market_resource_id
         OR v_existing.market_revision IS DISTINCT FROM v_market_revision
         OR v_existing.assessment_digest IS DISTINCT FROM v_assessment_digest
         OR v_existing.evaluated_at IS DISTINCT FROM v_evaluated_at
         OR v_existing.source_evidence IS DISTINCT FROM v_source_evidence
         OR v_existing.lifecycle = 'RELEASED'
         OR v_existing.source_action_invocation_id IS DISTINCT FROM v_source_action_invocation_id
         OR (v_source_action_invocation_id IS NOT NULL AND (
           v_existing.original_actor_principal_id IS DISTINCT FROM v_actor_principal_id
           OR v_existing.original_reason IS DISTINCT FROM v_reason
           OR v_existing.composition_revision IS DISTINCT FROM v_admitted_composition_revision
           OR v_existing.release_guard_hash IS DISTINCT FROM v_release_guard_hash
           OR v_existing.original_assessment IS DISTINCT FROM v_original_assessment
         ))
      THEN
        RAISE EXCEPTION 'Market retirement reservation conflicts with existing Action evidence'
          USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_conflict';
      END IF;
    ELSE
      IF EXISTS (
        SELECT 1 FROM market_retirement_reservations AS reservation
         WHERE reservation.tenant_id = p_tenant_id
           AND reservation.legal_entity_id = p_legal_entity_id
           AND reservation.market_resource_id = v_market_resource_id
           AND reservation.lifecycle IN ('RESERVED', 'COMMITTED')
      ) THEN
        RAISE EXCEPTION 'another Market retirement reservation is active'
          USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_conflict';
      END IF;

      SELECT assessment.result INTO v_assessment
        FROM assess_market_retirement_affected_use(
          p_tenant_id, p_legal_entity_id, v_market_resource_id, v_market_revision, v_evaluated_at
        ) AS assessment;
      IF jsonb_array_length(v_assessment->'liveBlockingReferences'->'bootstrapDefaults') > 0
         OR jsonb_array_length(v_assessment->'liveBlockingReferences'->'currentProposals') > 0
      THEN
        RAISE EXCEPTION 'live Customer Context references block Market retirement'
          USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_conflict';
      END IF;
      v_current_local_evidence := v_assessment->'sourceEvidence';
      SELECT coalesce(jsonb_agg(item ORDER BY item->>'sourceId'), '[]'::jsonb)
        INTO v_supplied_local_evidence
        FROM jsonb_array_elements(v_source_evidence) AS evidence(item)
       WHERE item->>'sourceId' IN (
         'commerce.customer-context.market-bootstrap-policy',
         'commerce.customer-context.purchase-proposals'
       );
      IF v_supplied_local_evidence IS DISTINCT FROM v_current_local_evidence THEN
        RAISE EXCEPTION 'Market affected-use evidence changed before reservation'
          USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_conflict';
      END IF;

      v_sorted_source_evidence := v_source_evidence;
      v_digest_input := (v_assessment - 'assessmentDigest' - 'outcome') ||
        jsonb_build_object('sourceEvidence', v_sorted_source_evidence);
      v_expected_assessment_digest := encode(sha256(convert_to(
        canonical_market_retirement_json(v_digest_input), 'UTF8'
      )), 'hex');
      IF v_assessment_digest IS DISTINCT FROM v_expected_assessment_digest THEN
        RAISE EXCEPTION 'Market affected-use aggregate digest does not match the exact owner evidence'
          USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_conflict';
      END IF;

      IF v_source_action_invocation_id IS NOT NULL AND v_original_assessment IS DISTINCT FROM (
        v_assessment || jsonb_build_object('assessmentDigest', v_expected_assessment_digest, 'sourceEvidence', v_sorted_source_evidence)
      ) THEN
        RAISE EXCEPTION 'original assessment differs from verified complete owner assessment'
          USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_conflict';
      END IF;

      INSERT INTO market_retirement_reservations (
        tenant_id, legal_entity_id, market_resource_id, market_revision, assessment_digest,
        source_evidence, evaluated_at, lifecycle, reservation_version, action_invocation_id,
        actor_principal_id, reason, recorded_at, created_at, updated_at,
        source_action_invocation_id, original_actor_principal_id, original_reason, composition_revision,
        release_guard_hash, original_reservation_version, original_assessment
      ) VALUES (
        p_tenant_id, p_legal_entity_id, v_market_resource_id, v_market_revision, v_assessment_digest,
        v_source_evidence, v_evaluated_at, 'RESERVED', 1, v_action_invocation_id,
        v_actor_principal_id, v_reason, now(), now(), now(),
        v_source_action_invocation_id,
        CASE WHEN v_source_action_invocation_id IS NOT NULL THEN v_actor_principal_id END,
        CASE WHEN v_source_action_invocation_id IS NOT NULL THEN v_reason END,
        CASE WHEN v_source_action_invocation_id IS NOT NULL THEN v_admitted_composition_revision END,
        v_release_guard_hash, CASE WHEN v_source_action_invocation_id IS NOT NULL THEN 1 END,
        CASE WHEN v_source_action_invocation_id IS NOT NULL THEN v_original_assessment END
      ) RETURNING * INTO v_existing;
    END IF;
  ELSIF v_operation IN ('COMMIT', 'RELEASE') THEN
    IF v_reservation_token IS NULL OR v_reservation_version IS NULL
       OR v_evaluated_at IS NOT NULL OR v_assessment_digest IS NOT NULL OR v_source_evidence IS NOT NULL
    THEN
      RAISE EXCEPTION 'invalid Market retirement completion input'
        USING ERRCODE = '22023', CONSTRAINT = 'market_retirement_reservation_invalid';
    END IF;
    SELECT reservation.* INTO v_existing
      FROM market_retirement_reservations AS reservation
     WHERE reservation.tenant_id = p_tenant_id
       AND reservation.legal_entity_id = p_legal_entity_id
       AND reservation.market_retirement_reservation_id = v_reservation_token
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Market retirement reservation was not found'
        USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_not_found';
    END IF;
    IF v_existing.market_resource_id IS DISTINCT FROM v_market_resource_id
       OR v_existing.market_revision IS DISTINCT FROM v_market_revision
    THEN
      RAISE EXCEPTION 'Market retirement reservation identity changed'
        USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_conflict';
    END IF;

    IF v_existing.source_action_invocation_id IS NOT NULL THEN
      IF v_existing.original_actor_principal_id IS DISTINCT FROM v_actor_principal_id THEN
        RAISE EXCEPTION 'original reservation actor does not match trusted actor'
          USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_conflict';
      END IF;
      IF v_operation = 'RELEASE' AND (
        v_release_proof IS NULL
        OR v_release_proof !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        OR encode(sha256(convert_to(v_release_proof, 'UTF8')), 'hex') IS DISTINCT FROM v_existing.release_guard_hash
      ) THEN
        RAISE EXCEPTION 'original reservation abort proof is missing or invalid'
          USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_conflict';
      END IF;
    END IF;
    IF v_operation = 'COMMIT' THEN
      IF v_existing.lifecycle = 'RELEASED' THEN
        RAISE EXCEPTION 'released Market retirement reservation cannot be committed'
          USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_conflict';
      ELSIF v_existing.lifecycle = 'COMMITTED' THEN
        IF NOT (
          v_reservation_version = v_existing.reservation_version
          OR (v_existing.last_action_invocation_id = v_action_invocation_id
              AND v_existing.last_operation = 'COMMIT'
              AND v_reservation_version = v_existing.reservation_version - 1)
        ) THEN
          RAISE EXCEPTION 'stale Market retirement reservation version'
            USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_conflict';
        END IF;
      ELSE
        IF v_reservation_version <> v_existing.reservation_version THEN
          RAISE EXCEPTION 'stale Market retirement reservation version'
            USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_conflict';
        END IF;
        UPDATE market_retirement_reservations
           SET lifecycle = 'COMMITTED', reservation_version = reservation_version + 1,
               last_action_invocation_id = v_action_invocation_id, last_operation = 'COMMIT',
               actor_principal_id = v_actor_principal_id, reason = v_reason,
               recorded_at = now(), updated_at = now()
         WHERE market_retirement_reservation_id = v_reservation_token
        RETURNING * INTO v_existing;
      END IF;
    ELSIF v_operation = 'RELEASE' THEN
      IF v_existing.lifecycle = 'COMMITTED' THEN
        RAISE EXCEPTION 'committed Market retirement reservation cannot be released'
          USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_conflict';
      ELSIF v_existing.lifecycle = 'RELEASED' THEN
        IF NOT (
          v_reservation_version = v_existing.reservation_version
          OR (v_existing.last_action_invocation_id = v_action_invocation_id
              AND v_existing.last_operation = 'RELEASE'
              AND v_reservation_version = v_existing.reservation_version - 1)
        ) THEN
          RAISE EXCEPTION 'stale Market retirement reservation version'
            USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_conflict';
        END IF;
      ELSE
        IF v_reservation_version <> v_existing.reservation_version THEN
          RAISE EXCEPTION 'stale Market retirement reservation version'
            USING ERRCODE = 'P0001', CONSTRAINT = 'market_retirement_reservation_conflict';
        END IF;
        UPDATE market_retirement_reservations
           SET lifecycle = 'RELEASED', reservation_version = reservation_version + 1,
               last_action_invocation_id = v_action_invocation_id, last_operation = 'RELEASE',
               actor_principal_id = v_actor_principal_id, reason = v_reason,
               recorded_at = now(), updated_at = now()
         WHERE market_retirement_reservation_id = v_reservation_token
        RETURNING * INTO v_existing;
      END IF;
    ELSE
      RAISE EXCEPTION 'invalid Market retirement completion operation'
        USING ERRCODE = '22023', CONSTRAINT = 'market_retirement_reservation_invalid';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid Market retirement reservation operation'
      USING ERRCODE = '22023', CONSTRAINT = 'market_retirement_reservation_invalid';
  END IF;

  RETURN QUERY SELECT jsonb_build_object(
    'assessmentDigest', v_existing.assessment_digest,
    'lifecycle', v_existing.lifecycle,
    'marketRef', jsonb_build_object(
      'moduleId', 'commerce.market-catalog',
      'resourceId', v_existing.market_resource_id,
      'resourceType', 'commerce.market-catalog.market',
      'tenantId', v_existing.tenant_id::text
    ),
    'marketRevision', v_existing.market_revision,
    'reservationToken', v_existing.market_retirement_reservation_id::text,
    'reservationVersion', v_existing.reservation_version,
    'tenantId', v_existing.tenant_id::text
  );
END
$routine$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."reserve_market_retirement"(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."reserve_market_retirement"(uuid, uuid, jsonb) TO "ontos_runtime";
--> statement-breakpoint

--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.guard_market_retirement_original_provenance()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, commerce_customer_context, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.source_action_invocation_id IS NOT NULL THEN
      RAISE EXCEPTION 'original reservation evidence is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.market_retirement_reservation_id, NEW.tenant_id, NEW.legal_entity_id, NEW.source_action_invocation_id, NEW.original_actor_principal_id, NEW.original_reason,
         NEW.composition_revision, NEW.release_guard_hash, NEW.original_reservation_version, NEW.original_assessment, NEW.action_invocation_id, NEW.market_resource_id, NEW.market_revision,
         NEW.assessment_digest, NEW.source_evidence, NEW.evaluated_at)
     IS DISTINCT FROM
     ROW(OLD.market_retirement_reservation_id, OLD.tenant_id, OLD.legal_entity_id, OLD.source_action_invocation_id, OLD.original_actor_principal_id, OLD.original_reason,
         OLD.composition_revision, OLD.release_guard_hash, OLD.original_reservation_version, OLD.original_assessment, OLD.action_invocation_id, OLD.market_resource_id, OLD.market_revision,
         OLD.assessment_digest, OLD.source_evidence, OLD.evaluated_at) THEN
    RAISE EXCEPTION 'original reservation evidence is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION commerce_customer_context.guard_market_retirement_original_provenance() FROM PUBLIC;
CREATE TRIGGER ccc_market_retirement_original_provenance_immutable
BEFORE UPDATE OR DELETE ON commerce_customer_context.market_retirement_reservations
FOR EACH ROW EXECUTE FUNCTION commerce_customer_context.guard_market_retirement_original_provenance();
--> statement-breakpoint
CREATE FUNCTION commerce_customer_context.recover_market_retirement_reservation(
  p_tenant_id uuid, p_legal_entity_id uuid, p_original_actor_principal_id uuid,
  p_source_action_invocation_id uuid, p_market_resource_id text
) RETURNS TABLE(result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, commerce_customer_context, pg_temp AS $$
DECLARE
  v_reservation commerce_customer_context.market_retirement_reservations%ROWTYPE;
  v_identity jsonb;
BEGIN
  PERFORM commerce_customer_context.assert_customer_commerce_policy_scope(p_tenant_id, p_legal_entity_id);
  IF p_original_actor_principal_id IS NULL OR p_source_action_invocation_id IS NULL
     OR p_market_resource_id IS NULL OR p_market_resource_id <> btrim(p_market_resource_id)
     OR length(btrim(p_market_resource_id)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invalid original reservation lookup' USING ERRCODE = '22023';
  END IF;
  -- Observe after any currently executing reserve/finalize using the existing owner fence.
  -- NOT_FOUND is an exact lookup result, never proof that a delayed future attempt cannot arrive.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text || ':' || p_legal_entity_id::text || ':market-retirement:' || p_market_resource_id, 0
  ));
  v_identity := jsonb_build_object(
    'tenantId', p_tenant_id::text,
    'marketRef', jsonb_build_object('tenantId', p_tenant_id::text, 'moduleId', 'commerce.market-catalog',
      'resourceType', 'commerce.market-catalog.market', 'resourceId', p_market_resource_id),
    'sourceActionInvocationId', p_source_action_invocation_id::text
  );
  SELECT reservation.* INTO v_reservation
    FROM commerce_customer_context.market_retirement_reservations AS reservation
   WHERE reservation.tenant_id = p_tenant_id AND reservation.legal_entity_id = p_legal_entity_id
     AND reservation.original_actor_principal_id = p_original_actor_principal_id
     AND reservation.source_action_invocation_id = p_source_action_invocation_id
     AND reservation.market_resource_id = p_market_resource_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT v_identity || jsonb_build_object('outcome', 'NOT_FOUND');
    RETURN;
  END IF;
  RETURN QUERY SELECT v_identity || jsonb_build_object(
    'outcome', 'FOUND', 'actionInvocationId', v_reservation.action_invocation_id::text,
    'originalActorPrincipalId', v_reservation.original_actor_principal_id::text,
    'compositionRevision', v_reservation.composition_revision, 'originalReason', v_reservation.original_reason,
    'releaseGuardHash', v_reservation.release_guard_hash,
    'originalReservationVersion', v_reservation.original_reservation_version, 'originalLifecycle', 'RESERVED',
    'originalAssessment', v_reservation.original_assessment,
    'marketRevision', v_reservation.market_revision,
    'evaluatedAt', to_char(v_reservation.evaluated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'assessmentDigest', v_reservation.assessment_digest, 'sourceEvidence', v_reservation.source_evidence,
    'reservationToken', v_reservation.market_retirement_reservation_id::text,
    'reservationVersion', v_reservation.reservation_version, 'lifecycle', v_reservation.lifecycle
  );
END;
$$;
REVOKE ALL ON FUNCTION commerce_customer_context.recover_market_retirement_reservation(uuid, uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_customer_context.recover_market_retirement_reservation(uuid, uuid, uuid, uuid, text) TO ontos_runtime;
