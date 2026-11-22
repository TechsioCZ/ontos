CREATE TABLE "inventory"."source_provisioning_policies" (
	"policy_id" uuid PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"customer_configuration_id" text NOT NULL,
	"owner_configuration_id" uuid NOT NULL,
	"issuer_backend_kind" text NOT NULL,
	"issuer_backend_id" text NOT NULL,
	"namespace" text NOT NULL,
	"external_scope" text NOT NULL,
	"unit_resource_id" uuid NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"defined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_source_provisioning_policies_text_ck" CHECK (length(btrim("customer_configuration_id")) between 1 and 300 and "issuer_backend_kind" = 'external_business_system' and length(btrim("issuer_backend_id")) between 1 and 300 and length(btrim("namespace")) between 1 and 300 and length(btrim("external_scope")) between 1 and 300)
);
--> statement-breakpoint
ALTER TABLE "inventory"."source_provisioning_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "inventory"."source_provisioning_policy_locations" (
	"tenant_id" uuid,
	"policy_id" uuid,
	"location_key" text,
	"stock_location_id" uuid NOT NULL,
	CONSTRAINT "inventory_source_provisioning_policy_locations_pk" PRIMARY KEY("tenant_id","policy_id","location_key"),
	CONSTRAINT "inventory_source_provisioning_policy_locations_key_ck" CHECK (length(btrim("location_key")) between 1 and 300)
);
--> statement-breakpoint
ALTER TABLE "inventory"."source_provisioning_policy_locations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "inventory"."source_stock_item_provisionings" (
	"tenant_id" uuid,
	"action_invocation_id" uuid,
	"policy_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"input_json" jsonb NOT NULL,
	"provisioning_json" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_source_stock_item_provisionings_pk" PRIMARY KEY("tenant_id","action_invocation_id"),
	CONSTRAINT "inventory_source_stock_item_provisionings_key_ck" CHECK (length(btrim("item_key")) between 1 and 300)
);
--> statement-breakpoint
ALTER TABLE "inventory"."source_stock_item_provisionings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_source_provisioning_policies_scope_id_uk" ON "inventory"."source_provisioning_policies" ("tenant_id","policy_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_source_provisioning_policies_owner_uk" ON "inventory"."source_provisioning_policies" ("tenant_id","owner_configuration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_source_provisioning_policies_qualification_uk" ON "inventory"."source_provisioning_policies" ("tenant_id","customer_configuration_id","issuer_backend_kind","issuer_backend_id","namespace","external_scope");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_source_provisioning_policy_locations_location_uk" ON "inventory"."source_provisioning_policy_locations" ("tenant_id","policy_id","stock_location_id");--> statement-breakpoint
CREATE INDEX "inventory_source_stock_item_provisionings_item_idx" ON "inventory"."source_stock_item_provisionings" ("tenant_id","policy_id","item_key");--> statement-breakpoint
ALTER TABLE "inventory"."source_provisioning_policies" ADD CONSTRAINT "inventory_source_provisioning_policies_owner_fk" FOREIGN KEY ("tenant_id","owner_configuration_id") REFERENCES "inventory"."backend_configurations"("tenant_id","configuration_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."source_provisioning_policy_locations" ADD CONSTRAINT "inventory_source_provisioning_policy_locations_policy_fk" FOREIGN KEY ("tenant_id","policy_id") REFERENCES "inventory"."source_provisioning_policies"("tenant_id","policy_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."source_provisioning_policy_locations" ADD CONSTRAINT "inventory_source_provisioning_policy_locations_location_fk" FOREIGN KEY ("tenant_id","stock_location_id") REFERENCES "inventory"."stock_locations"("tenant_id","stock_location_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."source_stock_item_provisionings" ADD CONSTRAINT "inventory_source_stock_item_provisionings_policy_fk" FOREIGN KEY ("tenant_id","policy_id") REFERENCES "inventory"."source_provisioning_policies"("tenant_id","policy_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."source_stock_item_provisionings" ADD CONSTRAINT "inventory_source_stock_item_provisionings_item_fk" FOREIGN KEY ("tenant_id","stock_item_id") REFERENCES "inventory"."stock_items"("tenant_id","stock_item_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "inventory_source_provisioning_policies_tenant_select" ON "inventory"."source_provisioning_policies" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."source_provisioning_policies"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_source_provisioning_policies_tenant_insert" ON "inventory"."source_provisioning_policies" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."source_provisioning_policies"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_source_provisioning_policies_tenant_update" ON "inventory"."source_provisioning_policies" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."source_provisioning_policies"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."source_provisioning_policies"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_source_provisioning_policies_tenant_delete" ON "inventory"."source_provisioning_policies" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."source_provisioning_policies"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_source_provisioning_policy_locations_tenant_select" ON "inventory"."source_provisioning_policy_locations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."source_provisioning_policy_locations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_source_provisioning_policy_locations_tenant_insert" ON "inventory"."source_provisioning_policy_locations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."source_provisioning_policy_locations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_source_provisioning_policy_locations_tenant_update" ON "inventory"."source_provisioning_policy_locations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."source_provisioning_policy_locations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."source_provisioning_policy_locations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_source_provisioning_policy_locations_tenant_delete" ON "inventory"."source_provisioning_policy_locations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."source_provisioning_policy_locations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_source_stock_item_provisionings_tenant_select" ON "inventory"."source_stock_item_provisionings" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."source_stock_item_provisionings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_source_stock_item_provisionings_tenant_insert" ON "inventory"."source_stock_item_provisionings" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."source_stock_item_provisionings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_source_stock_item_provisionings_tenant_update" ON "inventory"."source_stock_item_provisionings" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."source_stock_item_provisionings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."source_stock_item_provisionings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_source_stock_item_provisionings_tenant_delete" ON "inventory"."source_stock_item_provisionings" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."source_stock_item_provisionings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "inventory"."source_provisioning_policies" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inventory"."source_provisioning_policy_locations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inventory"."source_stock_item_provisionings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION "inventory"."reject_source_provisioning_mutation"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_source_provisioning_immutable_ck',
    MESSAGE = 'Source provisioning policy and receipt history are immutable';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "inventory"."enforce_source_provisioning_scope"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  policy inventory.source_provisioning_policies%ROWTYPE;
  config inventory.backend_configurations%ROWTYPE;
  item inventory.stock_items%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'source_provisioning_policies' THEN
    SELECT * INTO config FROM inventory.backend_configurations
      WHERE tenant_id = NEW.tenant_id AND configuration_id = NEW.owner_configuration_id FOR SHARE;
    IF NOT FOUND OR config.customer_configuration_id IS DISTINCT FROM NEW.customer_configuration_id
      OR config.backend_kind IS DISTINCT FROM NEW.issuer_backend_kind
      OR config.backend_id IS DISTINCT FROM NEW.issuer_backend_id
      OR config.selected_at IS DISTINCT FROM NEW.effective_from
      OR NEW.effective_from > NEW.defined_at THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_source_provisioning_owner_ck',
        MESSAGE = 'Source provisioning policy must retain the selected backend authority';
    END IF;
  ELSIF TG_TABLE_NAME = 'source_provisioning_policy_locations' THEN
    PERFORM 1 FROM inventory.stock_locations
      WHERE tenant_id = NEW.tenant_id AND stock_location_id = NEW.stock_location_id AND lifecycle_state = 'ACTIVE'
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_source_provisioning_location_ck',
        MESSAGE = 'Source provisioning requires an active same-tenant Stock Location';
    END IF;
  ELSE
    SELECT * INTO policy FROM inventory.source_provisioning_policies
      WHERE tenant_id = NEW.tenant_id AND policy_id = NEW.policy_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_source_provisioning_receipt_scope_ck',
        MESSAGE = 'Source provisioning receipt requires its same-tenant policy';
    END IF;
    SELECT * INTO item FROM inventory.stock_items
      WHERE tenant_id = NEW.tenant_id AND stock_item_id = NEW.stock_item_id;
    IF NOT FOUND OR item.lifecycle_state IS DISTINCT FROM 'CURRENT'
      OR item.stock_unit_tenant_id IS DISTINCT FROM NEW.tenant_id
      OR item.stock_unit_resource_id IS DISTINCT FROM policy.unit_resource_id
      OR NEW.input_json #>> '{policyRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR NEW.input_json #>> '{policyRef,resourceId}' IS DISTINCT FROM NEW.policy_id::text
      OR NEW.input_json ->> 'itemKey' IS DISTINCT FROM NEW.item_key
      OR NEW.input_json #>> '{exactSelectionMeaning,id}' IS DISTINCT FROM item.exact_selection_meaning_id
      OR NEW.input_json #>> '{exactSelectionMeaning,kind}' IS DISTINCT FROM item.exact_selection_kind
      OR NEW.input_json #>> '{catalogSelection,productRef,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR NEW.provisioning_json -> 'policyRef' IS DISTINCT FROM NEW.input_json -> 'policyRef'
      OR NEW.provisioning_json ->> 'itemKey' IS DISTINCT FROM NEW.item_key
      OR NEW.provisioning_json #>> '{stockItem,ref,resourceId}' IS DISTINCT FROM NEW.stock_item_id::text
      OR NEW.provisioning_json #>> '{stockItem,ref,tenantId}' IS DISTINCT FROM NEW.tenant_id::text
      OR jsonb_typeof(NEW.provisioning_json -> 'positions') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_source_provisioning_receipt_scope_ck',
        MESSAGE = 'Source provisioning receipt must retain exact policy, item, tenant and input';
    END IF;
    IF (SELECT count(*) FROM jsonb_array_elements(NEW.provisioning_json -> 'positions')) IS DISTINCT FROM
      (SELECT count(*) FROM inventory.source_provisioning_policy_locations WHERE tenant_id = NEW.tenant_id AND policy_id = NEW.policy_id)
      OR EXISTS (
        SELECT 1 FROM inventory.source_provisioning_policy_locations allowed
        WHERE allowed.tenant_id = NEW.tenant_id AND allowed.policy_id = NEW.policy_id AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(NEW.provisioning_json -> 'positions') part
          JOIN inventory.stock_positions position ON position.stock_position_id::text = part #>> '{positionRef,resourceId}'
          WHERE part ->> 'locationKey' = allowed.location_key
            AND part #>> '{positionRef,tenantId}' = NEW.tenant_id::text
            AND part #>> '{stockLocationRef,tenantId}' = NEW.tenant_id::text
            AND part #>> '{stockLocationRef,resourceId}' = allowed.stock_location_id::text
            AND position.tenant_id = NEW.tenant_id AND position.stock_item_id = NEW.stock_item_id
            AND position.stock_location_id = allowed.stock_location_id AND position.lifecycle_state = 'CURRENT'
            AND position.owner_configuration_id = policy.owner_configuration_id
            AND position.customer_configuration_id = policy.customer_configuration_id
            AND position.stock_unit_resource_id = policy.unit_resource_id
            AND position.stock_unit_tenant_id = NEW.tenant_id AND position.stock_unit_module_id = 'commerce.catalog'
            AND position.stock_unit_resource_type = 'commerce.catalog.product-unit'
        )
      ) OR NOT EXISTS (
        SELECT 1 FROM inventory.catalog_to_stock_bindings binding
        WHERE binding.tenant_id = NEW.tenant_id AND binding.stock_item_id = NEW.stock_item_id
          AND binding.binding_id::text = NEW.provisioning_json #>> '{binding,ref,resourceId}'
          AND NEW.provisioning_json #>> '{binding,ref,tenantId}' = NEW.tenant_id::text
          AND binding.catalog_selection = NEW.input_json -> 'catalogSelection'
          AND binding.exact_selection_meaning_id = item.exact_selection_meaning_id
          AND binding.exact_selection_kind = item.exact_selection_kind
      ) OR NOT EXISTS (
        SELECT 1 FROM inventory.external_stock_correlations correlation
        WHERE correlation.tenant_id = NEW.tenant_id AND correlation.stock_item_id = NEW.stock_item_id
          AND correlation.correlation_id::text = NEW.provisioning_json #>> '{itemCorrelation,ref,resourceId}'
          AND NEW.provisioning_json #>> '{itemCorrelation,ref,tenantId}' = NEW.tenant_id::text
          AND correlation.identifier_kind = 'ITEM' AND correlation.external_value = NEW.item_key
          AND correlation.customer_configuration_id = policy.customer_configuration_id
          AND correlation.issuer_backend_kind = policy.issuer_backend_kind AND correlation.issuer_backend_id = policy.issuer_backend_id
          AND correlation.namespace = policy.namespace AND correlation.external_scope = policy.external_scope
          AND correlation.effective_from <= NEW.recorded_at
          AND (correlation.effective_to IS NULL OR correlation.effective_to > NEW.recorded_at)
      ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_source_provisioning_receipt_scope_ck',
        MESSAGE = 'Source provisioning receipt requires every exact Position, binding and effective ITEM correlation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_source_provisioning_policies_scope_trg" BEFORE INSERT ON "inventory"."source_provisioning_policies"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_source_provisioning_scope"();
--> statement-breakpoint
CREATE TRIGGER "inventory_source_provisioning_policies_no_mutation_trg" BEFORE UPDATE OR DELETE ON "inventory"."source_provisioning_policies"
FOR EACH ROW EXECUTE FUNCTION "inventory"."reject_source_provisioning_mutation"();
--> statement-breakpoint
CREATE TRIGGER "inventory_source_provisioning_policy_locations_scope_trg" BEFORE INSERT ON "inventory"."source_provisioning_policy_locations"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_source_provisioning_scope"();
--> statement-breakpoint
CREATE TRIGGER "inventory_source_provisioning_policy_locations_no_mutation_trg" BEFORE UPDATE OR DELETE ON "inventory"."source_provisioning_policy_locations"
FOR EACH ROW EXECUTE FUNCTION "inventory"."reject_source_provisioning_mutation"();
--> statement-breakpoint
CREATE TRIGGER "inventory_source_stock_item_provisionings_scope_trg" BEFORE INSERT ON "inventory"."source_stock_item_provisionings"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_source_provisioning_scope"();
--> statement-breakpoint
CREATE TRIGGER "inventory_source_stock_item_provisionings_no_mutation_trg" BEFORE UPDATE OR DELETE ON "inventory"."source_stock_item_provisionings"
FOR EACH ROW EXECUTE FUNCTION "inventory"."reject_source_provisioning_mutation"();
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_source_provisioning_scope"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."reject_source_provisioning_mutation"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "inventory"."source_provisioning_policies", "inventory"."source_provisioning_policy_locations", "inventory"."source_stock_item_provisionings" TO "ontos_runtime";
