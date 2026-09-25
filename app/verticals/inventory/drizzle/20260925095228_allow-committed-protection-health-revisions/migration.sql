-- Health-only protection revisions must still prove the exact immutable owner lineage.
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
    OR NEW.snapshot #>> '{authorityEvidence,issuer,origin}' IS DISTINCT FROM CASE NEW.issuer_backend_kind
      WHEN 'external_business_system' THEN 'EXTERNAL_BUSINESS_SYSTEM'
      WHEN 'ontos_wms' THEN 'ONTOS_WMS'
    END
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

  SELECT pg_catalog.jsonb_agg(allocation.entry ORDER BY allocation.entry ->> 'allocationId')
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
