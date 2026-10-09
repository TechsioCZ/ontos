CREATE TABLE "inventory"."reservation_create_effects" (
	"effect_id" text,
	"tenant_id" uuid,
	"legal_entity_id" uuid NOT NULL,
	"mutation_id" uuid NOT NULL,
	"attempt_id" text NOT NULL,
	"reservation_id" uuid NOT NULL,
	"customer_configuration_id" text NOT NULL,
	"backend_configuration_id" uuid NOT NULL,
	"backend_id" text NOT NULL,
	"state" text DEFAULT 'REQUESTED' NOT NULL,
	"request_json" jsonb NOT NULL,
	"record_json" jsonb NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"source_action_invocation_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_reservation_create_effects_pkey" PRIMARY KEY("tenant_id","effect_id"),
	CONSTRAINT "inventory_reservation_create_effects_identity_ck" CHECK (char_length(btrim("effect_id")) between 1 and 300 and char_length(btrim("attempt_id")) between 1 and 300 and char_length(btrim("customer_configuration_id")) between 1 and 300 and char_length(btrim("backend_id")) between 1 and 300),
	CONSTRAINT "inventory_reservation_create_effects_state_ck" CHECK ("state" in ('REQUESTED', 'ESTABLISHED', 'RECONCILIATION_REQUIRED', 'INDETERMINATE', 'RESOLVED_NO_RESERVATION'))
);
--> statement-breakpoint
ALTER TABLE "inventory"."reservation_create_effects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_reservation_create_effects_attempt_uk" ON "inventory"."reservation_create_effects" ("tenant_id","attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_reservation_create_effects_mutation_uk" ON "inventory"."reservation_create_effects" ("tenant_id","mutation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_reservation_create_effects_reservation_uk" ON "inventory"."reservation_create_effects" ("tenant_id","reservation_id");--> statement-breakpoint
CREATE INDEX "inventory_reservation_create_effects_state_idx" ON "inventory"."reservation_create_effects" ("tenant_id","state","updated_at");--> statement-breakpoint
ALTER TABLE "inventory"."reservation_create_effects" ADD CONSTRAINT "inventory_reservation_create_effects_backend_configuration_fk" FOREIGN KEY ("tenant_id","backend_configuration_id") REFERENCES "inventory"."backend_configurations"("tenant_id","configuration_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "inventory_reservation_create_effects_tenant_select" ON "inventory"."reservation_create_effects" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."reservation_create_effects"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_reservation_create_effects_tenant_insert" ON "inventory"."reservation_create_effects" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."reservation_create_effects"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_reservation_create_effects_tenant_update" ON "inventory"."reservation_create_effects" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."reservation_create_effects"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."reservation_create_effects"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_reservation_create_effects_tenant_delete" ON "inventory"."reservation_create_effects" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."reservation_create_effects"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "inventory"."reservation_create_effects" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION "inventory"."enforce_reservation_create_effect_transition"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_reservation_create_effects_transition_ck',
      MESSAGE = 'Inventory Reservation create-effect evidence cannot be deleted';
  END IF;

  IF pg_catalog.jsonb_typeof(NEW.request_json) IS DISTINCT FROM 'object'
    OR pg_catalog.jsonb_typeof(NEW.record_json) IS DISTINCT FROM 'object'
    OR NEW.record_json -> 'request' IS DISTINCT FROM NEW.request_json
    OR NEW.record_json ->> '_tag' IS DISTINCT FROM NEW.state
    OR NEW.request_json ->> 'effectId' IS DISTINCT FROM NEW.effect_id
    OR NEW.request_json ->> 'legalEntityId' IS DISTINCT FROM NEW.legal_entity_id::text
    OR NEW.request_json ->> 'mutationId' IS DISTINCT FROM NEW.mutation_id::text
    OR NEW.request_json ->> 'sourceActionInvocationId' IS DISTINCT FROM NEW.source_action_invocation_id::text
    OR (NEW.request_json ->> 'requestedAt')::timestamptz IS DISTINCT FROM NEW.requested_at
    OR NEW.request_json #>> '{authority,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
    OR NEW.request_json #>> '{authority,configurationId}' IS DISTINCT FROM NEW.backend_configuration_id::text
    OR NEW.request_json #>> '{authority,customerConfigurationId}' IS DISTINCT FROM NEW.customer_configuration_id
    OR NEW.request_json #>> '{authority,selection,backendId}' IS DISTINCT FROM NEW.backend_id
    OR NEW.request_json #>> '{reservation,origin,kind}' IS DISTINCT FROM 'ORDER_COMMITMENT_ATTEMPT'
    OR NEW.request_json #>> '{reservation,origin,attemptId}' IS DISTINCT FROM NEW.attempt_id
    OR NEW.request_json #>> '{reservation,ref,moduleId}' IS DISTINCT FROM 'commerce.inventory'
    OR NEW.request_json #>> '{reservation,ref,resourceType}' IS DISTINCT FROM 'commerce.inventory.inventory-reservation'
    OR NEW.request_json #>> '{reservation,ref,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
    OR NEW.request_json #>> '{reservation,ref,resourceId}' IS DISTINCT FROM NEW.reservation_id::text
    OR NOT EXISTS (
      SELECT 1
      FROM "inventory"."backend_configurations" AS authority
      WHERE authority.tenant_id = NEW.tenant_id
        AND authority.configuration_id = NEW.backend_configuration_id
        AND authority.customer_configuration_id = NEW.customer_configuration_id
        AND authority.backend_id = NEW.backend_id
        AND NEW.request_json #>> '{authority,selection,backend}' = authority.backend_kind
        AND NEW.request_json #>> '{authority,selection,exactReservationCapability}'
          = authority.exact_reservation_capability
        AND NEW.request_json #>> '{authority,selection,stockCorrectionCapability}'
          = authority.stock_correction_capability
        AND (NEW.request_json #>> '{authority,selectedAt}')::timestamptz = authority.selected_at
        AND (NEW.request_json #>> '{authority,revision}')::integer = authority.revision
    )
    OR (
      NEW.state = 'ESTABLISHED'
      AND (
        (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.record_json)) <> 4
        OR coalesce(pg_catalog.length(pg_catalog.btrim(NEW.record_json ->> 'ownerEvidenceRef')), 0)
          NOT BETWEEN 1 AND 300
        OR pg_catalog.jsonb_typeof(NEW.record_json -> 'reservation') IS DISTINCT FROM 'object'
        OR NEW.record_json #> '{reservation,authority}' IS DISTINCT FROM NEW.request_json -> 'authority'
        OR NEW.record_json #> '{reservation,origin}' IS DISTINCT FROM NEW.request_json #> '{reservation,origin}'
        OR NEW.record_json #> '{reservation,ref}' IS DISTINCT FROM NEW.request_json #> '{reservation,ref}'
        OR NEW.record_json #> '{reservation,requirements}'
          IS DISTINCT FROM NEW.request_json #> '{reservation,requirements}'
        OR NEW.record_json #>> '{reservation,lifecycleMeaning}' IS DISTINCT FROM 'PROVISIONAL_RESERVATION'
        OR (NEW.record_json #>> '{reservation,establishedAt}')::timestamptz IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM "inventory"."obligations" AS obligation
          WHERE obligation.obligation_id = NEW.reservation_id
            AND obligation.tenant_id = NEW.tenant_id
            AND obligation.origin_kind = 'ORDER_COMMITMENT_ATTEMPT'
            AND obligation.lifecycle_meaning = 'PROVISIONAL_RESERVATION'
            AND obligation.attempt_id = NEW.attempt_id
            AND obligation.accepted_order_id IS NULL
            AND obligation.order_evidence_ref IS NULL
            AND obligation.order_evidence_observed_at IS NULL
            AND obligation.source_system IS NULL
            AND obligation.source_order_id IS NULL
            AND obligation.source_obligation_id IS NULL
            AND obligation.customer_configuration_id = NEW.customer_configuration_id
            AND obligation.owner_configuration_id = NEW.backend_configuration_id
            AND obligation.authority_backend_kind = NEW.request_json #>> '{authority,selection,backend}'
            AND obligation.authority_backend_id = NEW.backend_id
            AND obligation.authority_selected_at = (NEW.request_json #>> '{authority,selectedAt}')::timestamptz
            AND obligation.authority_revision = (NEW.request_json #>> '{authority,revision}')::integer
            AND obligation.established_at = (NEW.record_json #>> '{reservation,establishedAt}')::timestamptz
        )
        OR (
          SELECT pg_catalog.count(*)
          FROM "inventory"."obligation_requirements" AS stored_requirement
          WHERE stored_requirement.tenant_id = NEW.tenant_id
            AND stored_requirement.obligation_id = NEW.reservation_id
        ) IS DISTINCT FROM pg_catalog.jsonb_array_length(
          NEW.record_json #> '{reservation,requirements}'
        )
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_array_elements(
            NEW.record_json #> '{reservation,requirements}'
          ) AS expected_requirement(entry)
          WHERE NOT EXISTS (
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
            NEW.record_json #> '{reservation,requirements}'
          ) AS expected_requirement(entry)
          CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
            expected_requirement.entry -> 'allocations'
          ) AS expected_allocation(entry)
        )
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_array_elements(
            NEW.record_json #> '{reservation,requirements}'
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
      )
    )
    OR (
      NEW.state = 'RECONCILIATION_REQUIRED'
      AND (
        (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.record_json)) <> 5
        OR pg_catalog.jsonb_typeof(NEW.record_json -> 'constrainedAllocations') IS DISTINCT FROM 'array'
        OR (NEW.record_json ->> 'observedAt')::timestamptz IS NULL
        OR coalesce(pg_catalog.length(pg_catalog.btrim(NEW.record_json ->> 'ownerEvidenceRef')), 0)
          NOT BETWEEN 1 AND 300
        OR (
          SELECT pg_catalog.count(*)
          FROM pg_catalog.jsonb_array_elements(NEW.record_json -> 'constrainedAllocations') AS observed(entry)
        ) < 1
        OR (
          SELECT pg_catalog.count(*)
          FROM pg_catalog.jsonb_array_elements(NEW.record_json -> 'constrainedAllocations') AS observed(entry)
        ) IS DISTINCT FROM (
          SELECT pg_catalog.count(DISTINCT observed.entry ->> 'allocationId')
          FROM pg_catalog.jsonb_array_elements(NEW.record_json -> 'constrainedAllocations') AS observed(entry)
        )
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_array_elements(NEW.record_json -> 'constrainedAllocations') AS observed(entry)
          WHERE NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(
              NEW.request_json #> '{reservation,requirements}'
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
      )
    )
    OR (
      NEW.state = 'INDETERMINATE'
      AND (
        (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.record_json)) <> 5
        OR pg_catalog.jsonb_typeof(NEW.record_json -> 'possibleConstrainedAllocations') IS DISTINCT FROM 'array'
        OR (NEW.record_json ->> 'observedAt')::timestamptz IS NULL
        OR NEW.record_json ->> 'reason' IS NULL
        OR NEW.record_json ->> 'reason' NOT IN (
          'DISPATCH_PENDING',
          'BACKEND_OUTCOME_UNKNOWN',
          'EVIDENCE_UNVERIFIABLE',
          'AUTHORITY_UNAVAILABLE'
        )
        OR (
          SELECT pg_catalog.count(*)
          FROM pg_catalog.jsonb_array_elements(
            NEW.record_json -> 'possibleConstrainedAllocations'
          ) AS possible(entry)
        ) IS DISTINCT FROM (
          SELECT pg_catalog.count(*)
          FROM pg_catalog.jsonb_array_elements(
            NEW.request_json #> '{reservation,requirements}'
          ) AS planned_requirement(entry)
          CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
            planned_requirement.entry -> 'allocations'
          ) AS planned_allocation(entry)
        )
        OR (
          SELECT pg_catalog.count(*)
          FROM pg_catalog.jsonb_array_elements(
            NEW.record_json -> 'possibleConstrainedAllocations'
          ) AS possible(entry)
        ) IS DISTINCT FROM (
          SELECT pg_catalog.count(DISTINCT possible.entry ->> 'allocationId')
          FROM pg_catalog.jsonb_array_elements(
            NEW.record_json -> 'possibleConstrainedAllocations'
          ) AS possible(entry)
        )
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_array_elements(
            NEW.record_json -> 'possibleConstrainedAllocations'
          ) AS possible(entry)
          WHERE NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(
              NEW.request_json #> '{reservation,requirements}'
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
      )
    )
    OR (
      NEW.state = 'RESOLVED_NO_RESERVATION'
      AND (
        (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.record_json)) <> 5
        OR NEW.record_json -> 'effectAbsenceProven' IS DISTINCT FROM 'true'::jsonb
        OR NEW.record_json ->> 'reason' IS NULL
        OR NEW.record_json ->> 'reason' NOT IN ('INSUFFICIENT_STOCK', 'BACKEND_REJECTED')
        OR (NEW.record_json ->> 'observedAt')::timestamptz IS NULL
      )
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_reservation_create_effects_transition_ck',
      MESSAGE = 'Inventory Reservation create-effect JSON must exactly match immutable relational request identity';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'REQUESTED'
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.record_json)) <> 2
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_reservation_create_effects_transition_ck',
        MESSAGE = 'Inventory Reservation create effects must begin in REQUESTED state';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.effect_id IS DISTINCT FROM OLD.effect_id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
    OR NEW.mutation_id IS DISTINCT FROM OLD.mutation_id
    OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
    OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id
    OR NEW.customer_configuration_id IS DISTINCT FROM OLD.customer_configuration_id
    OR NEW.backend_configuration_id IS DISTINCT FROM OLD.backend_configuration_id
    OR NEW.backend_id IS DISTINCT FROM OLD.backend_id
    OR NEW.request_json IS DISTINCT FROM OLD.request_json
    OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
    OR NEW.source_action_invocation_id IS DISTINCT FROM OLD.source_action_invocation_id
    OR (
      OLD.state = 'REQUESTED'
      AND NEW.state NOT IN (
        'ESTABLISHED',
        'RECONCILIATION_REQUIRED',
        'INDETERMINATE',
        'RESOLVED_NO_RESERVATION'
      )
    )
    OR (
      OLD.state IN ('RECONCILIATION_REQUIRED', 'INDETERMINATE')
      AND NEW.state NOT IN (
        'ESTABLISHED',
        'RECONCILIATION_REQUIRED',
        'INDETERMINATE',
        'RESOLVED_NO_RESERVATION'
      )
    )
    OR (
      OLD.state = 'ESTABLISHED'
      AND (
        NEW.state IS DISTINCT FROM 'ESTABLISHED'
        OR NEW.record_json IS DISTINCT FROM OLD.record_json
      )
    )
    OR (
      OLD.state = 'RESOLVED_NO_RESERVATION'
      AND (
        NEW.state IS DISTINCT FROM 'RESOLVED_NO_RESERVATION'
        OR NEW.record_json IS DISTINCT FROM OLD.record_json
      )
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_reservation_create_effects_transition_ck',
      MESSAGE = 'Inventory Reservation create-effect transition is invalid or mutates immutable request identity';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_reservation_create_effects_transition_trg"
BEFORE INSERT OR UPDATE OR DELETE ON "inventory"."reservation_create_effects"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_reservation_create_effect_transition"();
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_reservation_create_effect_transition"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
CREATE FUNCTION "inventory"."read_reservation_create_effect_for_worker"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_effect_id text
) RETURNS TABLE(record jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  durable_record jsonb;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Inventory Reservation create-effect worker scope mismatch';
  END IF;

  SELECT effect.record_json
  INTO durable_record
  FROM "inventory"."reservation_create_effects" AS effect
  WHERE effect.tenant_id = p_tenant_id
    AND effect.legal_entity_id = p_legal_entity_id
    AND effect.effect_id = p_effect_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT durable_record;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "inventory"."finalize_reservation_create_effect_for_worker"(
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
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."read_reservation_create_effect_for_worker"(uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."finalize_reservation_create_effect_for_worker"(uuid, uuid, text, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "inventory"."read_reservation_create_effect_for_worker"(uuid, uuid, text) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "inventory"."finalize_reservation_create_effect_for_worker"(uuid, uuid, text, jsonb) TO "ontos_runtime";
