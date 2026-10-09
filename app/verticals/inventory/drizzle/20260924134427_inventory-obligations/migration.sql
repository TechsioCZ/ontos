CREATE TABLE "inventory"."obligation_allocations" (
	"tenant_id" uuid NOT NULL,
	"obligation_id" uuid NOT NULL,
	"allocation_id" text NOT NULL,
	"purchase_demand_occurrence_id" text NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"stock_position_id" uuid NOT NULL,
	"allocated_amount" numeric(38,9) NOT NULL,
	"unit_module_id" text NOT NULL,
	"unit_resource_id" uuid NOT NULL,
	"unit_resource_type" text NOT NULL,
	"unit_tenant_id" uuid NOT NULL,
	CONSTRAINT "inventory_obligation_allocations_meaning_ck" CHECK (char_length(btrim("allocation_id")) between 1 and 300 and "allocated_amount" >= 0 and "unit_module_id" = 'commerce.catalog' and "unit_resource_type" = 'commerce.catalog.product-unit' and "unit_tenant_id" = "tenant_id")
);
--> statement-breakpoint
ALTER TABLE "inventory"."obligation_allocations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "inventory"."obligation_requirements" (
	"tenant_id" uuid NOT NULL,
	"obligation_id" uuid NOT NULL,
	"purchase_demand_occurrence_id" text NOT NULL,
	"binding_id" uuid NOT NULL,
	"catalog_selection" jsonb NOT NULL,
	"exact_selection_meaning_id" text NOT NULL,
	"exact_selection_meaning_kind" text NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"stock_item_revision" integer NOT NULL,
	"stock_item_snapshot" jsonb NOT NULL,
	"requested_amount" numeric(38,9) NOT NULL,
	"unit_module_id" text NOT NULL,
	"unit_resource_id" uuid NOT NULL,
	"unit_resource_type" text NOT NULL,
	"unit_tenant_id" uuid NOT NULL,
	CONSTRAINT "inventory_obligation_requirements_meaning_ck" CHECK (char_length(btrim("purchase_demand_occurrence_id")) between 1 and 300 and char_length(btrim("exact_selection_meaning_id")) between 1 and 300 and "exact_selection_meaning_kind" in ('PRODUCT_VARIANT', 'PACKAGE_OPTION', 'SET_VARIANT', 'CONFIGURED_SELECTION') and "stock_item_revision" >= 1 and "requested_amount" >= 0 and "unit_module_id" = 'commerce.catalog' and "unit_resource_type" = 'commerce.catalog.product-unit' and "unit_tenant_id" = "tenant_id")
);
--> statement-breakpoint
ALTER TABLE "inventory"."obligation_requirements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "inventory"."obligations" (
	"obligation_id" uuid PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"origin_kind" text NOT NULL,
	"lifecycle_meaning" text NOT NULL,
	"attempt_id" text,
	"accepted_order_id" text,
	"order_evidence_ref" text,
	"order_evidence_observed_at" timestamp with time zone,
	"source_system" text,
	"source_order_id" text,
	"source_obligation_id" text,
	"customer_configuration_id" text NOT NULL,
	"owner_configuration_id" uuid NOT NULL,
	"authority_backend_kind" text NOT NULL,
	"authority_backend_id" text NOT NULL,
	"authority_selected_at" timestamp with time zone NOT NULL,
	"authority_revision" integer DEFAULT 1 NOT NULL,
	"established_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_obligations_origin_ck" CHECK (("origin_kind" = 'ORDER_COMMITMENT_ATTEMPT' and "attempt_id" is not null and "source_system" is null and "source_order_id" is null and "source_obligation_id" is null) or ("origin_kind" = 'IMPORTED_PROVEN_ORDER' and "attempt_id" is null and "source_system" is not null and "source_order_id" is not null and "source_obligation_id" is not null)),
	CONSTRAINT "inventory_obligations_lifecycle_ck" CHECK (("origin_kind" = 'ORDER_COMMITMENT_ATTEMPT' and (("lifecycle_meaning" = 'PROVISIONAL_RESERVATION' and "accepted_order_id" is null and "order_evidence_ref" is null and "order_evidence_observed_at" is null) or ("lifecycle_meaning" = 'COMMITTED_OBLIGATION' and "accepted_order_id" is not null and "order_evidence_ref" is not null and "order_evidence_observed_at" is not null))) or ("origin_kind" = 'IMPORTED_PROVEN_ORDER' and "lifecycle_meaning" = 'COMMITTED_OBLIGATION' and "accepted_order_id" is not null and "order_evidence_ref" is not null and "order_evidence_observed_at" is not null)),
	CONSTRAINT "inventory_obligations_identity_text_ck" CHECK (char_length(btrim("customer_configuration_id")) between 1 and 300 and char_length(btrim("authority_backend_id")) between 1 and 300 and ("attempt_id" is null or char_length(btrim("attempt_id")) between 1 and 300) and ("accepted_order_id" is null or char_length(btrim("accepted_order_id")) between 1 and 300) and ("order_evidence_ref" is null or char_length(btrim("order_evidence_ref")) between 1 and 300) and ("source_system" is null or char_length(btrim("source_system")) between 1 and 300) and ("source_order_id" is null or char_length(btrim("source_order_id")) between 1 and 300) and ("source_obligation_id" is null or char_length(btrim("source_obligation_id")) between 1 and 300)),
	CONSTRAINT "inventory_obligations_authority_ck" CHECK ("authority_backend_kind" in ('external_business_system', 'ontos_wms') and "authority_revision" = 1)
);
--> statement-breakpoint
ALTER TABLE "inventory"."obligations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_obligation_allocations_identity_uk" ON "inventory"."obligation_allocations" ("tenant_id","obligation_id","allocation_id");--> statement-breakpoint
CREATE INDEX "inventory_obligation_allocations_position_idx" ON "inventory"."obligation_allocations" ("tenant_id","stock_position_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_obligation_requirements_occurrence_uk" ON "inventory"."obligation_requirements" ("tenant_id","obligation_id","purchase_demand_occurrence_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_obligations_scope_id_uk" ON "inventory"."obligations" ("tenant_id","obligation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_obligations_attempt_uk" ON "inventory"."obligations" ("tenant_id","attempt_id") WHERE "origin_kind" = 'ORDER_COMMITMENT_ATTEMPT';--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_obligations_imported_lineage_uk" ON "inventory"."obligations" ("tenant_id","source_system","source_order_id","source_obligation_id") WHERE "origin_kind" = 'IMPORTED_PROVEN_ORDER';--> statement-breakpoint
ALTER TABLE "inventory"."obligation_allocations" ADD CONSTRAINT "inventory_obligation_allocations_requirement_fk" FOREIGN KEY ("tenant_id","obligation_id","purchase_demand_occurrence_id") REFERENCES "inventory"."obligation_requirements"("tenant_id","obligation_id","purchase_demand_occurrence_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."obligation_allocations" ADD CONSTRAINT "inventory_obligation_allocations_position_fk" FOREIGN KEY ("tenant_id","stock_position_id") REFERENCES "inventory"."stock_positions"("tenant_id","stock_position_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."obligation_allocations" ADD CONSTRAINT "inventory_obligation_allocations_item_fk" FOREIGN KEY ("tenant_id","stock_item_id") REFERENCES "inventory"."stock_items"("tenant_id","stock_item_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."obligation_requirements" ADD CONSTRAINT "inventory_obligation_requirements_obligation_fk" FOREIGN KEY ("tenant_id","obligation_id") REFERENCES "inventory"."obligations"("tenant_id","obligation_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."obligation_requirements" ADD CONSTRAINT "inventory_obligation_requirements_item_fk" FOREIGN KEY ("tenant_id","stock_item_id") REFERENCES "inventory"."stock_items"("tenant_id","stock_item_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."obligations" ADD CONSTRAINT "inventory_obligations_backend_configuration_fk" FOREIGN KEY ("tenant_id","owner_configuration_id") REFERENCES "inventory"."backend_configurations"("tenant_id","configuration_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "inventory_obligation_allocations_tenant_select" ON "inventory"."obligation_allocations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."obligation_allocations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_obligation_allocations_tenant_insert" ON "inventory"."obligation_allocations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."obligation_allocations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_obligation_allocations_tenant_update" ON "inventory"."obligation_allocations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."obligation_allocations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."obligation_allocations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_obligation_allocations_tenant_delete" ON "inventory"."obligation_allocations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."obligation_allocations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_obligation_requirements_tenant_select" ON "inventory"."obligation_requirements" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."obligation_requirements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_obligation_requirements_tenant_insert" ON "inventory"."obligation_requirements" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."obligation_requirements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_obligation_requirements_tenant_update" ON "inventory"."obligation_requirements" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."obligation_requirements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."obligation_requirements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_obligation_requirements_tenant_delete" ON "inventory"."obligation_requirements" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."obligation_requirements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_obligations_tenant_select" ON "inventory"."obligations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."obligations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_obligations_tenant_insert" ON "inventory"."obligations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."obligations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_obligations_tenant_update" ON "inventory"."obligations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."obligations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."obligations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_obligations_tenant_delete" ON "inventory"."obligations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."obligations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "inventory"."obligation_allocations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inventory"."obligation_requirements" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inventory"."obligations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION "inventory"."enforce_obligation_authority"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW.obligation_id IS NOT DISTINCT FROM OLD.obligation_id
    AND NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id
    AND NEW.origin_kind IS NOT DISTINCT FROM OLD.origin_kind
    AND NEW.attempt_id IS NOT DISTINCT FROM OLD.attempt_id
    AND NEW.source_system IS NOT DISTINCT FROM OLD.source_system
    AND NEW.source_order_id IS NOT DISTINCT FROM OLD.source_order_id
    AND NEW.source_obligation_id IS NOT DISTINCT FROM OLD.source_obligation_id
    AND NEW.customer_configuration_id IS NOT DISTINCT FROM OLD.customer_configuration_id
    AND NEW.owner_configuration_id IS NOT DISTINCT FROM OLD.owner_configuration_id
    AND NEW.authority_backend_kind IS NOT DISTINCT FROM OLD.authority_backend_kind
    AND NEW.authority_backend_id IS NOT DISTINCT FROM OLD.authority_backend_id
    AND NEW.authority_selected_at IS NOT DISTINCT FROM OLD.authority_selected_at
    AND NEW.authority_revision IS NOT DISTINCT FROM OLD.authority_revision
    AND NEW.established_at IS NOT DISTINCT FROM OLD.established_at
  THEN
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM "inventory"."backend_configurations" AS configuration
  WHERE configuration.tenant_id = NEW.tenant_id
    AND configuration.configuration_id = NEW.owner_configuration_id
    AND configuration.customer_configuration_id = NEW.customer_configuration_id
    AND configuration.backend_kind = NEW.authority_backend_kind
    AND configuration.backend_id = NEW.authority_backend_id
    AND configuration.selected_at = NEW.authority_selected_at
    AND configuration.revision = NEW.authority_revision
    AND configuration.exact_reservation_capability = 'SUPPORTED'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_obligations_exact_authority_ck',
      MESSAGE = 'Inventory Obligation must retain the exact selected backend configuration snapshot';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_obligations_exact_authority_trg"
BEFORE INSERT OR UPDATE ON "inventory"."obligations"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_obligation_authority"();
--> statement-breakpoint
CREATE FUNCTION "inventory"."enforce_obligation_requirement_scope"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
BEGIN
  IF pg_catalog.jsonb_typeof(NEW.catalog_selection) IS DISTINCT FROM 'object'
    OR NEW.catalog_selection #>> '{productRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
    OR NEW.catalog_selection #>> '{variantRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_path_query(NEW.catalog_selection, 'strict $.**.tenantId') AS selected(tenant_id)
      WHERE selected.tenant_id #>> '{}' IS DISTINCT FROM NEW.tenant_id::text
    )
    OR pg_catalog.jsonb_typeof(NEW.stock_item_snapshot) IS DISTINCT FROM 'object'
    OR pg_catalog.jsonb_typeof(NEW.stock_item_snapshot -> 'exactSelectionMeaning') IS DISTINCT FROM 'object'
    OR pg_catalog.jsonb_typeof(NEW.stock_item_snapshot -> 'stockItemRef') IS DISTINCT FROM 'object'
    OR pg_catalog.jsonb_typeof(NEW.stock_item_snapshot -> 'unitRef') IS DISTINCT FROM 'object'
    OR pg_catalog.jsonb_typeof(NEW.stock_item_snapshot -> 'createdAt') IS DISTINCT FROM 'string'
    OR pg_catalog.jsonb_typeof(NEW.stock_item_snapshot -> 'revision') IS DISTINCT FROM 'number'
    OR NOT pg_catalog.pg_input_is_valid(NEW.stock_item_snapshot ->> 'createdAt', 'timestamp with time zone')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_obligation_requirements_exact_item_unit_ck',
      MESSAGE = 'Inventory Obligation Requirement must retain exact typed selection and Stock Item provenance';
  END IF;

  IF (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.stock_item_snapshot)) <> 7
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.stock_item_snapshot -> 'exactSelectionMeaning')) <> 2
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.stock_item_snapshot -> 'stockItemRef')) <> 4
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.stock_item_snapshot -> 'unitRef')) <> 4
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_obligation_requirements_exact_item_unit_ck',
      MESSAGE = 'Inventory Obligation Requirement Stock Item snapshot must have only canonical evidence fields';
  END IF;

  PERFORM 1
  FROM "inventory"."catalog_to_stock_bindings" AS binding
  JOIN "inventory"."stock_items" AS item
    ON item.tenant_id = NEW.tenant_id
    AND item.stock_item_id = NEW.stock_item_id
  WHERE binding.tenant_id = NEW.tenant_id
    AND binding.binding_id = NEW.binding_id
    AND binding.exact_selection_meaning_id = NEW.exact_selection_meaning_id
    AND binding.exact_selection_kind = NEW.exact_selection_meaning_kind
    AND binding.stock_item_id = NEW.stock_item_id
    AND binding.stock_unit_module_id = NEW.unit_module_id
    AND binding.stock_unit_resource_id = NEW.unit_resource_id
    AND binding.stock_unit_resource_type = NEW.unit_resource_type
    AND binding.stock_unit_tenant_id = NEW.unit_tenant_id
    AND item.exact_selection_meaning_id = NEW.exact_selection_meaning_id
    AND item.exact_selection_kind = NEW.exact_selection_meaning_kind
    AND item.stock_unit_module_id = NEW.unit_module_id
    AND item.stock_unit_resource_id = NEW.unit_resource_id
    AND item.stock_unit_resource_type = NEW.unit_resource_type
    AND item.stock_unit_tenant_id = NEW.unit_tenant_id
    AND item.revision = NEW.stock_item_revision
    AND item.lifecycle_state = 'CURRENT'
    AND NEW.stock_item_snapshot #>> '{exactSelectionMeaning,id}' = item.exact_selection_meaning_id
    AND NEW.stock_item_snapshot #>> '{exactSelectionMeaning,kind}' = item.exact_selection_kind
    AND NEW.stock_item_snapshot #>> '{stockItemRef,moduleId}' = 'commerce.inventory'
    AND NEW.stock_item_snapshot #>> '{stockItemRef,resourceType}' = 'commerce.inventory.stock-item'
    AND NEW.stock_item_snapshot #>> '{stockItemRef,tenantId}' = item.tenant_id::text
    AND NEW.stock_item_snapshot #>> '{stockItemRef,resourceId}' = item.stock_item_id::text
    AND NEW.stock_item_snapshot #>> '{unitRef,moduleId}' = item.stock_unit_module_id
    AND NEW.stock_item_snapshot #>> '{unitRef,resourceType}' = item.stock_unit_resource_type
    AND NEW.stock_item_snapshot #>> '{unitRef,tenantId}' = item.stock_unit_tenant_id::text
    AND NEW.stock_item_snapshot #>> '{unitRef,resourceId}' = item.stock_unit_resource_id::text
    AND NEW.stock_item_snapshot ->> 'revision' = item.revision::text
    AND NEW.stock_item_snapshot ->> 'lifecycle' = item.lifecycle_state
    AND NEW.stock_item_snapshot -> 'retiredAt' = 'null'::jsonb
    AND (NEW.stock_item_snapshot ->> 'createdAt')::timestamptz = item.created_at
  FOR UPDATE OF binding, item;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_obligation_requirements_exact_item_unit_ck',
      MESSAGE = 'Inventory Obligation Requirement must match the Current binding, immutable Item meaning, Unit, revision, and snapshot';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_obligation_requirements_exact_scope_trg"
BEFORE INSERT OR UPDATE ON "inventory"."obligation_requirements"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_obligation_requirement_scope"();
--> statement-breakpoint
CREATE FUNCTION "inventory"."enforce_obligation_allocation_scope"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
BEGIN
  PERFORM 1
  FROM "inventory"."obligation_requirements" AS requirement
  JOIN "inventory"."obligations" AS obligation
    ON obligation.tenant_id = requirement.tenant_id
    AND obligation.obligation_id = requirement.obligation_id
  JOIN "inventory"."stock_positions" AS position
    ON position.tenant_id = NEW.tenant_id
    AND position.stock_position_id = NEW.stock_position_id
  WHERE requirement.tenant_id = NEW.tenant_id
    AND requirement.obligation_id = NEW.obligation_id
    AND requirement.purchase_demand_occurrence_id = NEW.purchase_demand_occurrence_id
    AND requirement.stock_item_id = NEW.stock_item_id
    AND requirement.unit_module_id = NEW.unit_module_id
    AND requirement.unit_resource_id = NEW.unit_resource_id
    AND requirement.unit_resource_type = NEW.unit_resource_type
    AND requirement.unit_tenant_id = NEW.unit_tenant_id
    AND position.customer_configuration_id = obligation.customer_configuration_id
    AND position.owner_configuration_id = obligation.owner_configuration_id
    AND position.stock_item_id = NEW.stock_item_id
    AND position.lifecycle_state = 'CURRENT'
    AND position.stock_unit_module_id = NEW.unit_module_id
    AND position.stock_unit_resource_id = NEW.unit_resource_id
    AND position.stock_unit_resource_type = NEW.unit_resource_type
    AND position.stock_unit_tenant_id = NEW.unit_tenant_id
  FOR UPDATE OF requirement, obligation, position;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_obligation_allocations_exact_scope_ck',
      MESSAGE = 'Inventory Obligation Allocation must match its Requirement and exact Position Item, Unit, and backend owner';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_obligation_allocations_exact_scope_trg"
BEFORE INSERT OR UPDATE ON "inventory"."obligation_allocations"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_obligation_allocation_scope"();
--> statement-breakpoint
CREATE FUNCTION "inventory"."enforce_obligation_requirement_coverage"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
DECLARE
  allocation_count bigint;
  allocated_total numeric(38, 9);
  required_amount numeric(38, 9);
BEGIN
  SELECT requirement.requested_amount, pg_catalog.count(allocation.allocation_id), coalesce(pg_catalog.sum(allocation.allocated_amount), 0)
  INTO required_amount, allocation_count, allocated_total
  FROM "inventory"."obligation_requirements" AS requirement
  LEFT JOIN "inventory"."obligation_allocations" AS allocation
    ON allocation.tenant_id = requirement.tenant_id
    AND allocation.obligation_id = requirement.obligation_id
    AND allocation.purchase_demand_occurrence_id = requirement.purchase_demand_occurrence_id
  WHERE requirement.tenant_id = NEW.tenant_id
    AND requirement.obligation_id = NEW.obligation_id
    AND requirement.purchase_demand_occurrence_id = NEW.purchase_demand_occurrence_id
  GROUP BY requirement.requested_amount;

  IF NOT FOUND OR allocation_count < 1 OR allocated_total IS DISTINCT FROM required_amount THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_obligations_exact_requirement_coverage_ck',
      MESSAGE = 'Inventory Obligation allocations must cover every Requirement with the exact requested amount';
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "inventory_obligation_requirements_exact_coverage_trg"
AFTER INSERT ON "inventory"."obligation_requirements"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_obligation_requirement_coverage"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "inventory_obligation_allocations_exact_coverage_trg"
AFTER INSERT ON "inventory"."obligation_allocations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_obligation_requirement_coverage"();
--> statement-breakpoint
CREATE FUNCTION "inventory"."reject_obligation_origin_mutation"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR NEW.obligation_id IS DISTINCT FROM OLD.obligation_id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.origin_kind IS DISTINCT FROM OLD.origin_kind
    OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
    OR NEW.source_system IS DISTINCT FROM OLD.source_system
    OR NEW.source_order_id IS DISTINCT FROM OLD.source_order_id
    OR NEW.source_obligation_id IS DISTINCT FROM OLD.source_obligation_id
    OR NEW.customer_configuration_id IS DISTINCT FROM OLD.customer_configuration_id
    OR NEW.owner_configuration_id IS DISTINCT FROM OLD.owner_configuration_id
    OR NEW.authority_backend_kind IS DISTINCT FROM OLD.authority_backend_kind
    OR NEW.authority_backend_id IS DISTINCT FROM OLD.authority_backend_id
    OR NEW.authority_selected_at IS DISTINCT FROM OLD.authority_selected_at
    OR NEW.authority_revision IS DISTINCT FROM OLD.authority_revision
    OR NEW.established_at IS DISTINCT FROM OLD.established_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (
      OLD.origin_kind = 'IMPORTED_PROVEN_ORDER'
      AND (
        NEW.lifecycle_meaning IS DISTINCT FROM OLD.lifecycle_meaning
        OR NEW.accepted_order_id IS DISTINCT FROM OLD.accepted_order_id
        OR NEW.order_evidence_ref IS DISTINCT FROM OLD.order_evidence_ref
        OR NEW.order_evidence_observed_at IS DISTINCT FROM OLD.order_evidence_observed_at
      )
    )
    OR (
      OLD.origin_kind = 'ORDER_COMMITMENT_ATTEMPT'
      AND (
        NEW.lifecycle_meaning IS DISTINCT FROM OLD.lifecycle_meaning
        OR NEW.accepted_order_id IS DISTINCT FROM OLD.accepted_order_id
        OR NEW.order_evidence_ref IS DISTINCT FROM OLD.order_evidence_ref
        OR NEW.order_evidence_observed_at IS DISTINCT FROM OLD.order_evidence_observed_at
      )
      AND NOT (
        OLD.lifecycle_meaning = 'PROVISIONAL_RESERVATION'
        AND OLD.accepted_order_id IS NULL
        AND OLD.order_evidence_ref IS NULL
        AND OLD.order_evidence_observed_at IS NULL
        AND NEW.lifecycle_meaning = 'COMMITTED_OBLIGATION'
        AND NEW.accepted_order_id IS NOT NULL
        AND NEW.order_evidence_ref IS NOT NULL
        AND NEW.order_evidence_observed_at IS NOT NULL
      )
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_obligations_immutable_origin_ck',
      MESSAGE = 'Inventory Obligation is immutable except for one runtime provisional-to-committed transition';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_obligations_immutable_origin_trg"
BEFORE UPDATE OR DELETE ON "inventory"."obligations"
FOR EACH ROW EXECUTE FUNCTION "inventory"."reject_obligation_origin_mutation"();
--> statement-breakpoint
CREATE FUNCTION "inventory"."reject_obligation_requirement_mutation"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'inventory_obligation_requirements_append_only_ck',
    MESSAGE = 'Inventory Obligation Requirements are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_obligation_requirements_append_only_trg"
BEFORE UPDATE OR DELETE ON "inventory"."obligation_requirements"
FOR EACH ROW EXECUTE FUNCTION "inventory"."reject_obligation_requirement_mutation"();
--> statement-breakpoint
CREATE FUNCTION "inventory"."reject_obligation_allocation_mutation"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'inventory_obligation_allocations_append_only_ck',
    MESSAGE = 'Inventory Obligation Allocations are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_obligation_allocations_append_only_trg"
BEFORE UPDATE OR DELETE ON "inventory"."obligation_allocations"
FOR EACH ROW EXECUTE FUNCTION "inventory"."reject_obligation_allocation_mutation"();
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_obligation_authority"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_obligation_requirement_scope"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_obligation_allocation_scope"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_obligation_requirement_coverage"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."reject_obligation_origin_mutation"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."reject_obligation_requirement_mutation"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."reject_obligation_allocation_mutation"() FROM PUBLIC, "ontos_runtime";
