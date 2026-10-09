CREATE TABLE "inventory"."catalog_to_stock_binding_history" (
	"binding_history_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_catalog_to_stock_binding_history_revision_ck" CHECK ("revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "inventory"."catalog_to_stock_binding_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "inventory"."catalog_to_stock_bindings" (
	"binding_id" uuid PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"catalog_selection" jsonb NOT NULL,
	"exact_selection_meaning_id" text NOT NULL,
	"exact_selection_kind" text NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"stock_unit_module_id" text NOT NULL,
	"stock_unit_resource_id" uuid NOT NULL,
	"stock_unit_resource_type" text NOT NULL,
	"stock_unit_tenant_id" uuid NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	CONSTRAINT "inventory_catalog_to_stock_bindings_meaning_ck" CHECK (char_length(btrim("exact_selection_meaning_id")) between 1 and 300 and "exact_selection_kind" in ('PRODUCT_VARIANT', 'PACKAGE_OPTION', 'SET_VARIANT', 'CONFIGURED_SELECTION')),
	CONSTRAINT "inventory_catalog_to_stock_bindings_unit_ck" CHECK ("stock_unit_module_id" = 'commerce.catalog' and "stock_unit_resource_type" = 'commerce.catalog.product-unit' and "stock_unit_tenant_id" = "tenant_id"),
	CONSTRAINT "inventory_catalog_to_stock_bindings_revision_ck" CHECK ("current_revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "inventory"."catalog_to_stock_bindings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "inventory"."stock_positions" (
	"stock_position_id" uuid PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"customer_configuration_id" text NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"stock_location_id" uuid NOT NULL,
	"stock_unit_module_id" text NOT NULL,
	"stock_unit_resource_id" uuid NOT NULL,
	"stock_unit_resource_type" text NOT NULL,
	"stock_unit_tenant_id" uuid NOT NULL,
	"lifecycle_state" text DEFAULT 'CURRENT' NOT NULL,
	"on_hand_state" text NOT NULL,
	"on_hand_amount" numeric(38,9),
	"on_hand_evidence_ref" text,
	"on_hand_observed_at" timestamp with time zone,
	"owner_configuration_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_stock_positions_customer_configuration_ck" CHECK ("customer_configuration_id" = btrim("customer_configuration_id") and length("customer_configuration_id") between 1 and 300),
	CONSTRAINT "inventory_stock_positions_unit_ck" CHECK ("stock_unit_module_id" = 'commerce.catalog' and "stock_unit_resource_type" = 'commerce.catalog.product-unit' and "stock_unit_tenant_id" = "tenant_id"),
	CONSTRAINT "inventory_stock_positions_lifecycle_ck" CHECK ("lifecycle_state" in ('CURRENT', 'HISTORICAL')),
	CONSTRAINT "inventory_stock_positions_ended_at_ck" CHECK (("lifecycle_state" = 'CURRENT' and "ended_at" is null) or ("lifecycle_state" = 'HISTORICAL' and "ended_at" is not null)),
	CONSTRAINT "inventory_stock_positions_historical_on_hand_ck" CHECK (not ("lifecycle_state" = 'HISTORICAL' and "on_hand_state" = 'CURRENT')),
	CONSTRAINT "inventory_stock_positions_on_hand_state_ck" CHECK ("on_hand_state" in ('CURRENT', 'UNKNOWN', 'MISSING', 'STALE', 'INDETERMINATE')),
	CONSTRAINT "inventory_stock_positions_on_hand_value_ck" CHECK ((("on_hand_state" in ('CURRENT', 'STALE')) and "on_hand_amount" is not null and "on_hand_amount" >= 0 and "on_hand_evidence_ref" is not null and "on_hand_observed_at" is not null) or (("on_hand_state" in ('UNKNOWN', 'MISSING', 'INDETERMINATE')) and "on_hand_amount" is null and "on_hand_evidence_ref" is null and "on_hand_observed_at" is null)),
	CONSTRAINT "inventory_stock_positions_revision_ck" CHECK ("revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "inventory"."stock_positions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_catalog_to_stock_binding_history_scope_id_uk" ON "inventory"."catalog_to_stock_binding_history" ("tenant_id","binding_history_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_catalog_to_stock_binding_history_revision_uk" ON "inventory"."catalog_to_stock_binding_history" ("tenant_id","binding_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_catalog_to_stock_bindings_scope_id_uk" ON "inventory"."catalog_to_stock_bindings" ("tenant_id","binding_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_catalog_to_stock_bindings_selection_meaning_uk" ON "inventory"."catalog_to_stock_bindings" ("tenant_id","exact_selection_meaning_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_catalog_to_stock_bindings_stock_item_uk" ON "inventory"."catalog_to_stock_bindings" ("tenant_id","stock_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_stock_positions_scope_id_uk" ON "inventory"."stock_positions" ("tenant_id","stock_position_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_stock_positions_current_scope_uk" ON "inventory"."stock_positions" ("tenant_id","customer_configuration_id","stock_item_id","stock_location_id") WHERE "lifecycle_state" = 'CURRENT';--> statement-breakpoint
CREATE INDEX "inventory_stock_positions_item_idx" ON "inventory"."stock_positions" ("tenant_id","stock_item_id");--> statement-breakpoint
CREATE INDEX "inventory_stock_positions_location_idx" ON "inventory"."stock_positions" ("tenant_id","stock_location_id");--> statement-breakpoint
ALTER TABLE "inventory"."catalog_to_stock_binding_history" ADD CONSTRAINT "inventory_catalog_to_stock_binding_history_binding_fk" FOREIGN KEY ("tenant_id","binding_id") REFERENCES "inventory"."catalog_to_stock_bindings"("tenant_id","binding_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."catalog_to_stock_bindings" ADD CONSTRAINT "inventory_catalog_to_stock_bindings_stock_item_fk" FOREIGN KEY ("tenant_id","stock_item_id") REFERENCES "inventory"."stock_items"("tenant_id","stock_item_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."stock_positions" ADD CONSTRAINT "inventory_stock_positions_item_fk" FOREIGN KEY ("tenant_id","stock_item_id") REFERENCES "inventory"."stock_items"("tenant_id","stock_item_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."stock_positions" ADD CONSTRAINT "inventory_stock_positions_location_fk" FOREIGN KEY ("tenant_id","stock_location_id") REFERENCES "inventory"."stock_locations"("tenant_id","stock_location_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."stock_positions" ADD CONSTRAINT "inventory_stock_positions_backend_configuration_fk" FOREIGN KEY ("tenant_id","owner_configuration_id") REFERENCES "inventory"."backend_configurations"("tenant_id","configuration_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "inventory_catalog_to_stock_binding_history_tenant_select" ON "inventory"."catalog_to_stock_binding_history" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."catalog_to_stock_binding_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_catalog_to_stock_binding_history_tenant_insert" ON "inventory"."catalog_to_stock_binding_history" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."catalog_to_stock_binding_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_catalog_to_stock_binding_history_tenant_update" ON "inventory"."catalog_to_stock_binding_history" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."catalog_to_stock_binding_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."catalog_to_stock_binding_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_catalog_to_stock_binding_history_tenant_delete" ON "inventory"."catalog_to_stock_binding_history" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."catalog_to_stock_binding_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_catalog_to_stock_bindings_tenant_select" ON "inventory"."catalog_to_stock_bindings" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."catalog_to_stock_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_catalog_to_stock_bindings_tenant_insert" ON "inventory"."catalog_to_stock_bindings" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."catalog_to_stock_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_catalog_to_stock_bindings_tenant_update" ON "inventory"."catalog_to_stock_bindings" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."catalog_to_stock_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."catalog_to_stock_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_catalog_to_stock_bindings_tenant_delete" ON "inventory"."catalog_to_stock_bindings" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."catalog_to_stock_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_positions_tenant_select" ON "inventory"."stock_positions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."stock_positions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_positions_tenant_insert" ON "inventory"."stock_positions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."stock_positions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_positions_tenant_update" ON "inventory"."stock_positions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."stock_positions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."stock_positions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_positions_tenant_delete" ON "inventory"."stock_positions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."stock_positions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- Drizzle models policy creation but not PostgreSQL FORCE ROW LEVEL SECURITY.
ALTER TABLE "inventory"."catalog_to_stock_binding_history" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inventory"."catalog_to_stock_bindings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inventory"."stock_positions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION "inventory"."reject_stock_position_scope_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Stock Positions are durable and cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.stock_position_id IS DISTINCT FROM OLD.stock_position_id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.customer_configuration_id IS DISTINCT FROM OLD.customer_configuration_id
    OR NEW.stock_item_id IS DISTINCT FROM OLD.stock_item_id
    OR NEW.stock_location_id IS DISTINCT FROM OLD.stock_location_id
    OR NEW.stock_unit_module_id IS DISTINCT FROM OLD.stock_unit_module_id
    OR NEW.stock_unit_resource_id IS DISTINCT FROM OLD.stock_unit_resource_id
    OR NEW.stock_unit_resource_type IS DISTINCT FROM OLD.stock_unit_resource_type
    OR NEW.stock_unit_tenant_id IS DISTINCT FROM OLD.stock_unit_tenant_id
  THEN
    RAISE EXCEPTION 'Stock Position identity, scope, and exact Unit are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'inventory_stock_positions_immutable_scope_ck';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER "inventory_stock_positions_immutable_scope_trg"
BEFORE UPDATE OR DELETE ON "inventory"."stock_positions"
FOR EACH ROW EXECUTE FUNCTION "inventory"."reject_stock_position_scope_mutation"();
--> statement-breakpoint
CREATE FUNCTION "inventory"."enforce_stock_position_stock_item_unit"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "inventory"."stock_items" AS stock_item
    WHERE stock_item.tenant_id = NEW.tenant_id
      AND stock_item.stock_item_id = NEW.stock_item_id
      AND stock_item.stock_unit_module_id = NEW.stock_unit_module_id
      AND stock_item.stock_unit_resource_id = NEW.stock_unit_resource_id
      AND stock_item.stock_unit_resource_type = NEW.stock_unit_resource_type
      AND stock_item.stock_unit_tenant_id = NEW.stock_unit_tenant_id
  ) THEN
    RAISE EXCEPTION 'Stock Position Unit must exactly match its Stock Item Unit'
      USING ERRCODE = '23514', CONSTRAINT = 'inventory_stock_positions_exact_item_unit_ck';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER "inventory_stock_positions_exact_item_unit_trg"
BEFORE INSERT OR UPDATE ON "inventory"."stock_positions"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_stock_position_stock_item_unit"();
--> statement-breakpoint
CREATE FUNCTION "inventory"."enforce_stock_position_owner_configuration"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "inventory"."backend_configurations" AS backend_configuration
    WHERE backend_configuration.tenant_id = NEW.tenant_id
      AND backend_configuration.configuration_id = NEW.owner_configuration_id
      AND backend_configuration.customer_configuration_id = NEW.customer_configuration_id
  ) THEN
    RAISE EXCEPTION 'Stock Position ON_HAND owner must be the selected Customer Configuration Inventory Backend'
      USING ERRCODE = '23514', CONSTRAINT = 'inventory_stock_positions_owner_configuration_ck';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER "inventory_stock_positions_owner_configuration_trg"
BEFORE INSERT OR UPDATE ON "inventory"."stock_positions"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_stock_position_owner_configuration"();
--> statement-breakpoint
CREATE FUNCTION "inventory"."reject_catalog_to_stock_binding_history_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'Catalog-to-Stock Binding history is append-only'
    USING ERRCODE = '23514', CONSTRAINT = 'inventory_catalog_to_stock_binding_history_append_only_ck';
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER "inventory_catalog_to_stock_binding_history_no_update_trg"
BEFORE UPDATE ON "inventory"."catalog_to_stock_binding_history"
FOR EACH ROW EXECUTE FUNCTION "inventory"."reject_catalog_to_stock_binding_history_mutation"();
--> statement-breakpoint
CREATE TRIGGER "inventory_catalog_to_stock_binding_history_no_delete_trg"
BEFORE DELETE ON "inventory"."catalog_to_stock_binding_history"
FOR EACH ROW EXECUTE FUNCTION "inventory"."reject_catalog_to_stock_binding_history_mutation"();
--> statement-breakpoint
CREATE FUNCTION "inventory"."enforce_catalog_to_stock_binding_compatibility"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  target_lifecycle_state text;
  target_exact_selection_meaning_id text;
  target_exact_selection_kind text;
  target_stock_unit_module_id text;
  target_stock_unit_resource_id uuid;
  target_stock_unit_resource_type text;
  target_stock_unit_tenant_id uuid;
BEGIN
  SELECT
    stock_item.lifecycle_state,
    stock_item.exact_selection_meaning_id,
    stock_item.exact_selection_kind,
    stock_item.stock_unit_module_id,
    stock_item.stock_unit_resource_id,
    stock_item.stock_unit_resource_type,
    stock_item.stock_unit_tenant_id
  INTO
    target_lifecycle_state,
    target_exact_selection_meaning_id,
    target_exact_selection_kind,
    target_stock_unit_module_id,
    target_stock_unit_resource_id,
    target_stock_unit_resource_type,
    target_stock_unit_tenant_id
  FROM "inventory"."stock_items" AS stock_item
  WHERE stock_item.tenant_id = NEW.tenant_id
    AND stock_item.stock_item_id = NEW.stock_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Catalog-to-Stock Binding target Stock Item does not exist in the Tenant'
      USING ERRCODE = '23514', CONSTRAINT = 'inventory_catalog_to_stock_bindings_target_missing_ck';
  END IF;
  IF target_lifecycle_state IS DISTINCT FROM 'CURRENT' THEN
    RAISE EXCEPTION 'Catalog-to-Stock Binding target Stock Item must be Current'
      USING ERRCODE = '23514', CONSTRAINT = 'inventory_catalog_to_stock_bindings_target_current_ck';
  END IF;
  IF target_exact_selection_meaning_id IS DISTINCT FROM NEW.exact_selection_meaning_id
    OR target_exact_selection_kind IS DISTINCT FROM NEW.exact_selection_kind
  THEN
    RAISE EXCEPTION 'Catalog-to-Stock Binding meaning must exactly match its Stock Item'
      USING ERRCODE = '23514', CONSTRAINT = 'inventory_catalog_to_stock_bindings_target_meaning_ck';
  END IF;
  IF target_stock_unit_module_id IS DISTINCT FROM NEW.stock_unit_module_id
    OR target_stock_unit_resource_id IS DISTINCT FROM NEW.stock_unit_resource_id
    OR target_stock_unit_resource_type IS DISTINCT FROM NEW.stock_unit_resource_type
    OR target_stock_unit_tenant_id IS DISTINCT FROM NEW.stock_unit_tenant_id
  THEN
    RAISE EXCEPTION 'Catalog-to-Stock Binding Unit must exactly match its Stock Item'
      USING ERRCODE = '23514', CONSTRAINT = 'inventory_catalog_to_stock_bindings_target_unit_ck';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER "inventory_catalog_to_stock_bindings_compatibility_trg"
BEFORE INSERT OR UPDATE ON "inventory"."catalog_to_stock_bindings"
FOR EACH ROW EXECUTE FUNCTION "inventory"."enforce_catalog_to_stock_binding_compatibility"();
--> statement-breakpoint
CREATE FUNCTION "inventory"."protect_current_catalog_to_stock_binding_target"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF (NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state
      OR NEW.exact_selection_meaning_id IS DISTINCT FROM OLD.exact_selection_meaning_id
      OR NEW.exact_selection_kind IS DISTINCT FROM OLD.exact_selection_kind
      OR NEW.stock_unit_module_id IS DISTINCT FROM OLD.stock_unit_module_id
      OR NEW.stock_unit_resource_id IS DISTINCT FROM OLD.stock_unit_resource_id
      OR NEW.stock_unit_resource_type IS DISTINCT FROM OLD.stock_unit_resource_type
      OR NEW.stock_unit_tenant_id IS DISTINCT FROM OLD.stock_unit_tenant_id)
    AND EXISTS (
      SELECT 1
      FROM "inventory"."catalog_to_stock_bindings" AS binding
      WHERE binding.tenant_id = OLD.tenant_id
        AND binding.stock_item_id = OLD.stock_item_id
    )
  THEN
    RAISE EXCEPTION 'A Current Catalog-to-Stock Binding target cannot retire or change meaning or Unit'
      USING ERRCODE = '23514', CONSTRAINT = 'inventory_stock_items_current_binding_target_ck';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER "inventory_stock_items_current_binding_target_trg"
BEFORE UPDATE ON "inventory"."stock_items"
FOR EACH ROW EXECUTE FUNCTION "inventory"."protect_current_catalog_to_stock_binding_target"();
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."reject_stock_position_scope_mutation"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_stock_position_stock_item_unit"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_stock_position_owner_configuration"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."reject_catalog_to_stock_binding_history_mutation"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."enforce_catalog_to_stock_binding_compatibility"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."protect_current_catalog_to_stock_binding_target"() FROM PUBLIC, "ontos_runtime";
