-- Legacy ACTIVE rows without exact combination evidence cannot be safely inferred.
-- Refuse the migration so an operator can classify/remediate them explicitly.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM catalog.product_variants v
    WHERE NOT ((v.lifecycle_state = 'ACTIVE' AND v.combination_key IS NOT NULL
      AND v.combination_axis_revision IS NOT NULL AND length(v.combination_key) = 64
      AND v.combination_key ~ '^[0-9a-f]{64}$')
      OR (v.lifecycle_state <> 'ACTIVE' AND v.combination_key IS NULL
      AND v.combination_axis_revision IS NULL))
  ) THEN
    RAISE EXCEPTION 'Catalog has legacy Variant combinations requiring explicit remediation'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM catalog.product_variant_axis_events e
    WHERE array_position(e.attribute_definition_ids, NULL) IS NOT NULL
      OR cardinality(e.attribute_definition_ids) <> (
        SELECT count(DISTINCT x.id) FROM unnest(e.attribute_definition_ids) AS x(id))
  ) THEN
    RAISE EXCEPTION 'Catalog has malformed Variant Axis history requiring explicit remediation'
      USING ERRCODE = '23514';
  END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE "catalog"."product_variant_revisions" ADD CONSTRAINT "catalog_product_variant_revisions_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "catalog"."products"("tenant_id","product_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_variant_revisions" ADD CONSTRAINT "catalog_product_variant_revisions_axis_revision_fk" FOREIGN KEY ("tenant_id","product_id","combination_axis_revision") REFERENCES "catalog"."product_variant_axis_events"("tenant_id","product_id","axis_revision") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_variants" ADD CONSTRAINT "catalog_product_variants_axis_revision_fk" FOREIGN KEY ("tenant_id","product_id","combination_axis_revision") REFERENCES "catalog"."product_variant_axis_events"("tenant_id","product_id","axis_revision") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_variant_axis_events" ADD CONSTRAINT "catalog_product_variant_axis_events_null_free_ck" CHECK (array_position("attribute_definition_ids", null) is null);
--> statement-breakpoint
ALTER TABLE "catalog"."product_variants" VALIDATE CONSTRAINT "catalog_product_variants_combination_ck";
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM catalog.product_variants v
    WHERE v.lifecycle_state = 'ACTIVE' AND v.combination_axis_revision IS DISTINCT FROM (
      SELECT max(e.axis_revision) FROM catalog.product_variant_axis_events e
      WHERE e.tenant_id = v.tenant_id AND e.product_id = v.product_id)
  ) THEN
    RAISE EXCEPTION 'Catalog has ACTIVE Variants with stale Axis evidence requiring explicit remediation'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM catalog.product_variant_axis_events e
    WHERE e.axis_revision = (
      SELECT max(later.axis_revision) FROM catalog.product_variant_axis_events later
      WHERE later.tenant_id = e.tenant_id AND later.product_id = e.product_id)
      AND e.attribute_definition_ids IS DISTINCT FROM coalesce((
        SELECT array_agg(a.attribute_definition_id ORDER BY a.ordinal)
        FROM catalog.product_variant_axes a
        WHERE a.tenant_id = e.tenant_id AND a.product_id = e.product_id), ARRAY[]::uuid[])
  ) OR EXISTS (
    SELECT 1 FROM catalog.product_variant_axes a
    WHERE NOT EXISTS (SELECT 1 FROM catalog.product_variant_axis_events e
      WHERE e.tenant_id = a.tenant_id AND e.product_id = a.product_id
        AND e.axis_revision = a.axis_revision)
  ) THEN
    RAISE EXCEPTION 'Catalog Current Variant Axes lack matching latest history requiring explicit remediation'
      USING ERRCODE = '23514';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "catalog"."enforce_variant_axis_current"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  target_tenant uuid;
  target_product uuid;
  latest_revision integer;
  latest_ids uuid[];
  current_ids uuid[];
  revisions_match boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_tenant := OLD.tenant_id;
    target_product := OLD.product_id;
  ELSE
    target_tenant := NEW.tenant_id;
    target_product := NEW.product_id;
  END IF;

  -- Serialize whole-Product axis and Variant changes, including concurrent commits.
  PERFORM 1 FROM catalog.products p
  WHERE p.tenant_id = target_tenant AND p.product_id = target_product FOR UPDATE;
  SELECT e.axis_revision, e.attribute_definition_ids INTO latest_revision, latest_ids
  FROM catalog.product_variant_axis_events e
  WHERE e.tenant_id = target_tenant AND e.product_id = target_product
  ORDER BY e.axis_revision DESC LIMIT 1;
  SELECT coalesce(array_agg(a.attribute_definition_id ORDER BY a.ordinal), ARRAY[]::uuid[]),
    coalesce(bool_and(a.axis_revision = latest_revision), true)
    INTO current_ids, revisions_match
  FROM catalog.product_variant_axes a
  WHERE a.tenant_id = target_tenant AND a.product_id = target_product;
  IF latest_revision IS NULL THEN
    IF cardinality(current_ids) <> 0 THEN
      RAISE EXCEPTION 'Catalog Variant Axes lack a revision event' USING ERRCODE = '23514';
    END IF;
  ELSIF current_ids IS DISTINCT FROM latest_ids OR NOT revisions_match THEN
    RAISE EXCEPTION 'Catalog Variant Axes differ from latest revision event' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM catalog.product_variants v
    WHERE v.tenant_id = target_tenant AND v.product_id = target_product
      AND v.lifecycle_state = 'ACTIVE'
      AND v.combination_axis_revision IS DISTINCT FROM latest_revision
  ) THEN
    RAISE EXCEPTION 'Catalog ACTIVE Variant uses stale Axis revision' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "catalog_product_variants_axis_current"
AFTER INSERT OR UPDATE ON "catalog"."product_variants"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "catalog"."enforce_variant_axis_current"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "catalog_product_variant_axes_current"
AFTER INSERT OR UPDATE OR DELETE ON "catalog"."product_variant_axes"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "catalog"."enforce_variant_axis_current"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "catalog_product_variant_axis_events_current"
AFTER INSERT ON "catalog"."product_variant_axis_events"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "catalog"."enforce_variant_axis_current"();
--> statement-breakpoint
CREATE FUNCTION "catalog"."reject_duplicate_variant_axis_event"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF array_position(NEW.attribute_definition_ids, NULL) IS NOT NULL
    OR cardinality(NEW.attribute_definition_ids) <> (
      SELECT count(DISTINCT x.id) FROM unnest(NEW.attribute_definition_ids) AS x(id))
  THEN
    RAISE EXCEPTION 'Catalog Variant Axis event contains null or duplicate definitions'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "catalog_product_variant_axis_events_distinct"
BEFORE INSERT ON "catalog"."product_variant_axis_events"
FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_duplicate_variant_axis_event"();
--> statement-breakpoint
REVOKE ALL ON FUNCTION "catalog"."enforce_variant_axis_current"() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "catalog"."reject_duplicate_variant_axis_event"() FROM PUBLIC;
