ALTER TABLE "catalog"."product_category_events" ADD COLUMN "previous_name" text;--> statement-breakpoint
ALTER TABLE "catalog"."product_category_events" ADD COLUMN "next_name" text;--> statement-breakpoint
ALTER TABLE "catalog"."product_category_events" ADD COLUMN "previous_lifecycle_state" text;--> statement-breakpoint
ALTER TABLE "catalog"."product_category_events" ADD COLUMN "next_lifecycle_state" text;--> statement-breakpoint
ALTER TABLE "catalog"."product_category_events" ADD COLUMN "category_revision" integer;--> statement-breakpoint
ALTER TABLE "catalog"."product_category_events" ADD CONSTRAINT "catalog_product_category_events_previous_parent_fk" FOREIGN KEY ("tenant_id","previous_parent_category_id") REFERENCES "catalog"."product_categories"("tenant_id","category_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_category_events" ADD CONSTRAINT "catalog_product_category_events_next_parent_fk" FOREIGN KEY ("tenant_id","next_parent_category_id") REFERENCES "catalog"."product_categories"("tenant_id","category_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_category_events" ADD CONSTRAINT "catalog_product_category_events_category_revision_ck" CHECK ("category_revision" is null or "category_revision" > 0);--> statement-breakpoint
ALTER TABLE "catalog"."product_category_events" ADD CONSTRAINT "catalog_product_category_events_previous_lifecycle_ck" CHECK ("previous_lifecycle_state" is null or "previous_lifecycle_state" in ('ACTIVE', 'RETIRED'));--> statement-breakpoint
ALTER TABLE "catalog"."product_category_events" ADD CONSTRAINT "catalog_product_category_events_next_lifecycle_ck" CHECK ("next_lifecycle_state" is null or "next_lifecycle_state" in ('ACTIVE', 'RETIRED'));--> statement-breakpoint
ALTER TABLE "catalog"."product_category_events" ADD CONSTRAINT "catalog_product_category_events_previous_name_ck" CHECK ("previous_name" is null or ("previous_name" = btrim("previous_name") and length("previous_name") between 1 and 240));--> statement-breakpoint
ALTER TABLE "catalog"."product_category_events" ADD CONSTRAINT "catalog_product_category_events_next_name_ck" CHECK ("next_name" is null or ("next_name" = btrim("next_name") and length("next_name") between 1 and 240));
--> statement-breakpoint
-- Preserve stable business identity and its creation attestation; Current facts may evolve.
CREATE FUNCTION "catalog"."protect_product_type_identity"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'catalog product types cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW."product_type_id" IS DISTINCT FROM OLD."product_type_id"
    OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."created_by_action_invocation_id" IS DISTINCT FROM OLD."created_by_action_invocation_id"
    OR NEW."created_by_principal_id" IS DISTINCT FROM OLD."created_by_principal_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR NEW."current_revision" < OLD."current_revision"
    OR NEW."current_revision" > OLD."current_revision" + 1
  THEN
    RAISE EXCEPTION 'catalog product type identity, creation evidence, and revision progression are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "catalog_product_types_identity_immutable"
BEFORE UPDATE OR DELETE ON "catalog"."product_types"
FOR EACH ROW EXECUTE FUNCTION "catalog"."protect_product_type_identity"();
--> statement-breakpoint
CREATE FUNCTION "catalog"."protect_product_category_identity"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'catalog product categories cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW."category_id" IS DISTINCT FROM OLD."category_id"
    OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."created_by_action_invocation_id" IS DISTINCT FROM OLD."created_by_action_invocation_id"
    OR NEW."created_by_principal_id" IS DISTINCT FROM OLD."created_by_principal_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR NEW."current_revision" < OLD."current_revision"
    OR NEW."current_revision" > OLD."current_revision" + 1
  THEN
    RAISE EXCEPTION 'catalog category identity, creation evidence, and revision progression are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "catalog_product_categories_identity_immutable"
BEFORE UPDATE OR DELETE ON "catalog"."product_categories"
FOR EACH ROW EXECUTE FUNCTION "catalog"."protect_product_category_identity"();
--> statement-breakpoint
-- Every category mutation takes this tenant row lock and advances exactly one counter.
CREATE FUNCTION "catalog"."protect_category_revision_counters"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'catalog category revision counters cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NOT (
      (NEW."hierarchy_revision" = OLD."hierarchy_revision" + 1 AND NEW."assignment_revision" = OLD."assignment_revision")
      OR (NEW."hierarchy_revision" = OLD."hierarchy_revision" AND NEW."assignment_revision" = OLD."assignment_revision" + 1)
    )
  THEN
    RAISE EXCEPTION 'catalog category revision counters must advance one at a time'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "catalog_category_revision_counters_monotonic"
BEFORE UPDATE OR DELETE ON "catalog"."product_category_hierarchy_revisions"
FOR EACH ROW EXECUTE FUNCTION "catalog"."protect_category_revision_counters"();
