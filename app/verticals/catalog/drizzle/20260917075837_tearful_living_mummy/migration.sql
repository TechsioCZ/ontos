ALTER TABLE "catalog"."attribute_definition_revisions" ADD COLUMN "meaning" text NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog"."attribute_definition_revisions" ADD COLUMN "controlled_value_kind" text;--> statement-breakpoint
ALTER TABLE "catalog"."attribute_definition_revisions" ADD COLUMN "applicable_levels" text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog"."attribute_definition_revisions" ADD COLUMN "allows_none" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog"."attribute_definitions" ADD COLUMN "meaning" text NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog"."attribute_definitions" ADD COLUMN "controlled_value_kind" text;--> statement-breakpoint
ALTER TABLE "catalog"."attribute_definitions" ADD COLUMN "applicable_levels" text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog"."attribute_definitions" ADD COLUMN "allows_none" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog"."controlled_attribute_value_revisions" ADD COLUMN "meaning" text NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog"."controlled_attribute_value_revisions" ADD COLUMN "specialization" text NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog"."controlled_attribute_value_revisions" ADD COLUMN "swatch_system" text;--> statement-breakpoint
ALTER TABLE "catalog"."controlled_attribute_value_revisions" ADD COLUMN "swatch_code" text;--> statement-breakpoint
ALTER TABLE "catalog"."controlled_attribute_values" ADD COLUMN "meaning" text NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog"."controlled_attribute_values" ADD COLUMN "specialization" text NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog"."controlled_attribute_values" ADD COLUMN "swatch_system" text;--> statement-breakpoint
ALTER TABLE "catalog"."controlled_attribute_values" ADD COLUMN "swatch_code" text;--> statement-breakpoint
ALTER TABLE "catalog"."attribute_definitions" ADD CONSTRAINT "catalog_attribute_definitions_controlled_kind_ck" CHECK (("value_kind" = 'CONTROLLED' and "controlled_value_kind" in ('GENERAL', 'COLOR', 'SIZE')) or ("value_kind" <> 'CONTROLLED' and "controlled_value_kind" is null));--> statement-breakpoint
ALTER TABLE "catalog"."attribute_definitions" ADD CONSTRAINT "catalog_attribute_definitions_levels_ck" CHECK (cardinality("applicable_levels") between 1 and 2 and "applicable_levels" <@ array['PRODUCT', 'VARIANT']::text[] and array_position("applicable_levels", null) is null and ("applicable_levels" = array['PRODUCT']::text[] or "applicable_levels" = array['VARIANT']::text[] or "applicable_levels" in (array['PRODUCT','VARIANT']::text[], array['VARIANT','PRODUCT']::text[])));--> statement-breakpoint
ALTER TABLE "catalog"."attribute_definitions" ADD CONSTRAINT "catalog_attribute_definitions_meaning_ck" CHECK ("meaning" = btrim("meaning") and length("meaning") between 1 and 1000);--> statement-breakpoint
ALTER TABLE "catalog"."controlled_attribute_values" ADD CONSTRAINT "catalog_controlled_values_specialization_ck" CHECK ("specialization" in ('GENERAL', 'COLOR', 'SIZE'));--> statement-breakpoint
ALTER TABLE "catalog"."controlled_attribute_values" ADD CONSTRAINT "catalog_controlled_values_swatch_ck" CHECK (("swatch_system" is null and "swatch_code" is null) or ("specialization" = 'COLOR' and "swatch_system" is not null and "swatch_code" is not null));--> statement-breakpoint
ALTER TABLE "catalog"."controlled_attribute_values" ADD CONSTRAINT "catalog_controlled_values_meaning_ck" CHECK ("meaning" = btrim("meaning") and length("meaning") between 1 and 1000);--> statement-breakpoint
ALTER TABLE "catalog"."attribute_definitions" DROP CONSTRAINT "catalog_attribute_definitions_special_ck", ADD CONSTRAINT "catalog_attribute_definitions_special_ck" CHECK ("allows_unknown" in (0, 1) and "allows_not_applicable" in (0, 1) and "allows_none" in (0, 1));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "catalog"."protect_attribute_identity"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'catalog attribute identities cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."attribute_definition_id" IS DISTINCT FROM OLD."attribute_definition_id"
    OR NEW."meaning" IS DISTINCT FROM OLD."meaning"
    OR NEW."value_kind" IS DISTINCT FROM OLD."value_kind"
    OR NEW."controlled_value_kind" IS DISTINCT FROM OLD."controlled_value_kind"
    OR NEW."measured_quantity" IS DISTINCT FROM OLD."measured_quantity"
    OR NEW."canonical_unit" IS DISTINCT FROM OLD."canonical_unit"
    OR NEW."created_by_action_invocation_id" IS DISTINCT FROM OLD."created_by_action_invocation_id"
    OR NEW."created_by_principal_id" IS DISTINCT FROM OLD."created_by_principal_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR NEW."current_revision" <> OLD."current_revision" + 1 THEN
    RAISE EXCEPTION 'catalog attribute meaning, identity, and revision progression are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- A controlled value can only belong to a definition of its specialization.
CREATE FUNCTION "catalog"."validate_controlled_value_definition"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "catalog"."attribute_definitions" d
    WHERE d."tenant_id" = NEW."tenant_id"
      AND d."attribute_definition_id" = NEW."attribute_definition_id"
      AND d."value_kind" = 'CONTROLLED'
      AND d."controlled_value_kind" = NEW."specialization"
  ) THEN
    RAISE EXCEPTION 'controlled value specialization must match its definition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "catalog_controlled_values_definition_kind"
BEFORE INSERT OR UPDATE ON "catalog"."controlled_attribute_values"
FOR EACH ROW EXECUTE FUNCTION "catalog"."validate_controlled_value_definition"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "catalog"."protect_controlled_value_identity"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'catalog controlled values cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."attribute_definition_id" IS DISTINCT FROM OLD."attribute_definition_id"
    OR NEW."controlled_attribute_value_id" IS DISTINCT FROM OLD."controlled_attribute_value_id"
    OR NEW."meaning" IS DISTINCT FROM OLD."meaning"
    OR NEW."specialization" IS DISTINCT FROM OLD."specialization"
    OR NEW."created_by_action_invocation_id" IS DISTINCT FROM OLD."created_by_action_invocation_id"
    OR NEW."created_by_principal_id" IS DISTINCT FROM OLD."created_by_principal_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR NEW."current_revision" <> OLD."current_revision" + 1 THEN
    RAISE EXCEPTION 'catalog controlled value meaning, identity, and revision progression are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
