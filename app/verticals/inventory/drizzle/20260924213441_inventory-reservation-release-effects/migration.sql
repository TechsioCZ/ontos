CREATE TABLE "inventory"."reservation_release_effect_history" (
	"history_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"release_effect_id" text NOT NULL,
	"revision" integer NOT NULL,
	"state" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"transitioned_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_reservation_release_effect_history_meaning_ck" CHECK ("state" in ('REQUESTED', 'INDETERMINATE', 'RELEASED', 'NOT_RELEASABLE') and "revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "inventory"."reservation_release_effect_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "inventory"."reservation_release_effects" (
	"release_effect_record_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"release_effect_id" text NOT NULL,
	"mutation_id" uuid NOT NULL,
	"source_action_invocation_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"attempt_id" text NOT NULL,
	"owner_configuration_id" uuid NOT NULL,
	"issuer_backend_kind" text NOT NULL,
	"issuer_backend_id" text NOT NULL,
	"current_state" text DEFAULT 'REQUESTED' NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"snapshot" jsonb NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"owner_evidence_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_reservation_release_effects_meaning_ck" CHECK (char_length(btrim("release_effect_id")) between 1 and 300 and char_length(btrim("attempt_id")) between 1 and 300 and char_length(btrim("issuer_backend_id")) between 1 and 300 and "issuer_backend_kind" in ('external_business_system', 'ontos_wms') and "current_state" in ('REQUESTED', 'INDETERMINATE', 'RELEASED', 'NOT_RELEASABLE') and "current_revision" >= 1 and (("current_state" = 'RELEASED' and "released_at" is not null and "owner_evidence_ref" is not null) or ("current_state" <> 'RELEASED' and "released_at" is null and "owner_evidence_ref" is null)))
);
--> statement-breakpoint
ALTER TABLE "inventory"."reservation_release_effects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_reservation_release_effect_history_scope_id_uk" ON "inventory"."reservation_release_effect_history" ("tenant_id","history_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_reservation_release_effect_history_revision_uk" ON "inventory"."reservation_release_effect_history" ("tenant_id","release_effect_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_reservation_release_effects_scope_effect_uk" ON "inventory"."reservation_release_effects" ("tenant_id","release_effect_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_reservation_release_effects_reservation_uk" ON "inventory"."reservation_release_effects" ("tenant_id","reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_reservation_release_effects_mutation_uk" ON "inventory"."reservation_release_effects" ("tenant_id","mutation_id");--> statement-breakpoint
CREATE INDEX "inventory_reservation_release_effects_state_idx" ON "inventory"."reservation_release_effects" ("tenant_id","current_state","updated_at");--> statement-breakpoint
ALTER TABLE "inventory"."reservation_release_effect_history" ADD CONSTRAINT "inventory_reservation_release_effect_history_effect_fk" FOREIGN KEY ("tenant_id","release_effect_id") REFERENCES "inventory"."reservation_release_effects"("tenant_id","release_effect_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."reservation_release_effects" ADD CONSTRAINT "inventory_reservation_release_effects_reservation_fk" FOREIGN KEY ("tenant_id","reservation_id") REFERENCES "inventory"."obligations"("tenant_id","obligation_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."reservation_release_effects" ADD CONSTRAINT "inventory_reservation_release_effects_backend_configuration_fk" FOREIGN KEY ("tenant_id","owner_configuration_id") REFERENCES "inventory"."backend_configurations"("tenant_id","configuration_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "inventory_reservation_release_effect_history_tenant_select" ON "inventory"."reservation_release_effect_history" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."reservation_release_effect_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_reservation_release_effect_history_tenant_insert" ON "inventory"."reservation_release_effect_history" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."reservation_release_effect_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_reservation_release_effect_history_tenant_update" ON "inventory"."reservation_release_effect_history" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."reservation_release_effect_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."reservation_release_effect_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_reservation_release_effect_history_tenant_delete" ON "inventory"."reservation_release_effect_history" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."reservation_release_effect_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_reservation_release_effects_tenant_select" ON "inventory"."reservation_release_effects" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."reservation_release_effects"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_reservation_release_effects_tenant_insert" ON "inventory"."reservation_release_effects" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."reservation_release_effects"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_reservation_release_effects_tenant_update" ON "inventory"."reservation_release_effects" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."reservation_release_effects"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."reservation_release_effects"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_reservation_release_effects_tenant_delete" ON "inventory"."reservation_release_effects" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."reservation_release_effects"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "inventory"."reservation_release_effect_history" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inventory"."reservation_release_effects" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION "inventory"."enforce_reservation_release_effect_scope"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
DECLARE
  request jsonb;
  reservation jsonb;
  state_tag text;
BEGIN
  request := NEW.snapshot -> 'request';
  reservation := request -> 'reservation';
  state_tag := NEW.snapshot ->> '_tag';

  IF pg_catalog.jsonb_typeof(NEW.snapshot) IS DISTINCT FROM 'object'
    OR pg_catalog.jsonb_typeof(request) IS DISTINCT FROM 'object'
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(request)) <> 6
    OR NOT request ?& ARRAY[
      'effectId', 'legalEntityId', 'mutationId', 'requestedAt', 'reservation', 'sourceActionInvocationId'
    ]
    OR state_tag IS DISTINCT FROM NEW.current_state
    OR (NEW.snapshot ->> 'revision')::integer IS DISTINCT FROM NEW.current_revision
    OR request ->> 'effectId' IS DISTINCT FROM NEW.release_effect_id
    OR (request ->> 'mutationId')::uuid IS DISTINCT FROM NEW.mutation_id
    OR (request ->> 'sourceActionInvocationId')::uuid IS DISTINCT FROM NEW.source_action_invocation_id
    OR (request ->> 'legalEntityId')::uuid IS DISTINCT FROM NEW.legal_entity_id
    OR (request ->> 'requestedAt')::timestamptz IS DISTINCT FROM NEW.requested_at
    OR reservation #>> '{ref,moduleId}' IS DISTINCT FROM 'commerce.inventory'
    OR reservation #>> '{ref,resourceType}' IS DISTINCT FROM 'commerce.inventory.inventory-reservation'
    OR reservation #>> '{ref,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
    OR (reservation #>> '{ref,resourceId}')::uuid IS DISTINCT FROM NEW.reservation_id
    OR reservation #>> '{origin,kind}' IS DISTINCT FROM 'ORDER_COMMITMENT_ATTEMPT'
    OR reservation #>> '{origin,attemptId}' IS DISTINCT FROM NEW.attempt_id
    OR reservation #>> '{lifecycleMeaning}' IS DISTINCT FROM 'PROVISIONAL_RESERVATION'
    OR reservation #>> '{authority,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
    OR (reservation #>> '{authority,configurationId}')::uuid IS DISTINCT FROM NEW.owner_configuration_id
    OR reservation #>> '{authority,selection,backend}' IS DISTINCT FROM NEW.issuer_backend_kind
    OR reservation #>> '{authority,selection,backendId}' IS DISTINCT FROM NEW.issuer_backend_id
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_reservation_release_effects_snapshot_ck',
      MESSAGE = 'Reservation Release effect identity and request snapshot must exactly match relational columns';
  END IF;

  PERFORM 1
  FROM "inventory"."obligations" AS obligation
  JOIN "inventory"."reservation_create_effects" AS create_effect
    ON create_effect.tenant_id = obligation.tenant_id
    AND create_effect.reservation_id = obligation.obligation_id
    AND create_effect.attempt_id = obligation.attempt_id
    AND create_effect.legal_entity_id = NEW.legal_entity_id
    AND create_effect.state = 'ESTABLISHED'
  WHERE obligation.tenant_id = NEW.tenant_id
    AND obligation.obligation_id = NEW.reservation_id
    AND obligation.origin_kind = 'ORDER_COMMITMENT_ATTEMPT'
    AND obligation.attempt_id = NEW.attempt_id
    AND (TG_OP <> 'INSERT' OR obligation.lifecycle_meaning = 'PROVISIONAL_RESERVATION')
    AND obligation.customer_configuration_id = reservation #>> '{authority,customerConfigurationId}'
    AND obligation.owner_configuration_id = NEW.owner_configuration_id
    AND obligation.authority_backend_kind = NEW.issuer_backend_kind
    AND obligation.authority_backend_id = NEW.issuer_backend_id
    AND obligation.authority_selected_at = (reservation #>> '{authority,selectedAt}')::timestamptz
    AND obligation.authority_revision = (reservation #>> '{authority,revision}')::integer
    AND create_effect.request_json #>> '{reservation,ref,resourceId}' = NEW.reservation_id::text
    AND create_effect.request_json #>> '{reservation,origin,attemptId}' = NEW.attempt_id
    AND create_effect.record_json -> 'reservation' IS NOT DISTINCT FROM reservation
  FOR UPDATE OF obligation;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_reservation_release_effects_exact_reservation_ck',
      MESSAGE = 'Reservation Release must preserve the exact runtime Attempt and established Reservation snapshot';
  END IF;

  PERFORM 1
  FROM "inventory"."backend_configurations" AS authority
  WHERE authority.tenant_id = NEW.tenant_id
    AND authority.configuration_id = NEW.owner_configuration_id
    AND authority.customer_configuration_id = reservation #>> '{authority,customerConfigurationId}'
    AND authority.backend_kind = NEW.issuer_backend_kind
    AND authority.backend_id = NEW.issuer_backend_id
    AND authority.selected_at = (reservation #>> '{authority,selectedAt}')::timestamptz
    AND authority.revision = (reservation #>> '{authority,revision}')::integer
    AND reservation #>> '{authority,selection,backend}' = authority.backend_kind
    AND reservation #>> '{authority,selection,backendId}' = authority.backend_id
    AND reservation #>> '{authority,selection,exactReservationCapability}'
      = authority.exact_reservation_capability
    AND reservation #>> '{authority,selection,stockCorrectionCapability}'
      = authority.stock_correction_capability
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_reservation_release_effects_exact_authority_ck',
      MESSAGE = 'Reservation Release must retain the exact selected Reservation Authority snapshot';
  END IF;

  IF (
    state_tag = 'REQUESTED'
    AND (
      (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.snapshot)) <> 3
      OR NEW.current_revision IS DISTINCT FROM 1
      OR NEW.released_at IS NOT NULL
      OR NEW.owner_evidence_ref IS NOT NULL
    )
  ) OR (
    state_tag = 'RELEASED'
    AND (
      (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.snapshot)) <> 10
      OR NEW.snapshot -> 'safelyReusable' IS DISTINCT FROM 'true'::jsonb
      OR NEW.snapshot -> 'activeAllocations' IS DISTINCT FROM '[]'::jsonb
      OR NEW.snapshot ->> 'releaseOutcome' NOT IN ('RELEASED', 'ALREADY_RELEASED')
      OR (NEW.snapshot ->> 'releasedAt')::timestamptz IS DISTINCT FROM NEW.released_at
      OR NEW.snapshot ->> 'ownerEvidenceRef' IS DISTINCT FROM NEW.owner_evidence_ref
      OR NEW.snapshot #>> '{authorityIssuer,backend}' IS DISTINCT FROM NEW.issuer_backend_kind
      OR NEW.snapshot #>> '{authorityIssuer,backendId}' IS DISTINCT FROM NEW.issuer_backend_id
      OR NEW.snapshot #>> '{authorityIssuer,origin}' IS DISTINCT FROM CASE NEW.issuer_backend_kind
        WHEN 'external_business_system' THEN 'EXTERNAL_BUSINESS_SYSTEM'
        ELSE 'ONTOS_WMS'
      END
      OR pg_catalog.jsonb_typeof(NEW.snapshot -> 'safeReleaseProof') IS DISTINCT FROM 'object'
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.snapshot -> 'safeReleaseProof')) <> 2
      OR NEW.snapshot #>> '{safeReleaseProof,order,_tag}' IS DISTINCT FROM 'NOT_COMMITTED_CLOSED'
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(
        NEW.snapshot #> '{safeReleaseProof,order}'
      )) <> 4
      OR coalesce(pg_catalog.length(pg_catalog.btrim(
        NEW.snapshot #>> '{safeReleaseProof,order,closureEvidenceRef}'
      )), 0) NOT BETWEEN 1 AND 300
      OR coalesce(pg_catalog.length(pg_catalog.btrim(
        NEW.snapshot #>> '{safeReleaseProof,order,nonCommitEvidenceRef}'
      )), 0) NOT BETWEEN 1 AND 300
      OR (NEW.snapshot #>> '{safeReleaseProof,order,observedAt}')::timestamptz IS NULL
      OR NEW.snapshot #>> '{safeReleaseProof,protection,_tag}' IS DISTINCT FROM 'ABSENT_PROVEN'
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(
        NEW.snapshot #> '{safeReleaseProof,protection}'
      )) <> 3
      OR coalesce(pg_catalog.length(pg_catalog.btrim(
        NEW.snapshot #>> '{safeReleaseProof,protection,evidenceRef}'
      )), 0) NOT BETWEEN 1 AND 300
      OR (NEW.snapshot #>> '{safeReleaseProof,protection,observedAt}')::timestamptz IS NULL
      OR coalesce(pg_catalog.length(pg_catalog.btrim(NEW.owner_evidence_ref)), 0) NOT BETWEEN 1 AND 300
    )
  ) OR (
    state_tag = 'NOT_RELEASABLE'
    AND (
      (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.snapshot)) <> 7
      OR NEW.snapshot -> 'safelyReusable' IS DISTINCT FROM 'false'::jsonb
      OR NEW.snapshot ->> 'reason' NOT IN ('COMMITTED', 'PROTECTION_ESTABLISHED')
      OR (NEW.snapshot ->> 'observedAt')::timestamptz IS NULL
      OR coalesce(pg_catalog.length(pg_catalog.btrim(NEW.snapshot ->> 'evidenceRef')), 0) NOT BETWEEN 1 AND 300
      OR NEW.released_at IS NOT NULL
      OR NEW.owner_evidence_ref IS NOT NULL
    )
  ) OR (
    state_tag = 'INDETERMINATE'
    AND (
      (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.snapshot)) <> 6
      OR NEW.snapshot -> 'safelyReusable' IS DISTINCT FROM 'false'::jsonb
      OR NEW.snapshot ->> 'reason' NOT IN (
        'ORDER_OUTCOME_UNKNOWN',
        'PROTECTION_OUTCOME_UNKNOWN',
        'AUTHORITY_OUTCOME_UNKNOWN'
      )
      OR (NEW.snapshot ->> 'observedAt')::timestamptz IS NULL
      OR NEW.released_at IS NOT NULL
      OR NEW.owner_evidence_ref IS NOT NULL
    )
  ) OR state_tag NOT IN ('REQUESTED', 'INDETERMINATE', 'RELEASED', 'NOT_RELEASABLE')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_reservation_release_effects_terminal_proof_ck',
      MESSAGE = 'Reservation Release state must retain exact reusable-stock proof and terminal evidence';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "inventory"."enforce_reservation_release_effect_transition"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_reservation_release_effects_lifecycle_ck',
      MESSAGE = 'Reservation Release effect cannot be deleted';
  END IF;

  IF NEW.release_effect_record_id IS DISTINCT FROM OLD.release_effect_record_id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.release_effect_id IS DISTINCT FROM OLD.release_effect_id
    OR NEW.mutation_id IS DISTINCT FROM OLD.mutation_id
    OR NEW.source_action_invocation_id IS DISTINCT FROM OLD.source_action_invocation_id
    OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
    OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id
    OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
    OR NEW.owner_configuration_id IS DISTINCT FROM OLD.owner_configuration_id
    OR NEW.issuer_backend_kind IS DISTINCT FROM OLD.issuer_backend_kind
    OR NEW.issuer_backend_id IS DISTINCT FROM OLD.issuer_backend_id
    OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.snapshot -> 'request' IS DISTINCT FROM OLD.snapshot -> 'request'
    OR NEW.current_revision IS DISTINCT FROM OLD.current_revision + 1
    OR OLD.current_state IN ('RELEASED', 'NOT_RELEASABLE')
    OR OLD.current_state NOT IN ('REQUESTED', 'INDETERMINATE')
    OR NEW.current_state NOT IN ('INDETERMINATE', 'RELEASED', 'NOT_RELEASABLE')
    OR NEW.updated_at < OLD.updated_at
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_reservation_release_effects_lifecycle_ck',
      MESSAGE = 'Reservation Release transition mutates immutable intent or violates monotonic lifecycle';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "inventory"."enforce_reservation_release_effect_history_scope"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
BEGIN
  PERFORM 1
  FROM "inventory"."reservation_release_effects" AS effect
  WHERE effect.tenant_id = NEW.tenant_id
    AND effect.release_effect_id = NEW.release_effect_id
    AND effect.current_revision = NEW.revision
    AND effect.current_state = NEW.state
    AND effect.snapshot IS NOT DISTINCT FROM NEW.snapshot
    AND NEW.snapshot ->> '_tag' = NEW.state
    AND (NEW.snapshot ->> 'revision')::integer = NEW.revision
    AND NEW.transitioned_at = CASE NEW.state
      WHEN 'REQUESTED' THEN (NEW.snapshot #>> '{request,requestedAt}')::timestamptz
      WHEN 'RELEASED' THEN (NEW.snapshot ->> 'releasedAt')::timestamptz
      ELSE (NEW.snapshot ->> 'observedAt')::timestamptz
    END
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_reservation_release_effect_history_snapshot_ck',
      MESSAGE = 'Reservation Release history must exactly snapshot the current validated revision';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "inventory"."reject_reservation_release_effect_history_mutation"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'inventory_reservation_release_effect_history_append_only_ck',
    MESSAGE = 'Reservation Release effect history is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_reservation_release_effects_scope_trg"
BEFORE INSERT OR UPDATE ON "inventory"."reservation_release_effects"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_reservation_release_effect_scope"();
--> statement-breakpoint
CREATE TRIGGER "inventory_reservation_release_effects_transition_trg"
BEFORE UPDATE OR DELETE ON "inventory"."reservation_release_effects"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_reservation_release_effect_transition"();
--> statement-breakpoint
CREATE TRIGGER "inventory_reservation_release_effect_history_scope_trg"
BEFORE INSERT ON "inventory"."reservation_release_effect_history"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_reservation_release_effect_history_scope"();
--> statement-breakpoint
CREATE TRIGGER "inventory_reservation_release_effect_history_no_update_trg"
BEFORE UPDATE ON "inventory"."reservation_release_effect_history"
FOR EACH ROW EXECUTE FUNCTION "inventory"."reject_reservation_release_effect_history_mutation"();
--> statement-breakpoint
CREATE TRIGGER "inventory_reservation_release_effect_history_no_delete_trg"
BEFORE DELETE ON "inventory"."reservation_release_effect_history"
FOR EACH ROW EXECUTE FUNCTION "inventory"."reject_reservation_release_effect_history_mutation"();
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_reservation_release_effect_scope"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_reservation_release_effect_transition"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_reservation_release_effect_history_scope"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."reject_reservation_release_effect_history_mutation"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
CREATE FUNCTION "inventory"."read_reservation_release_effect_for_worker"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_effect_id text
) RETURNS TABLE(record jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  current_record jsonb;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Reservation Release worker scope mismatch';
  END IF;

  SELECT effect.snapshot
  INTO current_record
  FROM "inventory"."reservation_release_effects" AS effect
  WHERE effect.tenant_id = p_tenant_id
    AND effect.legal_entity_id = p_legal_entity_id
    AND effect.release_effect_id = p_effect_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT current_record;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "inventory"."finalize_reservation_release_effect_for_worker"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_effect_id text,
  p_expected_revision integer,
  p_next_snapshot jsonb
) RETURNS TABLE(record jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  current_effect "inventory"."reservation_release_effects"%ROWTYPE;
  next_state text;
  next_transitioned_at timestamptz;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Reservation Release worker scope mismatch';
  END IF;

  SELECT effect.*
  INTO current_effect
  FROM "inventory"."reservation_release_effects" AS effect
  WHERE effect.tenant_id = p_tenant_id
    AND effect.legal_entity_id = p_legal_entity_id
    AND effect.release_effect_id = p_effect_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  next_state := p_next_snapshot ->> '_tag';
  IF current_effect.snapshot IS NOT DISTINCT FROM p_next_snapshot THEN
    IF current_effect.current_revision IS DISTINCT FROM p_expected_revision + 1
      OR current_effect.current_state NOT IN ('INDETERMINATE', 'RELEASED', 'NOT_RELEASABLE')
      OR next_state IS DISTINCT FROM current_effect.current_state
      OR (p_next_snapshot ->> 'revision')::integer IS DISTINCT FROM current_effect.current_revision
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_reservation_release_effects_worker_cas_ck',
        MESSAGE = 'Reservation Release replay must match the exact completed compare-and-set';
    END IF;

    RETURN QUERY SELECT current_effect.snapshot;
    RETURN;
  END IF;

  IF current_effect.current_state IN ('RELEASED', 'NOT_RELEASABLE')
    OR current_effect.current_revision IS DISTINCT FROM p_expected_revision
    OR (p_next_snapshot ->> 'revision')::integer IS DISTINCT FROM p_expected_revision + 1
    OR p_next_snapshot -> 'request' IS DISTINCT FROM current_effect.snapshot -> 'request'
    OR p_next_snapshot #>> '{request,effectId}' IS DISTINCT FROM current_effect.release_effect_id
    OR p_next_snapshot #>> '{request,legalEntityId}' IS DISTINCT FROM current_effect.legal_entity_id::text
    OR next_state NOT IN ('INDETERMINATE', 'RELEASED', 'NOT_RELEASABLE')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_reservation_release_effects_worker_cas_ck',
      MESSAGE = 'Reservation Release worker finalization must be an exact monotonic compare-and-set';
  END IF;

  next_transitioned_at := CASE next_state
    WHEN 'RELEASED' THEN (p_next_snapshot ->> 'releasedAt')::timestamptz
    ELSE (p_next_snapshot ->> 'observedAt')::timestamptz
  END;

  UPDATE "inventory"."reservation_release_effects"
  SET current_state = next_state,
    current_revision = p_expected_revision + 1,
    snapshot = p_next_snapshot,
    released_at = CASE WHEN next_state = 'RELEASED' THEN next_transitioned_at END,
    owner_evidence_ref = CASE WHEN next_state = 'RELEASED' THEN p_next_snapshot ->> 'ownerEvidenceRef' END,
    updated_at = next_transitioned_at
  WHERE tenant_id = p_tenant_id
    AND legal_entity_id = p_legal_entity_id
    AND release_effect_id = p_effect_id
    AND current_revision = p_expected_revision;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'Reservation Release effect changed during worker finalization';
  END IF;

  INSERT INTO "inventory"."reservation_release_effect_history" (
    tenant_id,
    release_effect_id,
    revision,
    state,
    snapshot,
    transitioned_at
  ) VALUES (
    p_tenant_id,
    p_effect_id,
    p_expected_revision + 1,
    next_state,
    p_next_snapshot,
    next_transitioned_at
  );

  RETURN QUERY SELECT p_next_snapshot;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."read_reservation_release_effect_for_worker"(uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."finalize_reservation_release_effect_for_worker"(uuid, uuid, text, integer, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "inventory"."read_reservation_release_effect_for_worker"(uuid, uuid, text) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "inventory"."finalize_reservation_release_effect_for_worker"(uuid, uuid, text, integer, jsonb) TO "ontos_runtime";
--> statement-breakpoint
ALTER FUNCTION "inventory"."enforce_reservation_shortage_impact_source"()
RENAME TO "enforce_reservation_shortage_impact_decision_scope";
--> statement-breakpoint
DROP TRIGGER "inventory_reservation_shortage_impacts_source_trg"
ON "inventory"."reservation_shortage_impacts";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "inventory"."enforce_reservation_shortage_impact_source"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
DECLARE
  expected_fenced_amount numeric(38, 9);
  position_matches boolean;
BEGIN
  PERFORM 1
  FROM "inventory"."stock_positions" AS position
  WHERE position.tenant_id = NEW.tenant_id
    AND position.stock_position_id = NEW.position_id
    AND position.lifecycle_state = 'CURRENT'
    AND position.on_hand_state = 'CURRENT'
    AND position.revision = NEW.position_revision
    AND position.on_hand_amount = NEW.available_amount
  FOR UPDATE;

  position_matches := FOUND;

  SELECT coalesce(pg_catalog.sum(allocation.allocated_amount), 0)
  INTO expected_fenced_amount
  FROM "inventory"."obligation_allocations" AS allocation
  JOIN "inventory"."obligations" AS obligation
    ON obligation.tenant_id = allocation.tenant_id
    AND obligation.obligation_id = allocation.obligation_id
  WHERE allocation.tenant_id = NEW.tenant_id
    AND allocation.stock_position_id = NEW.position_id
    AND (
      obligation.lifecycle_meaning = 'COMMITTED_OBLIGATION'
      OR EXISTS (
        SELECT 1
        FROM "inventory"."reservation_confirmations" AS confirmation
        WHERE confirmation.tenant_id = allocation.tenant_id
          AND confirmation.reservation_id = allocation.obligation_id
          AND confirmation.current_health_state IN ('EXPIRED', 'REVOKED')
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "inventory"."reservation_release_effects" AS release_effect
      WHERE release_effect.tenant_id = allocation.tenant_id
        AND release_effect.reservation_id = allocation.obligation_id
        AND release_effect.current_state = 'RELEASED'
    );

  IF NOT position_matches
    OR NEW.fenced_amount IS DISTINCT FROM expected_fenced_amount
    OR (
      NEW.change_kind IN ('RECEIPT', 'ISSUE')
      AND NOT EXISTS (
        SELECT 1
        FROM "inventory"."physical_stock_effects" AS effect
        WHERE effect.tenant_id = NEW.tenant_id
          AND effect.effect_id = NEW.physical_effect_id
          AND effect.effect_id = NEW.change_id
          AND effect.kind = NEW.change_kind
          AND effect.position_id = NEW.position_id
          AND effect.state = 'APPLIED'
          AND effect.evidence_json ->> 'effectId' = NEW.change_id::text
          AND effect.evidence_json ->> 'kind' = NEW.change_kind
          AND effect.evidence_json #>> '{positionRef,tenantId}' = NEW.tenant_id::text
          AND effect.evidence_json #>> '{positionRef,resourceId}' = NEW.position_id::text
          AND (effect.evidence_json ->> 'appliedAt')::timestamptz = NEW.occurred_at
          AND EXISTS (
            SELECT 1
            FROM "inventory"."stock_positions" AS current_position
            WHERE current_position.tenant_id = NEW.tenant_id
              AND current_position.stock_position_id = NEW.position_id
              AND current_position.on_hand_observed_at
                = (effect.evidence_json ->> 'appliedAt')::timestamptz
              AND current_position.on_hand_evidence_ref
                = effect.evidence_json ->> 'backendEvidenceRef'
          )
      )
    )
    OR (
      NEW.change_kind = 'CORRECTION'
      AND NOT EXISTS (
        SELECT 1
        FROM "inventory"."stock_corrections" AS correction
        WHERE correction.tenant_id = NEW.tenant_id
          AND correction.correction_id = NEW.stock_correction_id
          AND correction.correction_id = NEW.change_id
          AND correction.position_id = NEW.position_id
          AND correction.state = 'APPLIED'
          AND correction.position_revision_after = NEW.position_revision
          AND correction.corrected_quantity_amount = NEW.available_amount
          AND correction.applied_at = NEW.occurred_at
          AND correction.record_json ->> 'correctionId' = NEW.change_id::text
          AND correction.record_json #>> '{positionRef,tenantId}' = NEW.tenant_id::text
          AND correction.record_json #>> '{positionRef,resourceId}' = NEW.position_id::text
          AND (correction.record_json ->> 'positionRevisionAfter')::integer = NEW.position_revision
          AND (correction.record_json #>> '{correctedQuantity,amount}')::numeric = NEW.available_amount
          AND (correction.record_json ->> 'appliedAt')::timestamptz = NEW.occurred_at
          AND EXISTS (
            SELECT 1
            FROM "inventory"."stock_positions" AS current_position
            WHERE current_position.tenant_id = NEW.tenant_id
              AND current_position.stock_position_id = NEW.position_id
              AND current_position.on_hand_observed_at = correction.business_observed_at
              AND current_position.on_hand_evidence_ref = correction.owner_evidence_ref
          )
      )
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_reservation_shortage_impacts_exact_source_ck',
      MESSAGE = 'Reservation shortage impact must reference the exact applied source, Current Position revision, and non-reusable capacity';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_reservation_shortage_impacts_source_trg"
BEFORE INSERT ON "inventory"."reservation_shortage_impacts"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_reservation_shortage_impact_source"();
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_reservation_shortage_impact_source"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_reservation_shortage_impact_decision_scope"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "inventory"."read_reservation_shortage_impact_context_for_worker"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_change_kind text,
  p_change_id uuid,
  p_position_id uuid,
  p_occurred_at timestamptz
) RETURNS TABLE(context jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  candidate_set jsonb;
  evidence_ref text;
  fenced_amount numeric(38, 9);
  position "inventory"."stock_positions"%ROWTYPE;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Reservation shortage impact worker scope mismatch';
  END IF;

  IF p_change_kind NOT IN ('RECEIPT', 'ISSUE') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_reservation_shortage_impacts_exact_source_ck',
      MESSAGE = 'Reservation shortage impact worker source kind is invalid';
  END IF;

  SELECT stored.*
  INTO position
  FROM "inventory"."stock_positions" AS stored
  WHERE stored.tenant_id = p_tenant_id
    AND stored.stock_position_id = p_position_id
    AND stored.lifecycle_state = 'CURRENT'
    AND stored.on_hand_state = 'CURRENT'
    AND stored.on_hand_amount IS NOT NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT effect.evidence_json ->> 'backendEvidenceRef'
  INTO evidence_ref
  FROM "inventory"."physical_stock_effects" AS effect
  WHERE effect.tenant_id = p_tenant_id
    AND effect.legal_entity_id = p_legal_entity_id
    AND effect.effect_id = p_change_id
    AND effect.position_id = p_position_id
    AND effect.kind = p_change_kind
    AND effect.state = 'APPLIED'
    AND (effect.evidence_json ->> 'appliedAt')::timestamptz = p_occurred_at
    AND position.on_hand_observed_at = (effect.evidence_json ->> 'appliedAt')::timestamptz
    AND position.on_hand_evidence_ref = effect.evidence_json ->> 'backendEvidenceRef'
  FOR UPDATE;

  IF evidence_ref IS NULL THEN
    RETURN;
  END IF;

  WITH candidate_rows AS (
    SELECT DISTINCT
      confirmation.confirmation_id,
      confirmation.snapshot,
      reservation.lifecycle_meaning
    FROM "inventory"."reservation_confirmations" AS confirmation
    JOIN "inventory"."obligations" AS reservation
      ON reservation.tenant_id = confirmation.tenant_id
      AND reservation.obligation_id = confirmation.reservation_id
    JOIN "inventory"."obligation_allocations" AS allocation
      ON allocation.tenant_id = confirmation.tenant_id
      AND allocation.obligation_id = confirmation.reservation_id
      AND allocation.stock_position_id = p_position_id
    LEFT JOIN "inventory"."reservation_release_effects" AS release_effect
      ON release_effect.tenant_id = confirmation.tenant_id
      AND release_effect.reservation_id = confirmation.reservation_id
    WHERE confirmation.tenant_id = p_tenant_id
      AND (
        release_effect.release_effect_record_id IS NULL
        OR release_effect.current_state <> 'RELEASED'
      )
  )
  SELECT coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'allocations', (
          SELECT coalesce(pg_catalog.jsonb_agg(stored_allocation.entry), '[]'::jsonb)
          FROM pg_catalog.jsonb_array_elements(
            candidate.snapshot #> '{reservation,requirements}'
          ) AS requirement(entry)
          CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
            requirement.entry -> 'allocations'
          ) AS stored_allocation(entry)
        ),
        'confirmation', candidate.snapshot,
        'poolBoundary', CASE candidate.lifecycle_meaning
          WHEN 'COMMITTED_OBLIGATION' THEN 'COMMITTED_OBLIGATION'
          ELSE 'NONE'
        END
      ) ORDER BY
        (candidate.snapshot #>> '{issuanceRank,issuedAt}')::timestamptz,
        candidate.confirmation_id
    ),
    '[]'::jsonb
  )
  INTO candidate_set
  FROM candidate_rows AS candidate;

  SELECT coalesce(pg_catalog.sum((allocation.entry #>> '{quantity,amount}')::numeric), 0)
  INTO fenced_amount
  FROM pg_catalog.jsonb_array_elements(candidate_set) AS fenced(entry)
  CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(fenced.entry -> 'allocations') AS allocation(entry)
  WHERE (
      fenced.entry ->> 'poolBoundary' = 'COMMITTED_OBLIGATION'
      OR (
        fenced.entry ->> 'poolBoundary' = 'NONE'
        AND fenced.entry #>> '{confirmation,health,state}' IN ('EXPIRED', 'REVOKED')
      )
    )
    AND allocation.entry #>> '{positionRef,tenantId}' = p_tenant_id::text
    AND allocation.entry #>> '{positionRef,resourceId}' = p_position_id::text;

  RETURN QUERY SELECT pg_catalog.jsonb_build_object(
    'causeEvidenceRef', evidence_ref,
    'evaluationInput', pg_catalog.jsonb_build_object(
      'affectedPositionRef', pg_catalog.jsonb_build_object(
        'moduleId', 'commerce.inventory',
        'resourceId', position.stock_position_id,
        'resourceType', 'commerce.inventory.stock-position',
        'tenantId', position.tenant_id
      ),
      'availableQuantity', pg_catalog.jsonb_build_object(
        'amount', pg_catalog.trim_scale(position.on_hand_amount)::text,
        'unitRef', pg_catalog.jsonb_build_object(
          'moduleId', position.stock_unit_module_id,
          'resourceId', position.stock_unit_resource_id,
          'resourceType', position.stock_unit_resource_type,
          'tenantId', position.stock_unit_tenant_id
        )
      ),
      'candidates', candidate_set
    ),
    'fencedAmount', pg_catalog.trim_scale(fenced_amount)::text,
    'positionRevision', position.revision
  );
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."read_reservation_shortage_impact_context_for_worker"(uuid, uuid, text, uuid, uuid, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "inventory"."read_reservation_shortage_impact_context_for_worker"(uuid, uuid, text, uuid, uuid, timestamptz) TO "ontos_runtime";
