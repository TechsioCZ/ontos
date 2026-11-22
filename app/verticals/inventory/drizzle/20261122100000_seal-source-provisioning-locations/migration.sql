-- Take a single snapshot of every tenant's existing allowed set under the migration's DDL locks.
ALTER TABLE inventory.source_provisioning_policies ADD COLUMN declared_locations jsonb;
--> statement-breakpoint
ALTER TABLE inventory.source_provisioning_policies NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE inventory.source_provisioning_policy_locations NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE inventory.source_provisioning_policies DISABLE TRIGGER inventory_source_provisioning_policies_no_mutation_trg;
--> statement-breakpoint
UPDATE inventory.source_provisioning_policies p SET declared_locations = (
  SELECT jsonb_agg(jsonb_build_object('locationKey', l.location_key, 'stockLocationRef', jsonb_build_object(
    'moduleId', 'commerce.inventory', 'resourceId', l.stock_location_id,
    'resourceType', 'commerce.inventory.stock-location', 'tenantId', l.tenant_id)) ORDER BY l.location_key COLLATE "C")
  FROM inventory.source_provisioning_policy_locations l WHERE l.tenant_id = p.tenant_id AND l.policy_id = p.policy_id
);
--> statement-breakpoint
ALTER TABLE inventory.source_provisioning_policies ENABLE TRIGGER inventory_source_provisioning_policies_no_mutation_trg;
--> statement-breakpoint
ALTER TABLE inventory.source_provisioning_policy_locations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE inventory.source_provisioning_policies FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE inventory.source_provisioning_policies ALTER COLUMN declared_locations SET NOT NULL;
--> statement-breakpoint
ALTER TABLE inventory.source_provisioning_policies ADD CONSTRAINT inventory_source_provisioning_declared_locations_ck
  CHECK (jsonb_typeof(declared_locations) = 'array' AND jsonb_array_length(declared_locations) BETWEEN 1 AND 50);
--> statement-breakpoint
CREATE FUNCTION inventory.enforce_source_provisioning_manifest() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  policy inventory.source_provisioning_policies%ROWTYPE;
  expected jsonb;
BEGIN
  IF TG_TABLE_NAME = 'source_provisioning_policies' THEN
    -- Materialize every declared pair immediately. The normalized rows keep their FKs and active-location checks.
    INSERT INTO inventory.source_provisioning_policy_locations(tenant_id, policy_id, location_key, stock_location_id)
      SELECT NEW.tenant_id, NEW.policy_id, part ->> 'locationKey', (part #>> '{stockLocationRef,resourceId}')::uuid
      FROM jsonb_array_elements(NEW.declared_locations) part;
    RETURN NEW;
  END IF;
  SELECT * INTO policy FROM inventory.source_provisioning_policies
    WHERE tenant_id = NEW.tenant_id AND policy_id = NEW.policy_id;
  IF TG_TABLE_NAME = 'source_provisioning_policy_locations' THEN
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(policy.declared_locations) part
      WHERE part = jsonb_build_object('locationKey', NEW.location_key, 'stockLocationRef', jsonb_build_object(
        'moduleId', 'commerce.inventory', 'resourceId', NEW.stock_location_id,
        'resourceType', 'commerce.inventory.stock-location', 'tenantId', NEW.tenant_id))
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_source_provisioning_manifest_ck',
        MESSAGE = 'Stock Location is not declared by this immutable policy';
    END IF;
  ELSE
    expected := NEW.input_json -> 'expectedPolicy';
    IF expected - 'locations' IS DISTINCT FROM jsonb_build_object(
      'customerConfigurationId', policy.customer_configuration_id, 'externalScope', policy.external_scope,
      'issuer', jsonb_build_object('backendKind', policy.issuer_backend_kind, 'backendId', policy.issuer_backend_id),
      'namespace', policy.namespace, 'unitRef', jsonb_build_object('moduleId', 'commerce.catalog',
        'resourceId', policy.unit_resource_id, 'resourceType', 'commerce.catalog.product-unit', 'tenantId', policy.tenant_id))
      OR jsonb_typeof(expected -> 'locations') IS DISTINCT FROM 'array'
      OR NOT ((expected -> 'locations') @> policy.declared_locations AND (expected -> 'locations') <@ policy.declared_locations)
      OR jsonb_array_length(expected -> 'locations') IS DISTINCT FROM jsonb_array_length(policy.declared_locations) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'inventory_source_provisioning_manifest_ck',
        MESSAGE = 'Provisioning receipt must retain the exact enrolled policy terms';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inventory_source_provisioning_policies_manifest_trg" AFTER INSERT ON inventory.source_provisioning_policies
FOR EACH ROW EXECUTE FUNCTION inventory.enforce_source_provisioning_manifest();
--> statement-breakpoint
CREATE TRIGGER "inventory_source_provisioning_policy_locations_manifest_trg" BEFORE INSERT ON inventory.source_provisioning_policy_locations
FOR EACH ROW EXECUTE FUNCTION inventory.enforce_source_provisioning_manifest();
--> statement-breakpoint
CREATE TRIGGER "inventory_source_stock_item_provisionings_manifest_trg" BEFORE INSERT ON inventory.source_stock_item_provisionings
FOR EACH ROW EXECUTE FUNCTION inventory.enforce_source_provisioning_manifest();
--> statement-breakpoint
REVOKE ALL ON FUNCTION inventory.enforce_source_provisioning_manifest() FROM PUBLIC, ontos_runtime;
