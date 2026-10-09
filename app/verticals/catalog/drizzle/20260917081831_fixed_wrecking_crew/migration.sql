CREATE TABLE "catalog"."attribute_value_items" (
	"tenant_id" uuid,
	"attribute_value_set_id" uuid,
	"attribute_definition_id" uuid NOT NULL,
	"ordinal" integer,
	"value_kind" text NOT NULL,
	"text_value" text,
	"numeric_value" numeric,
	"unit" text,
	"controlled_attribute_value_id" uuid,
	"special_state" text,
	CONSTRAINT "catalog_attribute_value_items_pk" PRIMARY KEY("tenant_id","attribute_value_set_id","ordinal"),
	CONSTRAINT "catalog_attribute_value_items_ordinal_ck" CHECK ("ordinal" >= 0),
	CONSTRAINT "catalog_attribute_value_items_shape_ck" CHECK (("value_kind" = 'TEXT' and "text_value" is not null and "numeric_value" is null and "unit" is null and "controlled_attribute_value_id" is null and "special_state" is null) or ("value_kind" = 'MEASUREMENT' and "text_value" is null and "numeric_value" is not null and "unit" is not null and "controlled_attribute_value_id" is null and "special_state" is null) or ("value_kind" = 'CONTROLLED' and "text_value" is null and "numeric_value" is null and "unit" is null and "controlled_attribute_value_id" is not null and "special_state" is null) or ("value_kind" = 'SPECIAL' and "text_value" is null and "numeric_value" is null and "unit" is null and "controlled_attribute_value_id" is null and "special_state" in ('UNKNOWN', 'NOT_APPLICABLE', 'NONE')))
);
--> statement-breakpoint
ALTER TABLE "catalog"."attribute_value_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."attribute_value_revisions" (
	"tenant_id" uuid,
	"attribute_value_set_id" uuid,
	"revision" integer,
	"change_kind" text NOT NULL,
	"value_snapshot" jsonb NOT NULL,
	"reason" text NOT NULL,
	"evidence_refs" text[] NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_attribute_value_revisions_pk" PRIMARY KEY("tenant_id","attribute_value_set_id","revision"),
	CONSTRAINT "catalog_attribute_value_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_attribute_value_revisions_number_ck" CHECK ("revision" > 0),
	CONSTRAINT "catalog_attribute_value_revisions_kind_ck" CHECK ("change_kind" in ('SET', 'REMOVED')),
	CONSTRAINT "catalog_attribute_value_revisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "catalog"."attribute_value_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."attribute_value_sets" (
	"attribute_value_set_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid,
	"attribute_definition_id" uuid NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_attribute_value_sets_scope_id_uk" UNIQUE("tenant_id","attribute_value_set_id"),
	CONSTRAINT "catalog_attribute_value_sets_revision_ck" CHECK ("current_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "catalog"."attribute_value_sets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."product_variant_axes" (
	"tenant_id" uuid,
	"product_id" uuid,
	"attribute_definition_id" uuid,
	"axis_revision" integer NOT NULL,
	"ordinal" integer NOT NULL,
	CONSTRAINT "catalog_product_variant_axes_pk" PRIMARY KEY("tenant_id","product_id","attribute_definition_id"),
	CONSTRAINT "catalog_product_variant_axes_ordinal_uk" UNIQUE("tenant_id","product_id","ordinal"),
	CONSTRAINT "catalog_product_variant_axes_revision_ck" CHECK ("axis_revision" > 0 and "ordinal" >= 0)
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_variant_axes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."product_variant_axis_events" (
	"tenant_id" uuid,
	"product_id" uuid,
	"axis_revision" integer,
	"attribute_definition_ids" uuid[] NOT NULL,
	"reason" text NOT NULL,
	"evidence_refs" text[] NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_product_variant_axis_events_pk" PRIMARY KEY("tenant_id","product_id","axis_revision"),
	CONSTRAINT "catalog_product_variant_axis_events_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_product_variant_axis_events_revision_ck" CHECK ("axis_revision" > 0),
	CONSTRAINT "catalog_product_variant_axis_events_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_variant_axis_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."product_variant_revisions" (
	"tenant_id" uuid,
	"variant_id" uuid,
	"product_id" uuid NOT NULL,
	"revision" integer,
	"lifecycle_state" text NOT NULL,
	"combination_key" text,
	"combination_axis_revision" integer,
	"change_kind" text NOT NULL,
	"reason" text NOT NULL,
	"evidence_refs" text[] NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_product_variant_revisions_pk" PRIMARY KEY("tenant_id","variant_id","revision"),
	CONSTRAINT "catalog_product_variant_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_product_variant_revisions_number_ck" CHECK ("revision" > 0),
	CONSTRAINT "catalog_product_variant_revisions_lifecycle_ck" CHECK ("lifecycle_state" in ('WORK_IN_PROGRESS', 'ACTIVE', 'RETIRED')),
	CONSTRAINT "catalog_product_variant_revisions_kind_ck" CHECK ("change_kind" in ('CREATED', 'CORRECTED', 'LIFECYCLE', 'PARENT_CORRECTION', 'AXIS_REVALIDATION')),
	CONSTRAINT "catalog_product_variant_revisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_variant_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "catalog"."product_variants" ADD COLUMN "current_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog"."product_variants" ADD COLUMN "combination_key" text;--> statement-breakpoint
ALTER TABLE "catalog"."product_variants" ADD COLUMN "combination_axis_revision" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_attribute_value_sets_product_uk" ON "catalog"."attribute_value_sets" ("tenant_id","product_id","attribute_definition_id") WHERE "variant_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_attribute_value_sets_variant_uk" ON "catalog"."attribute_value_sets" ("tenant_id","variant_id","attribute_definition_id") WHERE "variant_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_product_variants_active_combination_uk" ON "catalog"."product_variants" ("tenant_id","product_id","combination_key") WHERE "lifecycle_state" = 'ACTIVE';--> statement-breakpoint
ALTER TABLE "catalog"."attribute_value_items" ADD CONSTRAINT "catalog_attribute_value_items_set_fk" FOREIGN KEY ("tenant_id","attribute_value_set_id") REFERENCES "catalog"."attribute_value_sets"("tenant_id","attribute_value_set_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "catalog"."attribute_value_items" ADD CONSTRAINT "catalog_attribute_value_items_controlled_fk" FOREIGN KEY ("tenant_id","attribute_definition_id","controlled_attribute_value_id") REFERENCES "catalog"."controlled_attribute_values"("tenant_id","attribute_definition_id","controlled_attribute_value_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."attribute_value_revisions" ADD CONSTRAINT "catalog_attribute_value_revisions_set_fk" FOREIGN KEY ("tenant_id","attribute_value_set_id") REFERENCES "catalog"."attribute_value_sets"("tenant_id","attribute_value_set_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."attribute_value_sets" ADD CONSTRAINT "catalog_attribute_value_sets_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "catalog"."products"("tenant_id","product_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."attribute_value_sets" ADD CONSTRAINT "catalog_attribute_value_sets_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "catalog"."product_variants"("tenant_id","product_id","variant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."attribute_value_sets" ADD CONSTRAINT "catalog_attribute_value_sets_definition_fk" FOREIGN KEY ("tenant_id","attribute_definition_id") REFERENCES "catalog"."attribute_definitions"("tenant_id","attribute_definition_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_variant_axes" ADD CONSTRAINT "catalog_product_variant_axes_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "catalog"."products"("tenant_id","product_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_variant_axes" ADD CONSTRAINT "catalog_product_variant_axes_definition_fk" FOREIGN KEY ("tenant_id","attribute_definition_id") REFERENCES "catalog"."attribute_definitions"("tenant_id","attribute_definition_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_variant_axis_events" ADD CONSTRAINT "catalog_product_variant_axis_events_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "catalog"."products"("tenant_id","product_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_variant_revisions" ADD CONSTRAINT "catalog_product_variant_revisions_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "catalog"."product_variants"("tenant_id","variant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_variants" ADD CONSTRAINT "catalog_product_variants_revision_ck" CHECK ("current_revision" > 0);--> statement-breakpoint
ALTER TABLE "catalog"."product_variants" ADD CONSTRAINT "catalog_product_variants_axis_revision_ck" CHECK ("combination_axis_revision" is null or "combination_axis_revision" > 0);--> statement-breakpoint
ALTER TABLE "catalog"."product_variants" ADD CONSTRAINT "catalog_product_variants_combination_ck" CHECK (("lifecycle_state" = 'ACTIVE' and "combination_key" is not null and "combination_axis_revision" is not null and length("combination_key") = 64 and "combination_key" ~ '^[0-9a-f]{64}$') or ("lifecycle_state" <> 'ACTIVE' and "combination_key" is null and "combination_axis_revision" is null)) NOT VALID;--> statement-breakpoint
CREATE POLICY "catalog_attribute_value_items_tenant_select" ON "catalog"."attribute_value_items" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."attribute_value_items"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_attribute_value_items_tenant_insert" ON "catalog"."attribute_value_items" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."attribute_value_items"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_attribute_value_items_tenant_update" ON "catalog"."attribute_value_items" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."attribute_value_items"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."attribute_value_items"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_attribute_value_items_tenant_delete" ON "catalog"."attribute_value_items" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."attribute_value_items"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_attribute_value_revisions_tenant_select" ON "catalog"."attribute_value_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."attribute_value_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_attribute_value_revisions_tenant_insert" ON "catalog"."attribute_value_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."attribute_value_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_attribute_value_revisions_tenant_update" ON "catalog"."attribute_value_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."attribute_value_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."attribute_value_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_attribute_value_revisions_tenant_delete" ON "catalog"."attribute_value_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."attribute_value_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_attribute_value_sets_tenant_select" ON "catalog"."attribute_value_sets" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."attribute_value_sets"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_attribute_value_sets_tenant_insert" ON "catalog"."attribute_value_sets" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."attribute_value_sets"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_attribute_value_sets_tenant_update" ON "catalog"."attribute_value_sets" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."attribute_value_sets"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."attribute_value_sets"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_attribute_value_sets_tenant_delete" ON "catalog"."attribute_value_sets" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."attribute_value_sets"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_variant_axes_tenant_select" ON "catalog"."product_variant_axes" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_variant_axes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_variant_axes_tenant_insert" ON "catalog"."product_variant_axes" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_variant_axes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_variant_axes_tenant_update" ON "catalog"."product_variant_axes" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_variant_axes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_variant_axes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_variant_axes_tenant_delete" ON "catalog"."product_variant_axes" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_variant_axes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_variant_axis_events_tenant_select" ON "catalog"."product_variant_axis_events" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_variant_axis_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_variant_axis_events_tenant_insert" ON "catalog"."product_variant_axis_events" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_variant_axis_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_variant_axis_events_tenant_update" ON "catalog"."product_variant_axis_events" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_variant_axis_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_variant_axis_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_variant_axis_events_tenant_delete" ON "catalog"."product_variant_axis_events" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_variant_axis_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_variant_revisions_tenant_select" ON "catalog"."product_variant_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_variant_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_variant_revisions_tenant_insert" ON "catalog"."product_variant_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_variant_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_variant_revisions_tenant_update" ON "catalog"."product_variant_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_variant_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_variant_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_variant_revisions_tenant_delete" ON "catalog"."product_variant_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_variant_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- Drizzle owns policies but PostgreSQL FORCE RLS is part of the owner boundary.
ALTER TABLE "catalog"."attribute_value_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."attribute_value_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."attribute_value_sets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."product_variant_axes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."product_variant_axis_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."product_variant_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "catalog_attribute_value_revisions_append_only"
BEFORE UPDATE OR DELETE ON "catalog"."attribute_value_revisions"
FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "catalog_product_variant_axis_events_append_only"
BEFORE UPDATE OR DELETE ON "catalog"."product_variant_axis_events"
FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "catalog_product_variant_revisions_append_only"
BEFORE UPDATE OR DELETE ON "catalog"."product_variant_revisions"
FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
-- An assignment is only Current when it equals the latest immutable event.
-- Both sides use deferred triggers so an Action may append then project (or vice versa).
CREATE FUNCTION "catalog"."enforce_product_type_assignment_pointer"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  target_tenant uuid;
  target_product uuid;
  latest record;
  current_row record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_tenant := OLD.tenant_id;
    target_product := OLD.product_id;
  ELSE
    target_tenant := NEW.tenant_id;
    target_product := NEW.product_id;
  END IF;
  SELECT e.assignment_revision, e.next_product_type_id INTO latest
  FROM catalog.product_type_assignment_events e
  WHERE e.tenant_id = target_tenant AND e.product_id = target_product
  ORDER BY e.assignment_revision DESC LIMIT 1;
  SELECT a.assignment_revision, a.product_type_id INTO current_row
  FROM catalog.product_type_assignments a
  WHERE a.tenant_id = target_tenant AND a.product_id = target_product;
  IF latest IS NULL THEN
    IF current_row IS NOT NULL THEN
      RAISE EXCEPTION 'Catalog Product Type assignment lacks history' USING ERRCODE = '23514';
    END IF;
  ELSIF latest.next_product_type_id IS NULL THEN
    IF current_row IS NOT NULL THEN
      RAISE EXCEPTION 'Catalog Product Type removal pointer is stale' USING ERRCODE = '23514';
    END IF;
  ELSIF current_row IS NULL
    OR current_row.assignment_revision IS DISTINCT FROM latest.assignment_revision
    OR current_row.product_type_id IS DISTINCT FROM latest.next_product_type_id THEN
    RAISE EXCEPTION 'Catalog Product Type assignment pointer is stale' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "catalog_product_type_assignment_current_pointer"
AFTER INSERT OR UPDATE OR DELETE ON "catalog"."product_type_assignments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "catalog"."enforce_product_type_assignment_pointer"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "catalog_product_type_assignment_event_pointer"
AFTER INSERT ON "catalog"."product_type_assignment_events"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "catalog"."enforce_product_type_assignment_pointer"();
--> statement-breakpoint
REVOKE ALL ON FUNCTION "catalog"."enforce_product_type_assignment_pointer"() FROM PUBLIC;
--> statement-breakpoint
-- Existing Product creation already produced an explicit working Variant before
-- this ledger existed. Preserve its original creation attestation as revision 1.
INSERT INTO "catalog"."product_variant_revisions" (
  "tenant_id", "variant_id", "product_id", "revision", "lifecycle_state",
  "combination_key", "combination_axis_revision", "change_kind", "reason",
  "evidence_refs", "action_invocation_id", "acting_principal_id", "recorded_at"
)
SELECT v."tenant_id", v."variant_id", v."product_id", 1, v."lifecycle_state",
  v."combination_key", v."combination_axis_revision", 'CREATED',
  'Historical explicit Variant foundation', ARRAY[]::text[],
  v."created_by_action_invocation_id", v."created_by_principal_id", v."created_at"
FROM "catalog"."product_variants" v;
