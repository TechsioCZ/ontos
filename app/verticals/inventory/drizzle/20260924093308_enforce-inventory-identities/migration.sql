-- Drizzle models RLS enablement and policies, but PostgreSQL FORCE ROW LEVEL SECURITY is explicit.
ALTER TABLE "inventory"."stock_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inventory"."stock_location_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inventory"."stock_locations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA "inventory" FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION "inventory"."reject_stock_item_meaning_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Stock Items are durable and cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.stock_item_id IS DISTINCT FROM OLD.stock_item_id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.exact_selection_kind IS DISTINCT FROM OLD.exact_selection_kind
    OR NEW.exact_selection_meaning_id IS DISTINCT FROM OLD.exact_selection_meaning_id
    OR NEW.stock_unit_module_id IS DISTINCT FROM OLD.stock_unit_module_id
    OR NEW.stock_unit_resource_id IS DISTINCT FROM OLD.stock_unit_resource_id
    OR NEW.stock_unit_resource_type IS DISTINCT FROM OLD.stock_unit_resource_type
    OR NEW.stock_unit_tenant_id IS DISTINCT FROM OLD.stock_unit_tenant_id
  THEN
    RAISE EXCEPTION 'Stock Item identity, exact Selection meaning, and exact Unit identity are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'inventory_stock_items_immutable_meaning_ck';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER "inventory_stock_items_immutable_meaning_trg"
BEFORE UPDATE OR DELETE ON "inventory"."stock_items"
FOR EACH ROW EXECUTE FUNCTION "inventory"."reject_stock_item_meaning_mutation"();
--> statement-breakpoint
CREATE FUNCTION "inventory"."reject_stock_location_identity_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Stock Locations are durable and cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.stock_location_id IS DISTINCT FROM OLD.stock_location_id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
  THEN
    RAISE EXCEPTION 'Stock Location identity and Tenant are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'inventory_stock_locations_immutable_identity_ck';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER "inventory_stock_locations_immutable_identity_trg"
BEFORE UPDATE OR DELETE ON "inventory"."stock_locations"
FOR EACH ROW EXECUTE FUNCTION "inventory"."reject_stock_location_identity_mutation"();
--> statement-breakpoint
CREATE FUNCTION "inventory"."reject_stock_location_revision_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'Stock Location revision history is append-only'
    USING ERRCODE = '23514', CONSTRAINT = 'inventory_stock_location_revisions_append_only_ck';
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER "inventory_stock_location_revisions_append_only_trg"
BEFORE UPDATE OR DELETE ON "inventory"."stock_location_revisions"
FOR EACH ROW EXECUTE FUNCTION "inventory"."reject_stock_location_revision_mutation"();
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."reject_stock_item_meaning_mutation"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."reject_stock_location_identity_mutation"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."reject_stock_location_revision_mutation"() FROM PUBLIC, "ontos_runtime";
