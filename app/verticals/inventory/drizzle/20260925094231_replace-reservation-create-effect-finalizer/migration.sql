CREATE OR REPLACE FUNCTION "inventory"."finalize_reservation_create_effect_for_worker"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_effect_id text,
  p_terminal jsonb
) RETURNS TABLE(record jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  allocation jsonb;
  current_binding "inventory"."catalog_to_stock_bindings"%ROWTYPE;
  current_effect "inventory"."reservation_create_effects"%ROWTYPE;
  expected_allocation_count integer := 0;
  requirement jsonb;
  stored_count integer;
  stored_obligation "inventory"."obligations"%ROWTYPE;
  terminal_tag text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Inventory Reservation create-effect worker scope mismatch';
  END IF;

  SELECT effect.*
  INTO current_effect
  FROM "inventory"."reservation_create_effects" AS effect
  WHERE effect.tenant_id = p_tenant_id
    AND effect.legal_entity_id = p_legal_entity_id
    AND effect.effect_id = p_effect_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  terminal_tag := p_terminal ->> '_tag';
  IF pg_catalog.jsonb_typeof(p_terminal) IS DISTINCT FROM 'object'
    OR terminal_tag IS NULL
    OR terminal_tag NOT IN (
      'ESTABLISHED',
      'RECONCILIATION_REQUIRED',
      'INDETERMINATE',
      'RESOLVED_NO_RESERVATION'
    )
    OR p_terminal -> 'request' IS DISTINCT FROM current_effect.request_json
    OR p_terminal #>> '{request,effectId}' IS DISTINCT FROM current_effect.effect_id
    OR p_terminal #>> '{request,legalEntityId}' IS DISTINCT FROM current_effect.legal_entity_id::text
    OR p_terminal #>> '{request,mutationId}' IS DISTINCT FROM current_effect.mutation_id::text
    OR p_terminal #>> '{request,sourceActionInvocationId}'
      IS DISTINCT FROM current_effect.source_action_invocation_id::text
    OR p_terminal #>> '{request,authority,tenantId}' IS DISTINCT FROM current_effect.tenant_id::text
    OR p_terminal #>> '{request,authority,configurationId}'
      IS DISTINCT FROM current_effect.backend_configuration_id::text
    OR p_terminal #>> '{request,reservation,ref,resourceId}' IS DISTINCT FROM current_effect.reservation_id::text
    OR p_terminal #>> '{request,reservation,origin,attemptId}' IS DISTINCT FROM current_effect.attempt_id
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_reservation_create_effects_terminal_payload_ck',
      MESSAGE = 'Inventory Reservation create-effect terminal payload must exactly match its durable request';
  END IF;

  IF terminal_tag = 'ESTABLISHED' THEN
    IF (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_terminal)) <> 4
      OR coalesce(pg_catalog.length(pg_catalog.btrim(p_terminal ->> 'ownerEvidenceRef')), 0) NOT BETWEEN 1 AND 300
      OR pg_catalog.jsonb_typeof(p_terminal -> 'reservation') IS DISTINCT FROM 'object'
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_terminal -> 'reservation')) <> 6
      OR p_terminal #> '{reservation,authority}' IS DISTINCT FROM current_effect.request_json -> 'authority'
      OR p_terminal #> '{reservation,origin}' IS DISTINCT FROM current_effect.request_json #> '{reservation,origin}'
      OR p_terminal #> '{reservation,ref}' IS DISTINCT FROM current_effect.request_json #> '{reservation,ref}'
      OR p_terminal #> '{reservation,requirements}'
        IS DISTINCT FROM current_effect.request_json #> '{reservation,requirements}'
      OR p_terminal #>> '{reservation,lifecycleMeaning}' IS DISTINCT FROM 'PROVISIONAL_RESERVATION'
      OR (p_terminal #>> '{reservation,establishedAt}')::timestamptz IS NULL
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_reservation_create_effects_terminal_payload_ck',
        MESSAGE = 'Established Inventory Reservation must exactly preserve the durable request and allocation plan';
    END IF;
  ELSIF terminal_tag = 'RECONCILIATION_REQUIRED' THEN
    IF (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_terminal)) <> 5
      OR pg_catalog.jsonb_typeof(p_terminal -> 'constrainedAllocations') IS DISTINCT FROM 'array'
      OR pg_catalog.jsonb_array_length(p_terminal -> 'constrainedAllocations') < 1
      OR (p_terminal ->> 'observedAt')::timestamptz IS NULL
      OR coalesce(pg_catalog.length(pg_catalog.btrim(p_terminal ->> 'ownerEvidenceRef')), 0) NOT BETWEEN 1 AND 300
      OR (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.jsonb_array_elements(p_terminal -> 'constrainedAllocations') AS observed(entry)
      ) IS DISTINCT FROM (
        SELECT pg_catalog.count(DISTINCT observed.entry ->> 'allocationId')
        FROM pg_catalog.jsonb_array_elements(p_terminal -> 'constrainedAllocations') AS observed(entry)
      )
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(p_terminal -> 'constrainedAllocations') AS observed(entry)
        WHERE NOT EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_array_elements(
            current_effect.request_json #> '{reservation,requirements}'
          ) AS planned_requirement(entry)
          CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
            planned_requirement.entry -> 'allocations'
          ) AS planned_allocation(entry)
          WHERE planned_allocation.entry ->> 'allocationId' = observed.entry ->> 'allocationId'
            AND planned_allocation.entry -> 'stockItemRef' = observed.entry -> 'stockItemRef'
            AND planned_allocation.entry -> 'positionRef' = observed.entry -> 'stockPositionRef'
            AND planned_allocation.entry #> '{quantity,unitRef}' = observed.entry #> '{quantity,unitRef}'
            AND (observed.entry #>> '{quantity,amount}')::numeric > 0
            AND (observed.entry #>> '{quantity,amount}')::numeric
              <= (planned_allocation.entry #>> '{quantity,amount}')::numeric
        )
      )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_reservation_create_effects_terminal_payload_ck',
        MESSAGE = 'Reconciliation-required Inventory Reservation evidence must remain within the durable plan';
    END IF;
  ELSIF terminal_tag = 'INDETERMINATE' THEN
    IF (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_terminal)) <> 5
      OR pg_catalog.jsonb_typeof(p_terminal -> 'possibleConstrainedAllocations') IS DISTINCT FROM 'array'
      OR pg_catalog.jsonb_array_length(p_terminal -> 'possibleConstrainedAllocations') < 1
      OR (p_terminal ->> 'observedAt')::timestamptz IS NULL
      OR p_terminal ->> 'reason' IS NULL
      OR p_terminal ->> 'reason' NOT IN (
        'DISPATCH_PENDING',
        'BACKEND_OUTCOME_UNKNOWN',
        'EVIDENCE_UNVERIFIABLE',
        'AUTHORITY_UNAVAILABLE'
      )
      OR (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.jsonb_array_elements(p_terminal -> 'possibleConstrainedAllocations') AS possible(entry)
      ) IS DISTINCT FROM (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.jsonb_array_elements(
          current_effect.request_json #> '{reservation,requirements}'
        ) AS planned_requirement(entry)
        CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
          planned_requirement.entry -> 'allocations'
        ) AS planned_allocation(entry)
      )
      OR (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.jsonb_array_elements(p_terminal -> 'possibleConstrainedAllocations') AS possible(entry)
      ) IS DISTINCT FROM (
        SELECT pg_catalog.count(DISTINCT possible.entry ->> 'allocationId')
        FROM pg_catalog.jsonb_array_elements(p_terminal -> 'possibleConstrainedAllocations') AS possible(entry)
      )
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(p_terminal -> 'possibleConstrainedAllocations') AS possible(entry)
        WHERE NOT EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_array_elements(
            current_effect.request_json #> '{reservation,requirements}'
          ) AS planned_requirement(entry)
          CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
            planned_requirement.entry -> 'allocations'
          ) AS planned_allocation(entry)
          WHERE planned_allocation.entry ->> 'allocationId' = possible.entry ->> 'allocationId'
            AND planned_allocation.entry -> 'stockItemRef' = possible.entry -> 'stockItemRef'
            AND planned_allocation.entry -> 'positionRef' = possible.entry -> 'stockPositionRef'
            AND planned_allocation.entry -> 'quantity' = possible.entry -> 'quantity'
        )
      )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_reservation_create_effects_terminal_payload_ck',
        MESSAGE = 'Indeterminate Inventory Reservation evidence must retain bounded typed uncertainty';
    END IF;
  ELSE
    IF (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_terminal)) <> 5
      OR p_terminal -> 'effectAbsenceProven' IS DISTINCT FROM 'true'::jsonb
      OR (p_terminal ->> 'observedAt')::timestamptz IS NULL
      OR p_terminal ->> 'reason' IS NULL
      OR p_terminal ->> 'reason' NOT IN ('INSUFFICIENT_STOCK', 'BACKEND_REJECTED')
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_reservation_create_effects_terminal_payload_ck',
        MESSAGE = 'Resolved Inventory Reservation absence must retain authoritative no-effect proof';
    END IF;
  END IF;

  IF current_effect.state IN ('ESTABLISHED', 'RESOLVED_NO_RESERVATION') THEN
    IF current_effect.record_json IS DISTINCT FROM p_terminal THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_reservation_create_effects_transition_ck',
        MESSAGE = 'Terminal Inventory Reservation create-effect evidence cannot be replaced';
    END IF;
    RETURN QUERY SELECT current_effect.record_json;
    RETURN;
  END IF;

  IF terminal_tag = 'ESTABLISHED' THEN
    FOR requirement IN
      SELECT planned.entry
      FROM pg_catalog.jsonb_array_elements(
        current_effect.request_json #> '{reservation,requirements}'
      ) AS planned(entry)
      ORDER BY
        planned.entry #>> '{exactSelectionMeaning,kind}',
        planned.entry #>> '{exactSelectionMeaning,id}'
    LOOP
      SELECT binding.*
      INTO current_binding
      FROM "inventory"."catalog_to_stock_bindings" AS binding
      WHERE binding.tenant_id = p_tenant_id
        AND binding.exact_selection_kind = requirement #>> '{exactSelectionMeaning,kind}'
        AND binding.exact_selection_meaning_id = requirement #>> '{exactSelectionMeaning,id}'
      FOR UPDATE;

      IF NOT FOUND
        OR current_binding.binding_id::text IS DISTINCT FROM requirement #>> '{bindingRef,resourceId}'
        OR current_binding.stock_item_id::text
          IS DISTINCT FROM requirement #>> '{stockItem,stockItemRef,resourceId}'
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          CONSTRAINT = 'inventory_reservation_create_effects_stale_binding_ck',
          MESSAGE = 'Inventory Reservation cannot establish against a corrected Catalog-to-Stock Binding';
      END IF;
    END LOOP;

    INSERT INTO "inventory"."obligations" (
      obligation_id,
      tenant_id,
      origin_kind,
      lifecycle_meaning,
      attempt_id,
      accepted_order_id,
      order_evidence_ref,
      order_evidence_observed_at,
      source_system,
      source_order_id,
      source_obligation_id,
      customer_configuration_id,
      owner_configuration_id,
      authority_backend_kind,
      authority_backend_id,
      authority_exact_reservation_capability,
      authority_stock_correction_capability,
      authority_selected_at,
      authority_revision,
      established_at
    ) VALUES (
      (p_terminal #>> '{reservation,ref,resourceId}')::uuid,
      p_tenant_id,
      'ORDER_COMMITMENT_ATTEMPT',
      'PROVISIONAL_RESERVATION',
      current_effect.attempt_id,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      current_effect.customer_configuration_id,
      current_effect.backend_configuration_id,
      current_effect.request_json #>> '{authority,selection,backend}',
      current_effect.backend_id,
      current_effect.request_json #>> '{authority,selection,exactReservationCapability}',
      current_effect.request_json #>> '{authority,selection,stockCorrectionCapability}',
      (current_effect.request_json #>> '{authority,selectedAt}')::timestamptz,
      (current_effect.request_json #>> '{authority,revision}')::integer,
      (p_terminal #>> '{reservation,establishedAt}')::timestamptz
    )
    ON CONFLICT DO NOTHING;

    SELECT obligation.*
    INTO stored_obligation
    FROM "inventory"."obligations" AS obligation
    WHERE obligation.obligation_id = current_effect.reservation_id
    FOR UPDATE;

    IF NOT FOUND
      OR stored_obligation.tenant_id IS DISTINCT FROM p_tenant_id
      OR stored_obligation.origin_kind IS DISTINCT FROM 'ORDER_COMMITMENT_ATTEMPT'
      OR stored_obligation.lifecycle_meaning IS DISTINCT FROM 'PROVISIONAL_RESERVATION'
      OR stored_obligation.attempt_id IS DISTINCT FROM current_effect.attempt_id
      OR stored_obligation.accepted_order_id IS NOT NULL
      OR stored_obligation.order_evidence_ref IS NOT NULL
      OR stored_obligation.order_evidence_observed_at IS NOT NULL
      OR stored_obligation.source_system IS NOT NULL
      OR stored_obligation.source_order_id IS NOT NULL
      OR stored_obligation.source_obligation_id IS NOT NULL
      OR stored_obligation.customer_configuration_id IS DISTINCT FROM current_effect.customer_configuration_id
      OR stored_obligation.owner_configuration_id IS DISTINCT FROM current_effect.backend_configuration_id
      OR stored_obligation.authority_backend_kind
        IS DISTINCT FROM current_effect.request_json #>> '{authority,selection,backend}'
      OR stored_obligation.authority_backend_id IS DISTINCT FROM current_effect.backend_id
      OR stored_obligation.authority_exact_reservation_capability
        IS DISTINCT FROM current_effect.request_json #>> '{authority,selection,exactReservationCapability}'
      OR stored_obligation.authority_stock_correction_capability
        IS DISTINCT FROM current_effect.request_json #>> '{authority,selection,stockCorrectionCapability}'
      OR stored_obligation.authority_selected_at
        IS DISTINCT FROM (current_effect.request_json #>> '{authority,selectedAt}')::timestamptz
      OR stored_obligation.authority_revision
        IS DISTINCT FROM (current_effect.request_json #>> '{authority,revision}')::integer
      OR stored_obligation.established_at
        IS DISTINCT FROM (p_terminal #>> '{reservation,establishedAt}')::timestamptz
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_reservation_create_effects_obligation_conflict_ck',
        MESSAGE = 'Inventory Reservation identity is already bound to different obligation evidence';
    END IF;

    FOR requirement IN
      SELECT entry
      FROM pg_catalog.jsonb_array_elements(p_terminal #> '{reservation,requirements}') AS required(entry)
    LOOP
      INSERT INTO "inventory"."obligation_requirements" (
        tenant_id,
        obligation_id,
        purchase_demand_occurrence_id,
        binding_id,
        catalog_selection,
        exact_selection_meaning_id,
        exact_selection_meaning_kind,
        stock_item_id,
        stock_item_revision,
        stock_item_snapshot,
        requested_amount,
        unit_module_id,
        unit_resource_id,
        unit_resource_type,
        unit_tenant_id
      ) VALUES (
        p_tenant_id,
        current_effect.reservation_id,
        requirement ->> 'purchaseDemandOccurrenceId',
        (requirement #>> '{bindingRef,resourceId}')::uuid,
        requirement -> 'catalogSelection',
        requirement #>> '{exactSelectionMeaning,id}',
        requirement #>> '{exactSelectionMeaning,kind}',
        (requirement #>> '{stockItem,stockItemRef,resourceId}')::uuid,
        (requirement #>> '{stockItem,revision}')::integer,
        requirement -> 'stockItem',
        (requirement ->> 'quantity')::numeric,
        requirement #>> '{unitRef,moduleId}',
        (requirement #>> '{unitRef,resourceId}')::uuid,
        requirement #>> '{unitRef,resourceType}',
        (requirement #>> '{unitRef,tenantId}')::uuid
      )
      ON CONFLICT DO NOTHING;

      IF NOT EXISTS (
        SELECT 1
        FROM "inventory"."obligation_requirements" AS stored_requirement
        WHERE stored_requirement.tenant_id = p_tenant_id
          AND stored_requirement.obligation_id = current_effect.reservation_id
          AND stored_requirement.purchase_demand_occurrence_id = requirement ->> 'purchaseDemandOccurrenceId'
          AND stored_requirement.binding_id = (requirement #>> '{bindingRef,resourceId}')::uuid
          AND stored_requirement.catalog_selection = requirement -> 'catalogSelection'
          AND stored_requirement.exact_selection_meaning_id = requirement #>> '{exactSelectionMeaning,id}'
          AND stored_requirement.exact_selection_meaning_kind = requirement #>> '{exactSelectionMeaning,kind}'
          AND stored_requirement.stock_item_id = (requirement #>> '{stockItem,stockItemRef,resourceId}')::uuid
          AND stored_requirement.stock_item_revision = (requirement #>> '{stockItem,revision}')::integer
          AND stored_requirement.stock_item_snapshot = requirement -> 'stockItem'
          AND stored_requirement.requested_amount = (requirement ->> 'quantity')::numeric
          AND stored_requirement.unit_module_id = requirement #>> '{unitRef,moduleId}'
          AND stored_requirement.unit_resource_id = (requirement #>> '{unitRef,resourceId}')::uuid
          AND stored_requirement.unit_resource_type = requirement #>> '{unitRef,resourceType}'
          AND stored_requirement.unit_tenant_id = (requirement #>> '{unitRef,tenantId}')::uuid
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          CONSTRAINT = 'inventory_reservation_create_effects_obligation_conflict_ck',
          MESSAGE = 'Inventory Reservation requirement identity is already bound to different evidence';
      END IF;

      FOR allocation IN
        SELECT entry
        FROM pg_catalog.jsonb_array_elements(requirement -> 'allocations') AS allocated(entry)
      LOOP
        expected_allocation_count := expected_allocation_count + 1;
        INSERT INTO "inventory"."obligation_allocations" (
          tenant_id,
          obligation_id,
          allocation_id,
          purchase_demand_occurrence_id,
          stock_item_id,
          stock_position_id,
          allocated_amount,
          unit_module_id,
          unit_resource_id,
          unit_resource_type,
          unit_tenant_id
        ) VALUES (
          p_tenant_id,
          current_effect.reservation_id,
          allocation ->> 'allocationId',
          requirement ->> 'purchaseDemandOccurrenceId',
          (allocation #>> '{stockItemRef,resourceId}')::uuid,
          (allocation #>> '{positionRef,resourceId}')::uuid,
          (allocation #>> '{quantity,amount}')::numeric,
          allocation #>> '{quantity,unitRef,moduleId}',
          (allocation #>> '{quantity,unitRef,resourceId}')::uuid,
          allocation #>> '{quantity,unitRef,resourceType}',
          (allocation #>> '{quantity,unitRef,tenantId}')::uuid
        )
        ON CONFLICT DO NOTHING;

        IF NOT EXISTS (
          SELECT 1
          FROM "inventory"."obligation_allocations" AS stored_allocation
          WHERE stored_allocation.tenant_id = p_tenant_id
            AND stored_allocation.obligation_id = current_effect.reservation_id
            AND stored_allocation.allocation_id = allocation ->> 'allocationId'
            AND stored_allocation.purchase_demand_occurrence_id = requirement ->> 'purchaseDemandOccurrenceId'
            AND stored_allocation.stock_item_id = (allocation #>> '{stockItemRef,resourceId}')::uuid
            AND stored_allocation.stock_position_id = (allocation #>> '{positionRef,resourceId}')::uuid
            AND stored_allocation.allocated_amount = (allocation #>> '{quantity,amount}')::numeric
            AND stored_allocation.unit_module_id = allocation #>> '{quantity,unitRef,moduleId}'
            AND stored_allocation.unit_resource_id = (allocation #>> '{quantity,unitRef,resourceId}')::uuid
            AND stored_allocation.unit_resource_type = allocation #>> '{quantity,unitRef,resourceType}'
            AND stored_allocation.unit_tenant_id = (allocation #>> '{quantity,unitRef,tenantId}')::uuid
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'inventory_reservation_create_effects_obligation_conflict_ck',
            MESSAGE = 'Inventory Reservation allocation identity is already bound to different evidence';
        END IF;
      END LOOP;
    END LOOP;

    SELECT pg_catalog.count(*)::integer
    INTO stored_count
    FROM "inventory"."obligation_requirements" AS stored_requirement
    WHERE stored_requirement.tenant_id = p_tenant_id
      AND stored_requirement.obligation_id = current_effect.reservation_id;
    IF stored_count IS DISTINCT FROM pg_catalog.jsonb_array_length(p_terminal #> '{reservation,requirements}') THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_reservation_create_effects_obligation_conflict_ck',
        MESSAGE = 'Inventory Reservation requirement set must exactly match terminal evidence';
    END IF;

    SELECT pg_catalog.count(*)::integer
    INTO stored_count
    FROM "inventory"."obligation_allocations" AS stored_allocation
    WHERE stored_allocation.tenant_id = p_tenant_id
      AND stored_allocation.obligation_id = current_effect.reservation_id;
    IF stored_count IS DISTINCT FROM expected_allocation_count THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_reservation_create_effects_obligation_conflict_ck',
        MESSAGE = 'Inventory Reservation allocation set must exactly match terminal evidence';
    END IF;
  END IF;

  UPDATE "inventory"."reservation_create_effects" AS effect
  SET state = terminal_tag,
    record_json = p_terminal,
    updated_at = pg_catalog.clock_timestamp()
  WHERE effect.tenant_id = p_tenant_id
    AND effect.legal_entity_id = p_legal_entity_id
    AND effect.effect_id = p_effect_id;

  RETURN QUERY SELECT p_terminal;
END;
$$;
