-- Drizzle models RLS enablement and policies, but PostgreSQL FORCE ROW LEVEL SECURITY is explicit.
ALTER TABLE "catalog"."products" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."product_variants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."product_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."product_lifecycle_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Revisions and lifecycle evidence are historical facts: append, never rewrite or erase.
CREATE FUNCTION "catalog"."reject_ledger_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'catalog history is append-only' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "catalog_product_revisions_append_only"
BEFORE UPDATE OR DELETE ON "catalog"."product_revisions"
FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "catalog_product_lifecycle_events_append_only"
BEFORE UPDATE OR DELETE ON "catalog"."product_lifecycle_events"
FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
-- Product identity and the first creation attestation remain stable while descriptive facts evolve.
CREATE FUNCTION "catalog"."protect_product_identity"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'catalog products cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW."product_id" IS DISTINCT FROM OLD."product_id"
    OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."created_by_action_invocation_id" IS DISTINCT FROM OLD."created_by_action_invocation_id"
    OR NEW."created_by_principal_id" IS DISTINCT FROM OLD."created_by_principal_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'catalog product identity and creation evidence are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "catalog_products_identity_immutable"
BEFORE UPDATE OR DELETE ON "catalog"."products"
FOR EACH ROW EXECUTE FUNCTION "catalog"."protect_product_identity"();
--> statement-breakpoint
CREATE FUNCTION "catalog"."protect_product_variant_identity"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR NEW."variant_id" IS DISTINCT FROM OLD."variant_id"
    OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."product_id" IS DISTINCT FROM OLD."product_id"
    OR NEW."created_by_action_invocation_id" IS DISTINCT FROM OLD."created_by_action_invocation_id"
    OR NEW."created_by_principal_id" IS DISTINCT FROM OLD."created_by_principal_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'catalog variant identity and creation evidence are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "catalog_product_variants_identity_immutable"
BEFORE UPDATE OR DELETE ON "catalog"."product_variants"
FOR EACH ROW EXECUTE FUNCTION "catalog"."protect_product_variant_identity"();
