CREATE OR REPLACE FUNCTION "inventory"."enforce_commitment_protection_scope"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
DECLARE
  authority "inventory"."backend_configurations"%ROWTYPE;
  confirmation "inventory"."reservation_confirmations"%ROWTYPE;
  candidate_confirmation jsonb := NEW.snapshot -> 'confirmation';
  expected_allocations jsonb;
  actual_allocations jsonb;
BEGIN
  IF pg_catalog.jsonb_typeof(NEW.snapshot) IS DISTINCT FROM 'object'
    OR (NEW.snapshot #>> '{ref,resourceId}')::uuid IS DISTINCT FROM NEW.protection_id
    OR NEW.snapshot #>> '{ref,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
    OR (NEW.snapshot #>> '{confirmation,ref,resourceId}')::uuid IS DISTINCT FROM NEW.confirmation_id
    OR NEW.snapshot #>> '{confirmation,ref,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
    OR (NEW.snapshot #>> '{confirmation,reservation,ref,resourceId}')::uuid IS DISTINCT FROM NEW.reservation_id
    OR NEW.snapshot #>> '{confirmation,reservation,origin,attemptId}' IS DISTINCT FROM NEW.attempt_id
    OR (NEW.snapshot #>> '{confirmation,reservation,authority,configurationId}')::uuid IS DISTINCT FROM NEW.owner_configuration_id
    OR NEW.snapshot #>> '{authorityEvidence,issuer,backend}' IS DISTINCT FROM NEW.issuer_backend_kind
    OR NEW.snapshot #>> '{authorityEvidence,issuer,backendId}' IS DISTINCT FROM NEW.issuer_backend_id
    OR NEW.snapshot #>> '{authorityEvidence,effectId}' IS DISTINCT FROM NEW.authority_effect_id
    OR NEW.snapshot #>> '{authorityEvidence,evidence,ownerEvidenceRef}' IS DISTINCT FROM NEW.owner_evidence_ref
    OR (NEW.snapshot #>> '{authorityEvidence,evidence,validFrom}')::timestamptz IS DISTINCT FROM NEW.established_at
    OR (NEW.snapshot ->> 'establishedAt')::timestamptz IS DISTINCT FROM NEW.established_at
    OR NEW.snapshot #>> '{health,state}' IS DISTINCT FROM NEW.current_health_state
    OR (NEW.snapshot ->> 'revision')::integer IS DISTINCT FROM NEW.current_revision
    OR (NEW.snapshot #>> '{health,observation,effectiveAt}')::timestamptz IS DISTINCT FROM NEW.updated_at
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_commitment_protections_snapshot_ck',
      MESSAGE = 'Commitment Protection snapshot must exactly match its relational identity and current health';
  END IF;

  SELECT selected.* INTO authority
  FROM "inventory"."backend_configurations" AS selected
  WHERE selected.tenant_id = NEW.tenant_id
    AND selected.configuration_id = NEW.owner_configuration_id
    AND selected.customer_configuration_id = NEW.snapshot #>> '{confirmation,reservation,authority,customerConfigurationId}'
    AND selected.backend_kind = NEW.issuer_backend_kind
    AND selected.backend_id = NEW.issuer_backend_id
  FOR KEY SHARE;
  IF NOT FOUND
    OR NEW.snapshot #>> '{authorityEvidence,issuer,origin}' IS DISTINCT FROM (CASE NEW.issuer_backend_kind
      WHEN 'external_business_system' THEN 'EXTERNAL_BUSINESS_SYSTEM'
      WHEN 'ontos_wms' THEN 'ONTOS_WMS'
    END)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_commitment_protections_exact_authority_ck',
      MESSAGE = 'Commitment Protection must preserve the exact selected backend authority';
  END IF;

  SELECT current_confirmation.* INTO confirmation
  FROM "inventory"."reservation_confirmations" AS current_confirmation
  WHERE current_confirmation.tenant_id = NEW.tenant_id
    AND current_confirmation.confirmation_id = NEW.confirmation_id
    AND current_confirmation.reservation_id = NEW.reservation_id
    AND current_confirmation.attempt_id = NEW.attempt_id
    AND current_confirmation.owner_configuration_id = NEW.owner_configuration_id
    AND current_confirmation.issuer_backend_kind = NEW.issuer_backend_kind
    AND current_confirmation.issuer_backend_id = NEW.issuer_backend_id
  FOR KEY SHARE;
  IF NOT FOUND
    OR NEW.established_at >= confirmation.expires_at
    OR NOT EXISTS (
      SELECT 1 FROM "inventory"."reservation_confirmation_history" AS confirmation_history
      WHERE confirmation_history.tenant_id = NEW.tenant_id
        AND confirmation_history.confirmation_id = NEW.confirmation_id
        AND confirmation_history.snapshot = candidate_confirmation
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_commitment_protections_exact_confirmation_ck',
      MESSAGE = 'Commitment Protection must reference exact retained Confirmation proof established before exclusive expiry';
  END IF;

  PERFORM 1 FROM "inventory"."obligations" AS reservation
  WHERE reservation.tenant_id = NEW.tenant_id
    AND reservation.obligation_id = NEW.reservation_id
    AND reservation.origin_kind = 'ORDER_COMMITMENT_ATTEMPT'
    AND reservation.attempt_id = NEW.attempt_id
    AND reservation.owner_configuration_id = NEW.owner_configuration_id
    AND (
      (
        TG_OP = 'INSERT'
        AND reservation.lifecycle_meaning = 'PROVISIONAL_RESERVATION'
        AND reservation.accepted_order_id IS NULL
        AND reservation.order_evidence_ref IS NULL
        AND reservation.order_evidence_observed_at IS NULL
      )
      OR (
        TG_OP = 'UPDATE'
        AND (
          (
            reservation.lifecycle_meaning = 'PROVISIONAL_RESERVATION'
            AND reservation.accepted_order_id IS NULL
            AND reservation.order_evidence_ref IS NULL
            AND reservation.order_evidence_observed_at IS NULL
          )
          OR (
            reservation.lifecycle_meaning = 'COMMITTED_OBLIGATION'
            AND reservation.accepted_order_id IS NOT NULL
            AND reservation.order_evidence_ref IS NOT NULL
            AND reservation.order_evidence_observed_at IS NOT NULL
          )
        )
      )
    )
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_commitment_protections_exact_reservation_ck',
      MESSAGE = 'Commitment Protection must reference its exact immutable Reservation and Attempt lineage';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.protection_id IS DISTINCT FROM OLD.protection_id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.confirmation_id IS DISTINCT FROM OLD.confirmation_id
    OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id
    OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
    OR NEW.owner_configuration_id IS DISTINCT FROM OLD.owner_configuration_id
    OR NEW.issuer_backend_kind IS DISTINCT FROM OLD.issuer_backend_kind
    OR NEW.issuer_backend_id IS DISTINCT FROM OLD.issuer_backend_id
    OR NEW.authority_effect_id IS DISTINCT FROM OLD.authority_effect_id
    OR NEW.owner_evidence_ref IS DISTINCT FROM OLD.owner_evidence_ref
    OR NEW.established_at IS DISTINCT FROM OLD.established_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (NEW.snapshot - 'health' - 'revision') IS DISTINCT FROM (OLD.snapshot - 'health' - 'revision')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_commitment_protections_snapshot_ck',
      MESSAGE = 'Commitment Protection health revisions must preserve exact immutable relational and embedded evidence';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    RETURN NEW;
  END IF;

  SELECT pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'allocationId', allocation.entry -> 'allocationId',
      'quantity', allocation.entry -> 'quantity',
      'stockItemRef', allocation.entry -> 'stockItemRef',
      'stockPositionRef', allocation.entry -> 'positionRef'
    )
    ORDER BY allocation.entry ->> 'allocationId'
  )
  INTO expected_allocations
  FROM pg_catalog.jsonb_array_elements(candidate_confirmation #> '{reservation,requirements}') AS requirement(entry),
    LATERAL pg_catalog.jsonb_array_elements(requirement.entry -> 'allocations') AS allocation(entry);
  SELECT pg_catalog.jsonb_agg(allocation.entry ORDER BY allocation.entry ->> 'allocationId')
  INTO actual_allocations
  FROM pg_catalog.jsonb_array_elements(NEW.snapshot #> '{authorityEvidence,evidence,allocations}') AS allocation(entry);
  IF NEW.current_health_state IS DISTINCT FROM 'PROTECTED'
    OR NEW.current_revision IS DISTINCT FROM 1
    OR NEW.snapshot #>> '{authorityEvidence,kind}' IS DISTINCT FROM 'AUTHORITATIVE_RESERVATION_EVIDENCE'
    OR NEW.snapshot #>> '{authorityEvidence,operation}' IS DISTINCT FROM 'COMMITMENT_PROTECTION'
    OR NEW.snapshot #>> '{authorityEvidence,evidence,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
    OR NEW.snapshot #>> '{authorityEvidence,evidence,reservationId}' IS DISTINCT FROM NEW.reservation_id::text
    OR NEW.snapshot #>> '{authorityEvidence,evidence,attemptId}' IS DISTINCT FROM NEW.attempt_id
    OR NEW.snapshot #>> '{authorityEvidence,evidence,customerConfigurationId}' IS DISTINCT FROM authority.customer_configuration_id
    OR NEW.snapshot #>> '{health,observation,_tag}' IS DISTINCT FROM 'ESTABLISHED'
    OR NEW.snapshot #>> '{health,observation,ownerEvidenceRef}' IS DISTINCT FROM NEW.owner_evidence_ref
    OR (NEW.snapshot #>> '{health,reconciliationRequired}')::boolean IS DISTINCT FROM false
    OR expected_allocations IS DISTINCT FROM actual_allocations
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_commitment_protections_snapshot_ck',
      MESSAGE = 'Commitment Protection establishment must preserve exact authority allocation, quantity, Unit, Item, Position, and evidence scope';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_commitment_protection_scope"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "inventory"."enforce_effect_ledger_exact_scope"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
DECLARE
  intent jsonb := NEW.intent_json;
  intent_kind text := NEW.intent_json ->> '_tag';
  parsed_canonical jsonb;
  resolution_business_request jsonb;
  resolution_identity text;
BEGIN
  BEGIN
    parsed_canonical := NEW.intent_canonical::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck',
      MESSAGE = 'Inventory effect intent canonical fingerprint must be valid JSON';
  END;
  IF pg_catalog.jsonb_typeof(NEW.snapshot) IS DISTINCT FROM 'object'
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.snapshot)) <> 8
    OR pg_catalog.jsonb_typeof(intent) IS DISTINCT FROM 'object'
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(intent)) <> 2
    OR pg_catalog.jsonb_typeof(intent -> 'request') IS DISTINCT FROM 'object'
    OR NEW.snapshot ->> 'tenantId' IS DISTINCT FROM NEW.tenant_id::text
    OR NEW.snapshot ->> 'effectId' IS DISTINCT FROM NEW.effect_id
    OR NEW.snapshot ->> 'currentState' IS DISTINCT FROM NEW.current_state
    OR (NEW.snapshot ->> 'revision')::integer IS DISTINCT FROM NEW.current_revision
    OR (NEW.snapshot ->> 'requestedAt')::timestamptz IS DISTINCT FROM NEW.requested_at
    OR (NEW.snapshot ->> 'updatedAt')::timestamptz IS DISTINCT FROM NEW.updated_at
    OR NEW.updated_at < NEW.requested_at
    OR NEW.snapshot -> 'intent' IS DISTINCT FROM intent
    OR NEW.snapshot -> 'resolution' IS DISTINCT FROM coalesce(NEW.resolution_json, 'null'::jsonb)
    OR intent IS DISTINCT FROM parsed_canonical
    OR intent_kind IS DISTINCT FROM NEW.effect_kind
    OR (NEW.current_state = 'REQUESTED' AND (NEW.current_revision <> 1 OR NEW.resolution_json IS NOT NULL))
    OR (NEW.current_state IN ('SUCCEEDED', 'REJECTED') AND NEW.resolution_json IS NULL)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck',
      MESSAGE = 'Inventory effect ledger relational state must exactly match its canonical snapshot';
  END IF;

  IF NEW.effect_kind = 'RESERVATION_CREATE' THEN
    IF (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(intent -> 'request')) <> 5
      OR intent #>> '{request,effectId}' IS DISTINCT FROM NEW.effect_id
      OR intent #>> '{request,authority,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR (intent #>> '{request,legalEntityId}')::uuid IS DISTINCT FROM NEW.legal_entity_id
      OR intent #>> '{request,authority,customerConfigurationId}' IS DISTINCT FROM NEW.customer_configuration_id
      OR (intent #>> '{request,reservation,ref,resourceId}')::uuid IS DISTINCT FROM NEW.reservation_id
      OR intent #>> '{request,reservation,origin,attemptId}' IS DISTINCT FROM NEW.attempt_id
      OR (intent #>> '{request,authority,configurationId}')::uuid IS DISTINCT FROM NEW.authority_configuration_id
      OR intent #>> '{request,authority,selection,backend}' IS DISTINCT FROM NEW.authority_backend_kind
      OR intent #>> '{request,authority,selection,backendId}' IS DISTINCT FROM NEW.authority_backend_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck';
    END IF;
  ELSIF NEW.effect_kind = 'RESERVATION_RELEASE' THEN
    IF (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(intent -> 'request')) <> 3
      OR intent #>> '{request,effectId}' IS DISTINCT FROM NEW.effect_id
      OR (intent #>> '{request,legalEntityId}')::uuid IS DISTINCT FROM NEW.legal_entity_id
      OR intent #>> '{request,reservation,authority,customerConfigurationId}' IS DISTINCT FROM NEW.customer_configuration_id
      OR (intent #>> '{request,reservation,ref,resourceId}')::uuid IS DISTINCT FROM NEW.reservation_id
      OR intent #>> '{request,reservation,origin,attemptId}' IS DISTINCT FROM NEW.attempt_id
      OR (intent #>> '{request,reservation,authority,configurationId}')::uuid IS DISTINCT FROM NEW.authority_configuration_id
      OR intent #>> '{request,reservation,authority,selection,backend}' IS DISTINCT FROM NEW.authority_backend_kind
      OR intent #>> '{request,reservation,authority,selection,backendId}' IS DISTINCT FROM NEW.authority_backend_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck';
    END IF;
  ELSIF NEW.effect_kind = 'ESTABLISH_COMMITMENT_PROTECTION' THEN
    IF (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(intent -> 'request')) <> 7
      OR intent #>> '{request,effectId}' IS DISTINCT FROM NEW.effect_id
      OR intent #>> '{request,confirmation,ref,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR intent #>> '{request,protectionRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR (intent #>> '{request,legalEntityId}')::uuid IS DISTINCT FROM NEW.legal_entity_id
      OR intent #>> '{request,confirmation,reservation,authority,customerConfigurationId}' IS DISTINCT FROM NEW.customer_configuration_id
      OR (intent #>> '{request,confirmation,reservation,ref,resourceId}')::uuid IS DISTINCT FROM NEW.reservation_id
      OR intent #>> '{request,confirmation,reservation,origin,attemptId}' IS DISTINCT FROM NEW.attempt_id
      OR (intent #>> '{request,confirmation,reservation,authority,configurationId}')::uuid IS DISTINCT FROM NEW.authority_configuration_id
      OR intent #>> '{request,confirmation,reservation,authority,selection,backend}' IS DISTINCT FROM NEW.authority_backend_kind
      OR intent #>> '{request,confirmation,reservation,authority,selection,backendId}' IS DISTINCT FROM NEW.authority_backend_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck',
        MESSAGE = 'Commitment Protection ledger scope does not match its canonical business intent';
    END IF;
  ELSIF NEW.effect_kind IN ('PHYSICAL_RECEIPT', 'PHYSICAL_ISSUE') THEN
    IF (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(intent -> 'request')) <> 12
      OR intent #>> '{request,effectId}' IS DISTINCT FROM NEW.effect_id
      OR intent #>> '{request,positionRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR (intent #>> '{request,legalEntityId}')::uuid IS DISTINCT FROM NEW.legal_entity_id
      OR intent #>> '{request,customerConfigurationId}' IS DISTINCT FROM NEW.customer_configuration_id
      OR (intent #>> '{request,backendConfigurationRef,resourceId}')::uuid IS DISTINCT FROM NEW.authority_configuration_id
      OR intent #>> '{request,backend}' IS DISTINCT FROM NEW.authority_backend_kind
      OR intent #>> '{request,backendId}' IS DISTINCT FROM NEW.authority_backend_id
      OR NEW.reservation_id IS NOT NULL OR NEW.attempt_id IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck';
    END IF;
  ELSE
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck';
  END IF;

  PERFORM 1 FROM "inventory"."backend_configurations" AS authority
  WHERE authority.tenant_id = NEW.tenant_id
    AND authority.configuration_id = NEW.authority_configuration_id
    AND authority.customer_configuration_id = NEW.customer_configuration_id
    AND authority.backend_kind = NEW.authority_backend_kind
    AND authority.backend_id = NEW.authority_backend_id
  FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck'; END IF;

  IF NEW.resolution_json IS NOT NULL THEN
    resolution_identity := NEW.resolution_json #>> '{effect,request,effectId}';
    resolution_business_request := CASE NEW.effect_kind
      WHEN 'RESERVATION_CREATE' THEN (NEW.resolution_json #> '{effect,request}') - 'mutationId' - 'requestedAt' - 'sourceActionInvocationId'
      WHEN 'RESERVATION_RELEASE' THEN (NEW.resolution_json #> '{effect,request}') - 'mutationId' - 'requestedAt' - 'sourceActionInvocationId'
      WHEN 'ESTABLISH_COMMITMENT_PROTECTION' THEN NEW.resolution_json #> '{effect,request}'
      WHEN 'PHYSICAL_RECEIPT' THEN (NEW.resolution_json #> '{effect,request}') - 'actionInvocationId' - 'requestedAt'
      WHEN 'PHYSICAL_ISSUE' THEN (NEW.resolution_json #> '{effect,request}') - 'actionInvocationId' - 'requestedAt'
    END;
    IF NEW.resolution_json ->> '_tag' IS DISTINCT FROM NEW.effect_kind
      OR resolution_identity IS DISTINCT FROM NEW.effect_id
      OR resolution_business_request IS DISTINCT FROM intent -> 'request'
      OR (
        NEW.effect_kind = 'ESTABLISH_COMMITMENT_PROTECTION'
        AND NEW.resolution_json #>> '{effect,_tag}' = 'PROTECTED'
        AND (
          NEW.resolution_json #> '{effect,protection,ref}' IS DISTINCT FROM intent #> '{request,protectionRef}'
          OR NEW.resolution_json #> '{effect,protection,confirmation}' IS DISTINCT FROM intent #> '{request,confirmation}'
          OR NEW.resolution_json #>> '{effect,protection,authorityEvidence,effectId}' IS DISTINCT FROM NEW.effect_id
          OR NEW.resolution_json #>> '{effect,protection,authorityEvidence,operation}' IS DISTINCT FROM 'COMMITMENT_PROTECTION'
        )
      )
      OR NEW.current_state IS DISTINCT FROM (CASE NEW.effect_kind
        WHEN 'RESERVATION_CREATE' THEN CASE NEW.resolution_json #>> '{effect,_tag}' WHEN 'INDETERMINATE' THEN 'INDETERMINATE' WHEN 'RECONCILIATION_REQUIRED' THEN 'INDETERMINATE' WHEN 'ESTABLISHED' THEN 'SUCCEEDED' WHEN 'RESOLVED_NO_RESERVATION' THEN 'REJECTED' END
        WHEN 'RESERVATION_RELEASE' THEN CASE NEW.resolution_json #>> '{effect,_tag}' WHEN 'INDETERMINATE' THEN 'INDETERMINATE' WHEN 'RELEASED' THEN 'SUCCEEDED' WHEN 'NOT_RELEASABLE' THEN 'REJECTED' END
        WHEN 'ESTABLISH_COMMITMENT_PROTECTION' THEN CASE NEW.resolution_json #>> '{effect,_tag}' WHEN 'PROTECTED' THEN 'SUCCEEDED' WHEN 'NOT_PROTECTABLE' THEN 'REJECTED' END
        WHEN 'PHYSICAL_RECEIPT' THEN CASE NEW.resolution_json #>> '{effect,_tag}' WHEN 'INDETERMINATE' THEN 'INDETERMINATE' WHEN 'APPLIED' THEN 'SUCCEEDED' WHEN 'REJECTED' THEN 'REJECTED' END
        WHEN 'PHYSICAL_ISSUE' THEN CASE NEW.resolution_json #>> '{effect,_tag}' WHEN 'INDETERMINATE' THEN 'INDETERMINATE' WHEN 'APPLIED' THEN 'SUCCEEDED' WHEN 'REJECTED' THEN 'REJECTED' END
      END) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_effect_ledger_exact_scope_ck',
        MESSAGE = 'Inventory effect resolution must preserve exact business intent, kind, identity, and terminal meaning';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_effect_ledger_exact_scope"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "inventory"."finalize_commitment_protection_for_worker"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_effect_id text,
  p_expected_revision integer,
  p_expected_state text,
  p_effect jsonb
) RETURNS TABLE(record jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_current "inventory"."effect_ledger"%ROWTYPE;
  v_existing "inventory"."commitment_protections"%ROWTYPE;
  v_next jsonb;
  v_next_state text;
  v_protection jsonb := p_effect -> 'protection';
  v_resolution jsonb;
  v_tag text := p_effect ->> '_tag';
  v_updated_at timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Commitment Protection worker scope mismatch';
  END IF;

  SELECT effect.*
  INTO v_current
  FROM "inventory"."effect_ledger" AS effect
  WHERE effect.tenant_id = p_tenant_id
    AND effect.legal_entity_id = p_legal_entity_id
    AND effect.effect_id = p_effect_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_resolution := pg_catalog.jsonb_build_object('_tag', 'ESTABLISH_COMMITMENT_PROTECTION', 'effect', p_effect);
  v_next_state := CASE v_tag WHEN 'PROTECTED' THEN 'SUCCEEDED' WHEN 'NOT_PROTECTABLE' THEN 'REJECTED' END;

  IF v_current.effect_kind IS DISTINCT FROM 'ESTABLISH_COMMITMENT_PROTECTION'
    OR v_tag IS NULL
    OR v_next_state IS NULL
    OR p_effect -> 'request' IS DISTINCT FROM v_current.intent_json -> 'request'
    OR p_effect #>> '{request,effectId}' IS DISTINCT FROM p_effect_id
    OR p_effect #>> '{request,legalEntityId}' IS DISTINCT FROM p_legal_entity_id::text
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_commitment_protection_worker_finalization_ck',
      MESSAGE = 'Commitment Protection finalization must preserve the exact durable request';
  END IF;

  IF v_current.current_state IN ('SUCCEEDED', 'REJECTED') THEN
    IF v_current.resolution_json IS DISTINCT FROM v_resolution THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_commitment_protection_worker_finalization_ck',
        MESSAGE = 'Terminal Commitment Protection evidence cannot be replaced';
    END IF;
    RETURN QUERY SELECT v_current.snapshot;
    RETURN;
  END IF;

  IF v_current.current_revision IS DISTINCT FROM p_expected_revision
    OR v_current.current_state IS DISTINCT FROM p_expected_state
    OR p_expected_state NOT IN ('REQUESTED', 'INDETERMINATE')
  THEN
    RETURN;
  END IF;

  IF v_tag = 'PROTECTED' THEN
    INSERT INTO "inventory"."commitment_protections" (
      protection_id,
      tenant_id,
      confirmation_id,
      reservation_id,
      attempt_id,
      owner_configuration_id,
      issuer_backend_kind,
      issuer_backend_id,
      authority_effect_id,
      owner_evidence_ref,
      established_at,
      current_health_state,
      current_revision,
      snapshot,
      updated_at
    ) VALUES (
      (v_protection #>> '{ref,resourceId}')::uuid,
      p_tenant_id,
      (v_protection #>> '{confirmation,ref,resourceId}')::uuid,
      (v_protection #>> '{confirmation,reservation,ref,resourceId}')::uuid,
      v_protection #>> '{confirmation,reservation,origin,attemptId}',
      (v_protection #>> '{confirmation,reservation,authority,configurationId}')::uuid,
      v_protection #>> '{authorityEvidence,issuer,backend}',
      v_protection #>> '{authorityEvidence,issuer,backendId}',
      v_protection #>> '{authorityEvidence,effectId}',
      v_protection #>> '{authorityEvidence,evidence,ownerEvidenceRef}',
      (v_protection ->> 'establishedAt')::timestamptz,
      v_protection #>> '{health,state}',
      (v_protection ->> 'revision')::integer,
      v_protection,
      (v_protection #>> '{health,observation,effectiveAt}')::timestamptz
    )
    ON CONFLICT DO NOTHING;

    SELECT protection.*
    INTO v_existing
    FROM "inventory"."commitment_protections" AS protection
    WHERE protection.tenant_id = p_tenant_id
      AND (
        protection.protection_id = (v_protection #>> '{ref,resourceId}')::uuid
        OR protection.authority_effect_id = p_effect_id
        OR (
          protection.reservation_id = (v_protection #>> '{confirmation,reservation,ref,resourceId}')::uuid
          AND protection.attempt_id = v_protection #>> '{confirmation,reservation,origin,attemptId}'
        )
      )
    ORDER BY protection.protection_id
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND OR v_existing.snapshot IS DISTINCT FROM v_protection THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_commitment_protection_worker_finalization_ck',
        MESSAGE = 'Commitment Protection identity is already bound to different evidence';
    END IF;

    INSERT INTO "inventory"."commitment_protection_history" (
      tenant_id, protection_id, revision, health_state, snapshot, transitioned_at
    ) VALUES (
      p_tenant_id,
      v_existing.protection_id,
      v_existing.current_revision,
      v_existing.current_health_state,
      v_existing.snapshot,
      v_existing.updated_at
    )
    ON CONFLICT (tenant_id, protection_id, revision) DO NOTHING;

    IF NOT EXISTS (
      SELECT 1
      FROM "inventory"."commitment_protection_history" AS history
      WHERE history.tenant_id = p_tenant_id
        AND history.protection_id = v_existing.protection_id
        AND history.revision = v_existing.current_revision
        AND history.snapshot = v_existing.snapshot
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_commitment_protection_worker_finalization_ck',
        MESSAGE = 'Commitment Protection history conflicts with terminal evidence';
    END IF;
  END IF;

  v_next := pg_catalog.jsonb_build_object(
    'tenantId', p_tenant_id::text,
    'effectId', p_effect_id,
    'intent', v_current.intent_json,
    'currentState', v_next_state,
    'revision', p_expected_revision + 1,
    'requestedAt', v_current.snapshot ->> 'requestedAt',
    'updatedAt', pg_catalog.to_char(v_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'resolution', v_resolution
  );

  UPDATE "inventory"."effect_ledger"
  SET current_state = v_next_state,
    current_revision = p_expected_revision + 1,
    resolution_json = v_resolution,
    snapshot = v_next,
    updated_at = v_updated_at
  WHERE tenant_id = p_tenant_id
    AND legal_entity_id = p_legal_entity_id
    AND effect_id = p_effect_id
    AND current_revision = p_expected_revision
    AND current_state = p_expected_state
  RETURNING * INTO v_current;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  INSERT INTO "inventory"."effect_ledger_history" (
    tenant_id, effect_id, revision, state, snapshot, transitioned_at
  ) VALUES (
    v_current.tenant_id,
    v_current.effect_id,
    v_current.current_revision,
    v_current.current_state,
    v_current.snapshot,
    v_current.updated_at
  );

  RETURN QUERY SELECT v_current.snapshot;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."finalize_commitment_protection_for_worker"(uuid, uuid, text, integer, text, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "inventory"."finalize_commitment_protection_for_worker"(uuid, uuid, text, integer, text, jsonb) TO "ontos_runtime";
