CREATE UNIQUE INDEX "inventory_obligations_runtime_accepted_order_uk" ON "inventory"."obligations" ("tenant_id","accepted_order_id") WHERE "origin_kind" = 'ORDER_COMMITMENT_ATTEMPT' and "lifecycle_meaning" = 'COMMITTED_OBLIGATION';
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
REVOKE ALL ON FUNCTION "inventory"."reject_obligation_origin_mutation"() FROM PUBLIC, "ontos_runtime";
