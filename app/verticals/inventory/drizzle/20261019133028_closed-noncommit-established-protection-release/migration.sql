-- Preserve original Order closure and historical Protection truth; only original authoritative release receipts make stock reusable.
CREATE OR REPLACE FUNCTION "inventory"."enforce_reservation_release_effect_scope"() RETURNS trigger
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
      OR NEW.snapshot #>> '{authorityIssuer,origin}' IS DISTINCT FROM (CASE NEW.issuer_backend_kind
        WHEN 'external_business_system' THEN 'EXTERNAL_BUSINESS_SYSTEM'
        ELSE 'ONTOS_WMS'
      END)
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
      OR NEW.snapshot #>> '{safeReleaseProof,protection,_tag}' NOT IN ('ABSENT_PROVEN', 'ESTABLISHED')
      OR NEW.snapshot #>> '{safeReleaseProof,protection,_tag}' IS NULL
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(
        NEW.snapshot #> '{safeReleaseProof,protection}'
      )) <> CASE NEW.snapshot #>> '{safeReleaseProof,protection,_tag}'
        WHEN 'ABSENT_PROVEN' THEN 3
        WHEN 'ESTABLISHED' THEN 4
        ELSE 0
      END
      OR (
        NEW.snapshot #>> '{safeReleaseProof,protection,_tag}' = 'ESTABLISHED'
        AND (NEW.snapshot #>> '{safeReleaseProof,protection,establishedAt}')::timestamptz IS NULL
      )
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
