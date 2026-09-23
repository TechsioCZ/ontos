CREATE TABLE "catalog"."set_composition_components" (
	"tenant_id" uuid,
	"composition_id" uuid,
	"revision" integer,
	"component_id" uuid,
	"component_product_id" uuid NOT NULL,
	"component_variant_id" uuid NOT NULL,
	"package_definition_id" uuid,
	"package_content_revision" integer,
	"configuration" jsonb,
	"quantity_amount" numeric NOT NULL,
	"quantity_unit_id" uuid NOT NULL,
	CONSTRAINT "catalog_set_composition_components_pk" PRIMARY KEY("tenant_id","composition_id","revision","component_id"),
	CONSTRAINT "catalog_set_composition_components_quantity_ck" CHECK ("quantity_amount" > 0),
	CONSTRAINT "catalog_set_composition_components_package_pair_ck" CHECK (("package_definition_id" is null and "package_content_revision" is null) or ("package_definition_id" is not null and "package_content_revision" > 0))
);
--> statement-breakpoint
ALTER TABLE "catalog"."set_composition_components" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."set_composition_revisions" (
	"tenant_id" uuid,
	"composition_id" uuid,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"revision" integer,
	"predecessor_revision" integer,
	"lifecycle_state" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"change_kind" text NOT NULL,
	"reason" text NOT NULL,
	"evidence_refs" text[] NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_set_composition_revisions_pk" PRIMARY KEY("tenant_id","composition_id","revision"),
	CONSTRAINT "catalog_set_composition_revisions_target_uk" UNIQUE("tenant_id","product_id","variant_id","composition_id","revision"),
	CONSTRAINT "catalog_set_composition_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_set_composition_revisions_number_ck" CHECK ("revision" > 0),
	CONSTRAINT "catalog_set_composition_revisions_predecessor_ck" CHECK (("revision" = 1 and "predecessor_revision" is null) or ("revision" > 1 and "predecessor_revision" = "revision" - 1)),
	CONSTRAINT "catalog_set_composition_revisions_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from"),
	CONSTRAINT "catalog_set_composition_revisions_state_ck" CHECK ("lifecycle_state" in ('DRAFT', 'ACTIVE', 'RETIRED')),
	CONSTRAINT "catalog_set_composition_revisions_kind_ck" CHECK ("change_kind" in ('INITIAL', 'MATERIAL_CHANGE', 'EVIDENCE_CORRECTION')),
	CONSTRAINT "catalog_set_composition_revisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "catalog"."set_composition_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."set_compositions" (
	"composition_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"current_revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_set_compositions_scope_id_uk" UNIQUE("tenant_id","composition_id"),
	CONSTRAINT "catalog_set_compositions_variant_uk" UNIQUE("tenant_id","product_id","variant_id"),
	CONSTRAINT "catalog_set_compositions_target_uk" UNIQUE("tenant_id","product_id","variant_id","composition_id"),
	CONSTRAINT "catalog_set_compositions_revision_ck" CHECK ("current_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "catalog"."set_compositions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "catalog"."package_content_revisions" ADD CONSTRAINT "catalog_package_content_revisions_set_revision_fk" FOREIGN KEY ("tenant_id","product_id","variant_id","set_composition_resource_id","set_composition_revision") REFERENCES "catalog"."set_composition_revisions"("tenant_id","product_id","variant_id","composition_id","revision") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."set_composition_components" ADD CONSTRAINT "catalog_set_composition_components_revision_fk" FOREIGN KEY ("tenant_id","composition_id","revision") REFERENCES "catalog"."set_composition_revisions"("tenant_id","composition_id","revision") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."set_composition_components" ADD CONSTRAINT "catalog_set_composition_components_variant_fk" FOREIGN KEY ("tenant_id","component_product_id","component_variant_id") REFERENCES "catalog"."product_variants"("tenant_id","product_id","variant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."set_composition_components" ADD CONSTRAINT "catalog_set_composition_components_package_fk" FOREIGN KEY ("tenant_id","component_product_id","component_variant_id","package_definition_id") REFERENCES "catalog"."package_definitions"("tenant_id","product_id","variant_id","package_definition_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."set_composition_components" ADD CONSTRAINT "catalog_set_composition_components_package_revision_fk" FOREIGN KEY ("tenant_id","package_definition_id","package_content_revision") REFERENCES "catalog"."package_content_revisions"("tenant_id","package_definition_id","revision") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."set_composition_components" ADD CONSTRAINT "catalog_set_composition_components_unit_fk" FOREIGN KEY ("tenant_id","quantity_unit_id") REFERENCES "catalog"."product_units"("tenant_id","unit_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."set_composition_revisions" ADD CONSTRAINT "catalog_set_composition_revisions_composition_fk" FOREIGN KEY ("tenant_id","product_id","variant_id","composition_id") REFERENCES "catalog"."set_compositions"("tenant_id","product_id","variant_id","composition_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."set_composition_revisions" ADD CONSTRAINT "catalog_set_composition_revisions_predecessor_fk" FOREIGN KEY ("tenant_id","composition_id","predecessor_revision") REFERENCES "catalog"."set_composition_revisions"("tenant_id","composition_id","revision") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."set_compositions" ADD CONSTRAINT "catalog_set_compositions_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "catalog"."product_variants"("tenant_id","product_id","variant_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "catalog_set_composition_components_tenant_select" ON "catalog"."set_composition_components" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."set_composition_components"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_set_composition_components_tenant_insert" ON "catalog"."set_composition_components" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."set_composition_components"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_set_composition_components_tenant_update" ON "catalog"."set_composition_components" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."set_composition_components"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."set_composition_components"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_set_composition_components_tenant_delete" ON "catalog"."set_composition_components" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."set_composition_components"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_set_composition_revisions_tenant_select" ON "catalog"."set_composition_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."set_composition_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_set_composition_revisions_tenant_insert" ON "catalog"."set_composition_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."set_composition_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_set_composition_revisions_tenant_update" ON "catalog"."set_composition_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."set_composition_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."set_composition_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_set_composition_revisions_tenant_delete" ON "catalog"."set_composition_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."set_composition_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_set_compositions_tenant_select" ON "catalog"."set_compositions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."set_compositions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_set_compositions_tenant_insert" ON "catalog"."set_compositions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."set_compositions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_set_compositions_tenant_update" ON "catalog"."set_compositions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."set_compositions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."set_compositions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_set_compositions_tenant_delete" ON "catalog"."set_compositions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."set_compositions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "catalog"."set_composition_components" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."set_composition_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."set_compositions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "catalog_set_composition_revisions_append_only" BEFORE UPDATE OR DELETE ON "catalog"."set_composition_revisions" FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "catalog_set_composition_components_append_only" BEFORE UPDATE OR DELETE ON "catalog"."set_composition_components" FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE FUNCTION "catalog"."protect_set_composition_identity"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'catalog set composition identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.composition_id IS DISTINCT FROM OLD.composition_id
    OR NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.variant_id IS DISTINCT FROM OLD.variant_id
    OR NEW.current_revision < OLD.current_revision THEN
    RAISE EXCEPTION 'catalog set composition identity or revision progression is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "catalog_set_compositions_identity_immutable" BEFORE UPDATE OR DELETE ON "catalog"."set_compositions" FOR EACH ROW EXECUTE FUNCTION "catalog"."protect_set_composition_identity"();
--> statement-breakpoint
CREATE FUNCTION "catalog"."reject_nested_set_composition"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'set_composition_components' THEN
    IF EXISTS (SELECT 1 FROM catalog.set_compositions s WHERE s.tenant_id = NEW.tenant_id AND s.variant_id = NEW.component_variant_id)
      OR EXISTS (SELECT 1 FROM catalog.package_content_revisions p WHERE p.tenant_id = NEW.tenant_id
        AND p.package_definition_id = NEW.package_definition_id AND p.revision = NEW.package_content_revision
        AND p.set_composition_resource_id IS NOT NULL) THEN
      RAISE EXCEPTION 'nested Catalog Set composition is forbidden' USING ERRCODE = '23514';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM catalog.set_composition_components c WHERE c.tenant_id = NEW.tenant_id AND c.component_variant_id = NEW.variant_id) THEN
    RAISE EXCEPTION 'a Set component cannot become a Set' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "catalog_set_composition_components_no_nested_set" BEFORE INSERT ON "catalog"."set_composition_components" FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_nested_set_composition"();
--> statement-breakpoint
CREATE TRIGGER "catalog_set_compositions_no_nested_set" BEFORE INSERT ON "catalog"."set_compositions" FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_nested_set_composition"();
--> statement-breakpoint
CREATE FUNCTION "catalog"."validate_set_composition_current"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM catalog.set_composition_revisions r
    WHERE r.tenant_id = NEW.tenant_id AND r.composition_id = NEW.composition_id
      AND r.product_id = NEW.product_id AND r.variant_id = NEW.variant_id
      AND r.revision = NEW.current_revision AND r.effective_from <= now()
      AND (r.effective_to IS NULL OR r.effective_to > now())
      AND (r.lifecycle_state <> 'ACTIVE' OR (
        SELECT count(*) FROM catalog.set_composition_components c
        WHERE c.tenant_id = r.tenant_id AND c.composition_id = r.composition_id AND c.revision = r.revision
      ) >= 2)
  ) THEN
    RAISE EXCEPTION 'Catalog Set current revision is absent, ineffective, or incomplete' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "catalog_set_compositions_current_revision_valid" AFTER INSERT OR UPDATE ON "catalog"."set_compositions" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "catalog"."validate_set_composition_current"();
