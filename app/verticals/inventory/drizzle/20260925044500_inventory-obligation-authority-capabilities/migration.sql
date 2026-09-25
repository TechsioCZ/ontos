ALTER TABLE "inventory"."obligations" ADD COLUMN "authority_exact_reservation_capability" text;
--> statement-breakpoint
ALTER TABLE "inventory"."obligations" ADD COLUMN "authority_stock_correction_capability" text;
--> statement-breakpoint
UPDATE "inventory"."obligations" AS obligation
SET
  "authority_exact_reservation_capability" = configuration."exact_reservation_capability",
  "authority_stock_correction_capability" = configuration."stock_correction_capability"
FROM "inventory"."backend_configurations" AS configuration
WHERE configuration."tenant_id" = obligation."tenant_id"
  AND configuration."configuration_id" = obligation."owner_configuration_id";
--> statement-breakpoint
ALTER TABLE "inventory"."obligations" ALTER COLUMN "authority_exact_reservation_capability" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "inventory"."obligations" ALTER COLUMN "authority_stock_correction_capability" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "inventory"."obligations" DROP CONSTRAINT "inventory_obligations_authority_ck";
--> statement-breakpoint
ALTER TABLE "inventory"."obligations" ADD CONSTRAINT "inventory_obligations_authority_ck" CHECK (
  "authority_backend_kind" in ('external_business_system', 'ontos_wms')
  and "authority_exact_reservation_capability" in ('SUPPORTED', 'UNSUPPORTED')
  and "authority_stock_correction_capability" in ('SUPPORTED', 'UNSUPPORTED')
  and (
    "authority_backend_kind" <> 'ontos_wms'
    or (
      "authority_exact_reservation_capability" = 'SUPPORTED'
      and "authority_stock_correction_capability" = 'SUPPORTED'
    )
  )
  and "authority_revision" = 1
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "inventory"."enforce_obligation_authority"() RETURNS trigger
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
    AND NEW.authority_exact_reservation_capability IS NOT DISTINCT FROM OLD.authority_exact_reservation_capability
    AND NEW.authority_stock_correction_capability IS NOT DISTINCT FROM OLD.authority_stock_correction_capability
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
    AND configuration.exact_reservation_capability = NEW.authority_exact_reservation_capability
    AND configuration.stock_correction_capability = NEW.authority_stock_correction_capability
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
CREATE OR REPLACE FUNCTION "inventory"."reject_obligation_origin_mutation"() RETURNS trigger
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
    OR NEW.authority_exact_reservation_capability IS DISTINCT FROM OLD.authority_exact_reservation_capability
    OR NEW.authority_stock_correction_capability IS DISTINCT FROM OLD.authority_stock_correction_capability
    OR NEW.authority_selected_at IS DISTINCT FROM OLD.authority_selected_at
    OR NEW.authority_revision IS DISTINCT FROM OLD.authority_revision
    OR NEW.established_at IS DISTINCT FROM OLD.established_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_obligations_immutable_origin_ck',
      MESSAGE = 'Inventory Obligation identity, origin, authority, and establishment evidence are immutable';
  END IF;

  IF OLD.origin_kind = 'IMPORTED_PROVEN_ORDER' THEN
    IF NEW.lifecycle_meaning IS DISTINCT FROM OLD.lifecycle_meaning
      OR NEW.accepted_order_id IS DISTINCT FROM OLD.accepted_order_id
      OR NEW.order_evidence_ref IS DISTINCT FROM OLD.order_evidence_ref
      OR NEW.order_evidence_observed_at IS DISTINCT FROM OLD.order_evidence_observed_at
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_obligations_immutable_origin_ck',
        MESSAGE = 'Imported committed Obligation and Order evidence are immutable';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.origin_kind <> 'ORDER_COMMITMENT_ATTEMPT' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_obligations_immutable_origin_ck',
      MESSAGE = 'Inventory Obligation origin is invalid';
  END IF;

  IF NEW.lifecycle_meaning IS NOT DISTINCT FROM OLD.lifecycle_meaning
    AND NEW.accepted_order_id IS NOT DISTINCT FROM OLD.accepted_order_id
    AND NEW.order_evidence_ref IS NOT DISTINCT FROM OLD.order_evidence_ref
    AND NEW.order_evidence_observed_at IS NOT DISTINCT FROM OLD.order_evidence_observed_at
  THEN
    RETURN NEW;
  END IF;

  IF OLD.lifecycle_meaning = 'PROVISIONAL_RESERVATION'
    AND OLD.accepted_order_id IS NULL
    AND OLD.order_evidence_ref IS NULL
    AND OLD.order_evidence_observed_at IS NULL
    AND NEW.lifecycle_meaning = 'COMMITTED_OBLIGATION'
    AND NEW.accepted_order_id IS NOT NULL
    AND NEW.order_evidence_ref IS NOT NULL
    AND NEW.order_evidence_observed_at IS NOT NULL
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'inventory_obligations_immutable_origin_ck',
    MESSAGE = 'Runtime Inventory Obligation permits only one provisional-to-committed Order binding';
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_obligation_authority"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."reject_obligation_origin_mutation"() FROM PUBLIC, "ontos_runtime";
