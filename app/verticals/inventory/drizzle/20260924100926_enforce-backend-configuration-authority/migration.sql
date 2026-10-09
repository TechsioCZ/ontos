-- Drizzle models RLS enablement and policies, but PostgreSQL FORCE ROW LEVEL SECURITY is explicit.
ALTER TABLE "inventory"."backend_configurations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION "inventory"."reject_backend_configuration_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Inventory Backend configurations are durable and cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  RAISE EXCEPTION 'Inventory Backend identity, authority, and capability require explicit cutover'
    USING ERRCODE = '23514', CONSTRAINT = 'inventory_backend_configurations_explicit_cutover_ck';
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER "inventory_backend_configurations_explicit_cutover_trg"
BEFORE UPDATE OR DELETE ON "inventory"."backend_configurations"
FOR EACH ROW EXECUTE FUNCTION "inventory"."reject_backend_configuration_mutation"();
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inventory"."reject_backend_configuration_mutation"() FROM PUBLIC, "ontos_runtime";
