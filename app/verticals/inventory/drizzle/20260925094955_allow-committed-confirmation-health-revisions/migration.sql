-- Binding-correction health revisions preserve the immutable provisional Reservation snapshot while
-- validating against the same Reservation after its legal commit transition.
CREATE OR REPLACE FUNCTION "inventory"."enforce_reservation_confirmation_scope"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
DECLARE
  observation_tag text;
BEGIN
  IF pg_catalog.jsonb_typeof(NEW.snapshot) IS DISTINCT FROM 'object'
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.snapshot)) <> 8
    OR NOT (
      NEW.snapshot ?& ARRAY[
        'authorityEvidence', 'expiresAt', 'health', 'issuanceRank', 'issuedAt', 'ref', 'reservation', 'revision'
      ]
    )
    OR pg_catalog.jsonb_typeof(NEW.snapshot -> 'reservation') IS DISTINCT FROM 'object'
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.snapshot -> 'reservation')) <> 6
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.snapshot -> 'ref')) <> 4
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.snapshot #> '{reservation,ref}')) <> 4
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.snapshot #> '{reservation,origin}')) <> 2
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.snapshot #> '{reservation,authority}')) <> 6
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.snapshot #> '{reservation,authority,selection}')) <> 4
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.snapshot -> 'authorityEvidence')) <> 5
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.snapshot #> '{authorityEvidence,issuer}')) <> 3
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.snapshot #> '{authorityEvidence,evidence}')) <> 7
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.snapshot -> 'health')) <> 2
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.snapshot -> 'issuanceRank')) <> 3
    OR pg_catalog.jsonb_typeof(NEW.snapshot #> '{reservation,requirements}') IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_array_length(NEW.snapshot #> '{reservation,requirements}') < 1
    OR NEW.snapshot #>> '{ref,moduleId}' IS DISTINCT FROM 'commerce.inventory'
    OR NEW.snapshot #>> '{ref,resourceType}' IS DISTINCT FROM 'commerce.inventory.reservation-confirmation'
    OR NEW.snapshot #>> '{ref,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
    OR NEW.snapshot #>> '{ref,resourceId}' IS DISTINCT FROM NEW.confirmation_id::text
    OR NEW.snapshot #>> '{reservation,ref,moduleId}' IS DISTINCT FROM 'commerce.inventory'
    OR NEW.snapshot #>> '{reservation,ref,resourceType}'
      IS DISTINCT FROM 'commerce.inventory.inventory-reservation'
    OR NEW.snapshot #>> '{reservation,ref,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
    OR NEW.snapshot #>> '{reservation,ref,resourceId}' IS DISTINCT FROM NEW.reservation_id::text
    OR NEW.snapshot #>> '{reservation,origin,kind}' IS DISTINCT FROM 'ORDER_COMMITMENT_ATTEMPT'
    OR NEW.snapshot #>> '{reservation,origin,attemptId}' IS DISTINCT FROM NEW.attempt_id
    OR NEW.snapshot #>> '{reservation,lifecycleMeaning}' IS DISTINCT FROM 'PROVISIONAL_RESERVATION'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_reservation_confirmations_snapshot_ck',
      MESSAGE = 'Reservation Confirmation snapshot identity must exactly match its relational identity';
  END IF;

  PERFORM 1
  FROM "inventory"."obligations" AS reservation
  WHERE reservation.tenant_id = NEW.tenant_id
    AND reservation.obligation_id = NEW.reservation_id
    AND reservation.origin_kind = 'ORDER_COMMITMENT_ATTEMPT'
    AND reservation.attempt_id = NEW.attempt_id
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
    AND reservation.source_system IS NULL
    AND reservation.source_order_id IS NULL
    AND reservation.source_obligation_id IS NULL
    AND reservation.customer_configuration_id
      = NEW.snapshot #>> '{reservation,authority,customerConfigurationId}'
    AND reservation.owner_configuration_id = NEW.owner_configuration_id
    AND reservation.authority_backend_kind = NEW.issuer_backend_kind
    AND reservation.authority_backend_id = NEW.issuer_backend_id
    AND reservation.authority_selected_at
      = (NEW.snapshot #>> '{reservation,authority,selectedAt}')::timestamptz
    AND reservation.authority_revision
      = (NEW.snapshot #>> '{reservation,authority,revision}')::integer
    AND reservation.established_at
      = (NEW.snapshot #>> '{reservation,establishedAt}')::timestamptz
  FOR UPDATE;

  IF NOT FOUND
    OR (
      SELECT pg_catalog.count(*)
      FROM "inventory"."obligation_requirements" AS stored_requirement
      WHERE stored_requirement.tenant_id = NEW.tenant_id
        AND stored_requirement.obligation_id = NEW.reservation_id
    ) IS DISTINCT FROM pg_catalog.jsonb_array_length(NEW.snapshot #> '{reservation,requirements}')
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(
        NEW.snapshot #> '{reservation,requirements}'
      ) AS expected_requirement(entry)
      WHERE (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(expected_requirement.entry)) <> 8
        OR pg_catalog.jsonb_typeof(expected_requirement.entry -> 'allocations') IS DISTINCT FROM 'array'
        OR pg_catalog.jsonb_array_length(expected_requirement.entry -> 'allocations') < 1
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_array_elements(expected_requirement.entry -> 'allocations') AS allocation(entry)
          WHERE (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(allocation.entry)) <> 4
        )
        OR NOT EXISTS (
        SELECT 1
        FROM "inventory"."obligation_requirements" AS stored_requirement
        WHERE stored_requirement.tenant_id = NEW.tenant_id
          AND stored_requirement.obligation_id = NEW.reservation_id
          AND stored_requirement.purchase_demand_occurrence_id
            = expected_requirement.entry ->> 'purchaseDemandOccurrenceId'
          AND stored_requirement.binding_id
            = (expected_requirement.entry #>> '{bindingRef,resourceId}')::uuid
          AND stored_requirement.catalog_selection = expected_requirement.entry -> 'catalogSelection'
          AND stored_requirement.exact_selection_meaning_id
            = expected_requirement.entry #>> '{exactSelectionMeaning,id}'
          AND stored_requirement.exact_selection_meaning_kind
            = expected_requirement.entry #>> '{exactSelectionMeaning,kind}'
          AND stored_requirement.stock_item_id
            = (expected_requirement.entry #>> '{stockItem,stockItemRef,resourceId}')::uuid
          AND stored_requirement.stock_item_revision
            = (expected_requirement.entry #>> '{stockItem,revision}')::integer
          AND stored_requirement.stock_item_snapshot = expected_requirement.entry -> 'stockItem'
          AND stored_requirement.requested_amount = (expected_requirement.entry ->> 'quantity')::numeric
          AND stored_requirement.unit_module_id = expected_requirement.entry #>> '{unitRef,moduleId}'
          AND stored_requirement.unit_resource_id
            = (expected_requirement.entry #>> '{unitRef,resourceId}')::uuid
          AND stored_requirement.unit_resource_type = expected_requirement.entry #>> '{unitRef,resourceType}'
          AND stored_requirement.unit_tenant_id
            = (expected_requirement.entry #>> '{unitRef,tenantId}')::uuid
      )
    )
    OR (
      SELECT pg_catalog.count(*)
      FROM "inventory"."obligation_allocations" AS stored_allocation
      WHERE stored_allocation.tenant_id = NEW.tenant_id
        AND stored_allocation.obligation_id = NEW.reservation_id
    ) IS DISTINCT FROM (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.jsonb_array_elements(
        NEW.snapshot #> '{reservation,requirements}'
      ) AS expected_requirement(entry)
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
        expected_requirement.entry -> 'allocations'
      ) AS expected_allocation(entry)
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(
        NEW.snapshot #> '{reservation,requirements}'
      ) AS expected_requirement(entry)
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
        expected_requirement.entry -> 'allocations'
      ) AS expected_allocation(entry)
      WHERE NOT EXISTS (
        SELECT 1
        FROM "inventory"."obligation_allocations" AS stored_allocation
        WHERE stored_allocation.tenant_id = NEW.tenant_id
          AND stored_allocation.obligation_id = NEW.reservation_id
          AND stored_allocation.allocation_id = expected_allocation.entry ->> 'allocationId'
          AND stored_allocation.purchase_demand_occurrence_id
            = expected_requirement.entry ->> 'purchaseDemandOccurrenceId'
          AND stored_allocation.stock_item_id
            = (expected_allocation.entry #>> '{stockItemRef,resourceId}')::uuid
          AND stored_allocation.stock_position_id
            = (expected_allocation.entry #>> '{positionRef,resourceId}')::uuid
          AND stored_allocation.allocated_amount
            = (expected_allocation.entry #>> '{quantity,amount}')::numeric
          AND stored_allocation.unit_module_id
            = expected_allocation.entry #>> '{quantity,unitRef,moduleId}'
          AND stored_allocation.unit_resource_id
            = (expected_allocation.entry #>> '{quantity,unitRef,resourceId}')::uuid
          AND stored_allocation.unit_resource_type
            = expected_allocation.entry #>> '{quantity,unitRef,resourceType}'
          AND stored_allocation.unit_tenant_id
            = (expected_allocation.entry #>> '{quantity,unitRef,tenantId}')::uuid
      )
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_reservation_confirmations_exact_reservation_ck',
      MESSAGE = 'Reservation Confirmation must reference one exact runtime Attempt and its immutable Reservation lineage';
  END IF;

  PERFORM 1
  FROM "inventory"."backend_configurations" AS authority
  WHERE authority.tenant_id = NEW.tenant_id
    AND authority.configuration_id = NEW.owner_configuration_id
    AND authority.customer_configuration_id
      = NEW.snapshot #>> '{reservation,authority,customerConfigurationId}'
    AND authority.backend_kind = NEW.issuer_backend_kind
    AND authority.backend_id = NEW.issuer_backend_id
    AND authority.exact_reservation_capability = 'SUPPORTED'
    AND authority.stock_correction_capability
      = NEW.snapshot #>> '{reservation,authority,selection,stockCorrectionCapability}'
    AND authority.selected_at
      = (NEW.snapshot #>> '{reservation,authority,selectedAt}')::timestamptz
    AND authority.revision = (NEW.snapshot #>> '{reservation,authority,revision}')::integer
    AND NEW.snapshot #>> '{reservation,authority,tenantId}' = NEW.tenant_id::text
    AND NEW.snapshot #>> '{reservation,authority,configurationId}' = NEW.owner_configuration_id::text
    AND NEW.snapshot #>> '{reservation,authority,selection,backend}' = authority.backend_kind
    AND NEW.snapshot #>> '{reservation,authority,selection,backendId}' = authority.backend_id
    AND NEW.snapshot #>> '{reservation,authority,selection,exactReservationCapability}'
      = authority.exact_reservation_capability
  FOR KEY SHARE;

  IF NOT FOUND
    OR pg_catalog.jsonb_typeof(NEW.snapshot -> 'authorityEvidence') IS DISTINCT FROM 'object'
    OR NEW.snapshot #>> '{authorityEvidence,kind}'
      IS DISTINCT FROM 'AUTHORITATIVE_RESERVATION_EVIDENCE'
    OR NEW.snapshot #>> '{authorityEvidence,operation}' IS DISTINCT FROM 'RESERVATION_CONFIRMATION'
    OR NEW.snapshot #>> '{authorityEvidence,effectId}' IS DISTINCT FROM NEW.authority_effect_id
    OR NEW.snapshot #>> '{authorityEvidence,issuer,backend}' IS DISTINCT FROM NEW.issuer_backend_kind
    OR NEW.snapshot #>> '{authorityEvidence,issuer,backendId}' IS DISTINCT FROM NEW.issuer_backend_id
    OR NEW.snapshot #>> '{authorityEvidence,issuer,origin}' IS DISTINCT FROM (CASE NEW.issuer_backend_kind
      WHEN 'external_business_system' THEN 'EXTERNAL_BUSINESS_SYSTEM'
      ELSE 'ONTOS_WMS'
    END)
    OR NEW.snapshot #>> '{authorityEvidence,evidence,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
    OR NEW.snapshot #>> '{authorityEvidence,evidence,reservationId}' IS DISTINCT FROM NEW.reservation_id::text
    OR NEW.snapshot #>> '{authorityEvidence,evidence,attemptId}' IS DISTINCT FROM NEW.attempt_id
    OR NEW.snapshot #>> '{authorityEvidence,evidence,customerConfigurationId}'
      IS DISTINCT FROM NEW.snapshot #>> '{reservation,authority,customerConfigurationId}'
    OR NEW.snapshot #>> '{authorityEvidence,evidence,ownerEvidenceRef}'
      IS DISTINCT FROM NEW.owner_evidence_ref
    OR (NEW.snapshot #>> '{authorityEvidence,evidence,validFrom}')::timestamptz
      IS DISTINCT FROM NEW.issued_at
    OR (NEW.snapshot #>> '{authorityEvidence,evidence,validUntil}')::timestamptz
      IS DISTINCT FROM NEW.expires_at
    OR pg_catalog.jsonb_typeof(NEW.snapshot #> '{authorityEvidence,evidence,allocations}')
      IS DISTINCT FROM 'array'
    OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.jsonb_array_elements(
        NEW.snapshot #> '{authorityEvidence,evidence,allocations}'
      ) AS authority_allocation(entry)
    ) IS DISTINCT FROM (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.jsonb_array_elements(
        NEW.snapshot #> '{reservation,requirements}'
      ) AS requirement(entry)
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
        requirement.entry -> 'allocations'
      ) AS reservation_allocation(entry)
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(
        NEW.snapshot #> '{authorityEvidence,evidence,allocations}'
      ) AS authority_allocation(entry)
      WHERE (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(authority_allocation.entry)) <> 4
        OR NOT EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(
          NEW.snapshot #> '{reservation,requirements}'
        ) AS requirement(entry)
        CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
          requirement.entry -> 'allocations'
        ) AS reservation_allocation(entry)
        WHERE reservation_allocation.entry ->> 'allocationId'
            = authority_allocation.entry ->> 'allocationId'
          AND reservation_allocation.entry -> 'stockItemRef'
            = authority_allocation.entry -> 'stockItemRef'
          AND reservation_allocation.entry -> 'positionRef'
            = authority_allocation.entry -> 'stockPositionRef'
          AND reservation_allocation.entry -> 'quantity'
            = authority_allocation.entry -> 'quantity'
      )
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_reservation_confirmations_exact_authority_ck',
      MESSAGE = 'Reservation Confirmation authority evidence must exactly match the selected backend and Reservation';
  END IF;

  observation_tag := NEW.snapshot #>> '{health,observation,_tag}';
  IF observation_tag IS NULL
    OR NEW.snapshot #>> '{health,observation,effectiveAt}' IS NULL
    OR NEW.snapshot ->> 'issuedAt' IS NULL
    OR (NEW.snapshot ->> 'issuedAt')::timestamptz IS DISTINCT FROM NEW.issued_at
    OR NEW.snapshot ->> 'expiresAt' IS NULL
    OR (NEW.snapshot ->> 'expiresAt')::timestamptz IS DISTINCT FROM NEW.expires_at
    OR NEW.snapshot #>> '{issuanceRank,source}' IS DISTINCT FROM 'RESERVATION_AUTHORITY_EVIDENCE'
    OR (NEW.snapshot #>> '{issuanceRank,issuedAt}')::timestamptz IS DISTINCT FROM NEW.issued_at
    OR NEW.snapshot #>> '{issuanceRank,ownerEvidenceRef}' IS DISTINCT FROM NEW.owner_evidence_ref
    OR (NEW.snapshot ->> 'revision')::integer IS DISTINCT FROM NEW.current_revision
    OR NEW.snapshot #>> '{health,state}' IS DISTINCT FROM NEW.current_health_state
    OR (NEW.snapshot #>> '{health,observation,effectiveAt}')::timestamptz < NEW.issued_at
    OR (
      TG_OP = 'INSERT'
      AND (
        NEW.current_revision IS DISTINCT FROM 1
        OR NEW.current_health_state IS DISTINCT FROM 'VALID'
        OR observation_tag IS DISTINCT FROM 'ISSUED'
      )
    )
    OR (
      observation_tag = 'ISSUED'
      AND (
        NEW.current_revision IS DISTINCT FROM 1
        OR NEW.current_health_state IS DISTINCT FROM 'VALID'
        OR (NEW.snapshot #>> '{health,observation,effectiveAt}')::timestamptz IS DISTINCT FROM NEW.issued_at
        OR NEW.snapshot #>> '{health,observation,ownerEvidenceRef}' IS DISTINCT FROM NEW.owner_evidence_ref
      )
    )
    OR (
      observation_tag = 'OWNER_HEALTHY'
      AND (
        NEW.current_health_state IS DISTINCT FROM 'VALID'
        OR coalesce(
          pg_catalog.length(pg_catalog.btrim(NEW.snapshot #>> '{health,observation,ownerEvidenceRef}')),
          0
        ) NOT BETWEEN 1 AND 300
      )
    )
    OR (
      observation_tag = 'MATERIAL_IMPAIRMENT'
      AND (
        NEW.current_health_state IS DISTINCT FROM 'AT_RISK'
        OR coalesce(
          pg_catalog.length(pg_catalog.btrim(NEW.snapshot #>> '{health,observation,ownerEvidenceRef}')),
          0
        ) NOT BETWEEN 1 AND 300
      )
    )
    OR (
      observation_tag = 'BINDING_CORRECTION'
      AND (
        NEW.current_health_state IS DISTINCT FROM 'AT_RISK'
        OR coalesce(
          pg_catalog.length(pg_catalog.btrim(NEW.snapshot #>> '{health,observation,correctionEvidenceRef}')),
          0
        ) NOT BETWEEN 1 AND 300
      )
    )
    OR (
      observation_tag = 'DEFINITIVE_REVOCATION'
      AND (
        NEW.current_health_state IS DISTINCT FROM 'REVOKED'
        OR NEW.snapshot #>> '{health,observation,decision}' IS DISTINCT FROM 'DEFINITIVE'
        OR coalesce(
          pg_catalog.length(pg_catalog.btrim(NEW.snapshot #>> '{health,observation,ownerEvidenceRef}')),
          0
        ) NOT BETWEEN 1 AND 300
      )
    )
    OR (
      observation_tag = 'OWNER_UNVERIFIABLE'
      AND (
        NEW.current_health_state IS DISTINCT FROM 'UNVERIFIABLE'
        OR NEW.snapshot #>> '{health,observation,reason}' NOT IN (
          'OWNER_EVIDENCE_MISSING',
          'OWNER_EVIDENCE_STALE',
          'OWNER_EVIDENCE_UNAVAILABLE',
          'OWNER_EVIDENCE_INDETERMINATE'
        )
      )
    )
    OR (
      observation_tag = 'VALIDITY_ELAPSED'
      AND (
        NEW.current_health_state IS DISTINCT FROM 'EXPIRED'
        OR (NEW.snapshot #>> '{health,observation,effectiveAt}')::timestamptz < NEW.expires_at
      )
    )
    OR observation_tag NOT IN (
      'ISSUED',
      'OWNER_HEALTHY',
      'MATERIAL_IMPAIRMENT',
      'BINDING_CORRECTION',
      'DEFINITIVE_REVOCATION',
      'OWNER_UNVERIFIABLE',
      'VALIDITY_ELAPSED'
    )
    OR (
      observation_tag <> 'VALIDITY_ELAPSED'
      AND (NEW.snapshot #>> '{health,observation,effectiveAt}')::timestamptz >= NEW.expires_at
    )
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.snapshot #> '{health,observation}'))
      IS DISTINCT FROM (CASE observation_tag
        WHEN 'DEFINITIVE_REVOCATION' THEN 4
        WHEN 'VALIDITY_ELAPSED' THEN 2
        ELSE 3
      END)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_reservation_confirmations_snapshot_ck',
      MESSAGE = 'Reservation Confirmation snapshot, health, validity, and revision must be exact';
  END IF;

  RETURN NEW;
END;
$$;
