CREATE TABLE "inventory"."physical_stock_effects" (
	"effect_id" uuid PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"customer_configuration_id" text NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"stock_location_id" uuid NOT NULL,
	"unit_resource_id" uuid NOT NULL,
	"quantity_amount" text NOT NULL,
	"backend_configuration_id" uuid NOT NULL,
	"backend_id" text NOT NULL,
	"state" text DEFAULT 'REQUESTED' NOT NULL,
	"request_json" jsonb NOT NULL,
	"evidence_json" jsonb,
	"terminal_reason" text,
	"requested_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_physical_stock_effects_kind_ck" CHECK ("kind" in ('RECEIPT', 'ISSUE')),
	CONSTRAINT "inventory_physical_stock_effects_state_ck" CHECK ("state" in ('REQUESTED', 'APPLIED', 'REJECTED', 'INDETERMINATE')),
	CONSTRAINT "inventory_physical_stock_effects_terminal_ck" CHECK (("state" = 'REQUESTED' and "evidence_json" is null and "terminal_reason" is null) or ("state" = 'APPLIED' and "evidence_json" is not null and "terminal_reason" is null) or ("state" in ('REJECTED', 'INDETERMINATE') and "evidence_json" is null and "terminal_reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "inventory"."physical_stock_effects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_physical_stock_effects_tenant_id_uk" ON "inventory"."physical_stock_effects" ("tenant_id","effect_id");--> statement-breakpoint
CREATE INDEX "inventory_physical_stock_effects_position_idx" ON "inventory"."physical_stock_effects" ("tenant_id","position_id","requested_at");--> statement-breakpoint
ALTER TABLE "inventory"."physical_stock_effects" ADD CONSTRAINT "inventory_physical_stock_effects_position_fk" FOREIGN KEY ("tenant_id","position_id") REFERENCES "inventory"."stock_positions"("tenant_id","stock_position_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."physical_stock_effects" ADD CONSTRAINT "inventory_physical_stock_effects_backend_configuration_fk" FOREIGN KEY ("tenant_id","backend_configuration_id") REFERENCES "inventory"."backend_configurations"("tenant_id","configuration_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "inventory_physical_stock_effects_tenant_select" ON "inventory"."physical_stock_effects" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."physical_stock_effects"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_physical_stock_effects_tenant_insert" ON "inventory"."physical_stock_effects" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."physical_stock_effects"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_physical_stock_effects_tenant_update" ON "inventory"."physical_stock_effects" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."physical_stock_effects"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."physical_stock_effects"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_physical_stock_effects_tenant_delete" ON "inventory"."physical_stock_effects" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."physical_stock_effects"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "inventory"."physical_stock_effects" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION "inventory"."enforce_physical_stock_effect_scope"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
BEGIN
  PERFORM 1
  FROM "inventory"."stock_positions" AS position
  WHERE position.tenant_id = NEW.tenant_id
    AND position.stock_position_id = NEW.position_id
    AND position.customer_configuration_id = NEW.customer_configuration_id
    AND position.stock_item_id = NEW.stock_item_id
    AND position.stock_location_id = NEW.stock_location_id
    AND position.stock_unit_resource_id = NEW.unit_resource_id
    AND position.owner_configuration_id = NEW.backend_configuration_id
    AND position.lifecycle_state = 'CURRENT'
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_physical_stock_effects_exact_scope_ck',
      MESSAGE = 'Physical Stock Effect requires its exact Current Stock Position scope';
  END IF;

  PERFORM 1
  FROM "inventory"."backend_configurations" AS backend
  WHERE backend.tenant_id = NEW.tenant_id
    AND backend.configuration_id = NEW.backend_configuration_id
    AND backend.customer_configuration_id = NEW.customer_configuration_id
    AND backend.backend_id = NEW.backend_id
    AND backend.backend_kind = NEW.request_json ->> 'backend'
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_physical_stock_effects_exact_scope_ck',
      MESSAGE = 'Physical Stock Effect requires its captured selected Inventory Backend';
  END IF;

  IF pg_catalog.jsonb_typeof(NEW.request_json) IS DISTINCT FROM 'object'
    OR NEW.request_json ->> 'effectId' IS DISTINCT FROM NEW.effect_id::text
    OR NEW.request_json ->> 'kind' IS DISTINCT FROM NEW.kind
    OR NEW.request_json ->> 'customerConfigurationId' IS DISTINCT FROM NEW.customer_configuration_id
    OR NEW.request_json ->> 'legalEntityId' IS DISTINCT FROM NEW.legal_entity_id::text
    OR NEW.request_json #>> '{positionRef,moduleId}' IS DISTINCT FROM 'commerce.inventory'
    OR NEW.request_json #>> '{positionRef,resourceType}' IS DISTINCT FROM 'commerce.inventory.stock-position'
    OR NEW.request_json #>> '{positionRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
    OR NEW.request_json #>> '{positionRef,resourceId}' IS DISTINCT FROM NEW.position_id::text
    OR NEW.request_json #>> '{stockItemRef,moduleId}' IS DISTINCT FROM 'commerce.inventory'
    OR NEW.request_json #>> '{stockItemRef,resourceType}' IS DISTINCT FROM 'commerce.inventory.stock-item'
    OR NEW.request_json #>> '{stockItemRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
    OR NEW.request_json #>> '{stockItemRef,resourceId}' IS DISTINCT FROM NEW.stock_item_id::text
    OR NEW.request_json #>> '{stockLocationRef,moduleId}' IS DISTINCT FROM 'commerce.inventory'
    OR NEW.request_json #>> '{stockLocationRef,resourceType}' IS DISTINCT FROM 'commerce.inventory.stock-location'
    OR NEW.request_json #>> '{stockLocationRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
    OR NEW.request_json #>> '{stockLocationRef,resourceId}' IS DISTINCT FROM NEW.stock_location_id::text
    OR NEW.request_json #>> '{quantity,unitRef,moduleId}' IS DISTINCT FROM 'commerce.catalog'
    OR NEW.request_json #>> '{quantity,unitRef,resourceType}' IS DISTINCT FROM 'commerce.catalog.product-unit'
    OR NEW.request_json #>> '{quantity,unitRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
    OR NEW.request_json #>> '{quantity,unitRef,resourceId}' IS DISTINCT FROM NEW.unit_resource_id::text
    OR NEW.request_json #>> '{quantity,amount}' IS DISTINCT FROM NEW.quantity_amount
    OR NEW.request_json #>> '{backendConfigurationRef,moduleId}' IS DISTINCT FROM 'commerce.inventory'
    OR NEW.request_json #>> '{backendConfigurationRef,resourceType}' IS DISTINCT FROM 'commerce.inventory.inventory-backend-configuration'
    OR NEW.request_json #>> '{backendConfigurationRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
    OR NEW.request_json #>> '{backendConfigurationRef,resourceId}' IS DISTINCT FROM NEW.backend_configuration_id::text
    OR NEW.request_json ->> 'backendId' IS DISTINCT FROM NEW.backend_id
    OR (NEW.request_json ->> 'requestedAt')::timestamptz IS DISTINCT FROM NEW.requested_at
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_physical_stock_effects_exact_scope_ck',
      MESSAGE = 'Physical Stock Effect request JSON must exactly match its captured owner scope';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_physical_stock_effects_exact_scope_trg"
BEFORE INSERT ON "inventory"."physical_stock_effects"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_physical_stock_effect_scope"();
--> statement-breakpoint
CREATE FUNCTION "inventory"."reject_physical_stock_effect_identity_mutation"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, inventory
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR NEW.effect_id IS DISTINCT FROM OLD.effect_id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.customer_configuration_id IS DISTINCT FROM OLD.customer_configuration_id
    OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
    OR NEW.position_id IS DISTINCT FROM OLD.position_id
    OR NEW.stock_item_id IS DISTINCT FROM OLD.stock_item_id
    OR NEW.stock_location_id IS DISTINCT FROM OLD.stock_location_id
    OR NEW.unit_resource_id IS DISTINCT FROM OLD.unit_resource_id
    OR NEW.quantity_amount IS DISTINCT FROM OLD.quantity_amount
    OR NEW.backend_configuration_id IS DISTINCT FROM OLD.backend_configuration_id
    OR NEW.backend_id IS DISTINCT FROM OLD.backend_id
    OR NEW.request_json IS DISTINCT FROM OLD.request_json
    OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_physical_stock_effects_immutable_identity_ck',
      MESSAGE = 'Physical Stock Effect identity and request evidence are immutable';
  END IF;

  IF OLD.state <> 'REQUESTED'
    AND (
      NEW.state IS DISTINCT FROM OLD.state
      OR NEW.evidence_json IS DISTINCT FROM OLD.evidence_json
      OR NEW.terminal_reason IS DISTINCT FROM OLD.terminal_reason
      OR NEW.updated_at IS DISTINCT FROM OLD.updated_at
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_physical_stock_effects_terminal_transition_ck',
      MESSAGE = 'Physical Stock Effect terminal outcomes are immutable';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_physical_stock_effects_immutable_identity_trg"
BEFORE UPDATE OR DELETE ON "inventory"."physical_stock_effects"
FOR EACH ROW EXECUTE FUNCTION "inventory"."reject_physical_stock_effect_identity_mutation"();
--> statement-breakpoint
CREATE FUNCTION "inventory"."read_physical_stock_effect_for_worker"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_effect_id uuid
) RETURNS TABLE(record jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE effect.state
    WHEN 'REQUESTED' THEN pg_catalog.jsonb_build_object('_tag', effect.state, 'request', effect.request_json)
    WHEN 'APPLIED' THEN pg_catalog.jsonb_build_object(
      '_tag', effect.state,
      'evidence', effect.evidence_json,
      'request', effect.request_json
    )
    ELSE pg_catalog.jsonb_build_object(
      '_tag', effect.state,
      'reason', effect.terminal_reason,
      'request', effect.request_json
    )
  END
  FROM "inventory"."physical_stock_effects" AS effect
  WHERE p_tenant_id = nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    AND p_legal_entity_id = nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
    AND effect.tenant_id = p_tenant_id
    AND effect.legal_entity_id = p_legal_entity_id
    AND effect.effect_id = p_effect_id;
$$;
--> statement-breakpoint
CREATE FUNCTION "inventory"."finalize_physical_stock_effect_for_worker"(
  p_tenant_id uuid,
  p_legal_entity_id uuid,
  p_effect_id uuid,
  p_terminal jsonb
) RETURNS TABLE(record jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  current_effect "inventory"."physical_stock_effects"%ROWTYPE;
  terminal_tag text;
  canonical_record jsonb;
BEGIN
  IF p_tenant_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
    OR p_legal_entity_id IS DISTINCT FROM nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Physical Stock Effect worker scope mismatch';
  END IF;

  SELECT effect.* INTO current_effect
  FROM "inventory"."physical_stock_effects" AS effect
  WHERE effect.tenant_id = p_tenant_id
    AND effect.legal_entity_id = p_legal_entity_id
    AND effect.effect_id = p_effect_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  terminal_tag := p_terminal ->> '_tag';
  IF pg_catalog.jsonb_typeof(p_terminal) IS DISTINCT FROM 'object'
    OR terminal_tag NOT IN ('APPLIED', 'REJECTED', 'INDETERMINATE')
    OR p_terminal -> 'request' IS DISTINCT FROM current_effect.request_json
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_terminal)) <> 3
    OR (
      terminal_tag = 'APPLIED'
      AND (
        pg_catalog.jsonb_typeof(p_terminal -> 'evidence') IS DISTINCT FROM 'object'
        OR p_terminal #>> '{evidence,effectId}' IS DISTINCT FROM current_effect.effect_id::text
        OR p_terminal #>> '{evidence,kind}' IS DISTINCT FROM current_effect.kind
        OR p_terminal #>> '{evidence,backend}' IS DISTINCT FROM current_effect.request_json ->> 'backend'
        OR p_terminal #>> '{evidence,backendId}' IS DISTINCT FROM current_effect.backend_id
        OR p_terminal #>> '{evidence,backendConfigurationRef,resourceId}' IS DISTINCT FROM current_effect.backend_configuration_id::text
        OR p_terminal #>> '{evidence,backendConfigurationRef,tenantId}' IS DISTINCT FROM current_effect.tenant_id::text
        OR p_terminal #>> '{evidence,positionRef,resourceId}' IS DISTINCT FROM current_effect.position_id::text
        OR p_terminal #>> '{evidence,positionRef,tenantId}' IS DISTINCT FROM current_effect.tenant_id::text
        OR p_terminal #>> '{evidence,quantity,amount}' IS DISTINCT FROM current_effect.quantity_amount
        OR p_terminal #>> '{evidence,quantity,unitRef,resourceId}' IS DISTINCT FROM current_effect.unit_resource_id::text
        OR p_terminal #>> '{evidence,quantity,unitRef,tenantId}' IS DISTINCT FROM current_effect.tenant_id::text
        OR coalesce(length(btrim(p_terminal #>> '{evidence,backendEvidenceRef}')), 0) NOT BETWEEN 1 AND 300
        OR coalesce(length(btrim(p_terminal #>> '{evidence,issuer}')), 0) NOT BETWEEN 1 AND 300
      )
    )
    OR (
      terminal_tag = 'REJECTED'
      AND (
        pg_catalog.jsonb_typeof(p_terminal -> 'reason') IS DISTINCT FROM 'string'
        OR p_terminal ->> 'reason' NOT IN ('INSUFFICIENT_ON_HAND', 'POSITION_REJECTED', 'BACKEND_REJECTED')
      )
    )
    OR (
      terminal_tag = 'INDETERMINATE'
      AND (
        pg_catalog.jsonb_typeof(p_terminal -> 'reason') IS DISTINCT FROM 'string'
        OR p_terminal ->> 'reason' NOT IN ('BACKEND_OUTCOME_UNKNOWN', 'EVIDENCE_UNVERIFIABLE')
      )
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inventory_physical_stock_effects_terminal_payload_ck',
      MESSAGE = 'Physical Stock Effect terminal payload must exactly match its durable request';
  END IF;

  canonical_record := CASE current_effect.state
    WHEN 'REQUESTED' THEN NULL
    WHEN 'APPLIED' THEN pg_catalog.jsonb_build_object(
      '_tag', current_effect.state,
      'evidence', current_effect.evidence_json,
      'request', current_effect.request_json
    )
    ELSE pg_catalog.jsonb_build_object(
      '_tag', current_effect.state,
      'reason', current_effect.terminal_reason,
      'request', current_effect.request_json
    )
  END;

  IF canonical_record IS NOT NULL THEN
    IF canonical_record IS DISTINCT FROM p_terminal THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_physical_stock_effects_terminal_transition_ck',
        MESSAGE = 'Physical Stock Effect terminal outcome cannot be replaced';
    END IF;
    RETURN QUERY SELECT canonical_record;
    RETURN;
  END IF;

  UPDATE "inventory"."physical_stock_effects" AS effect
  SET state = terminal_tag,
    evidence_json = CASE WHEN terminal_tag = 'APPLIED' THEN p_terminal -> 'evidence' ELSE NULL END,
    terminal_reason = CASE WHEN terminal_tag = 'APPLIED' THEN NULL ELSE p_terminal ->> 'reason' END,
    updated_at = pg_catalog.clock_timestamp()
  WHERE effect.tenant_id = p_tenant_id
    AND effect.legal_entity_id = p_legal_entity_id
    AND effect.effect_id = p_effect_id;

  RETURN QUERY SELECT p_terminal;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_physical_stock_effect_scope"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."reject_physical_stock_effect_identity_mutation"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."read_physical_stock_effect_for_worker"(uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."finalize_physical_stock_effect_for_worker"(uuid, uuid, uuid, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "inventory"."read_physical_stock_effect_for_worker"(uuid, uuid, uuid) TO "ontos_runtime";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "inventory"."finalize_physical_stock_effect_for_worker"(uuid, uuid, uuid, jsonb) TO "ontos_runtime";
