CREATE TABLE "catalog"."attribute_definition_revisions" (
	"attribute_definition_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"attribute_definition_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"name" text NOT NULL,
	"value_kind" text NOT NULL,
	"multiplicity" text NOT NULL,
	"measured_quantity" text,
	"canonical_unit" text,
	"minimum_value" numeric,
	"maximum_value" numeric,
	"decimal_places" integer,
	"allows_unknown" integer NOT NULL,
	"allows_not_applicable" integer NOT NULL,
	"reason" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"evidence_refs" text[] NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_attribute_definition_revisions_number_uk" UNIQUE("tenant_id","attribute_definition_id","revision"),
	CONSTRAINT "catalog_attribute_definition_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_attribute_definition_revisions_number_ck" CHECK ("revision" > 0),
	CONSTRAINT "catalog_attribute_definition_revisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "catalog"."attribute_definition_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."attribute_definitions" (
	"attribute_definition_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"name" text NOT NULL,
	"value_kind" text NOT NULL,
	"multiplicity" text NOT NULL,
	"measured_quantity" text,
	"canonical_unit" text,
	"minimum_value" numeric,
	"maximum_value" numeric,
	"decimal_places" integer,
	"allows_unknown" integer DEFAULT 0 NOT NULL,
	"allows_not_applicable" integer DEFAULT 0 NOT NULL,
	"created_by_action_invocation_id" uuid NOT NULL,
	"created_by_principal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_attribute_definitions_scope_id_uk" UNIQUE("tenant_id","attribute_definition_id"),
	CONSTRAINT "catalog_attribute_definitions_revision_ck" CHECK ("current_revision" > 0),
	CONSTRAINT "catalog_attribute_definitions_kind_ck" CHECK ("value_kind" in ('TEXT', 'CONTROLLED', 'MEASUREMENT')),
	CONSTRAINT "catalog_attribute_definitions_multiplicity_ck" CHECK ("multiplicity" in ('SINGLE', 'MULTIPLE')),
	CONSTRAINT "catalog_attribute_definitions_name_ck" CHECK ("name" = btrim("name") and length("name") between 1 and 240),
	CONSTRAINT "catalog_attribute_definitions_measurement_ck" CHECK (("value_kind" = 'MEASUREMENT' and "measured_quantity" is not null and "canonical_unit" is not null and "decimal_places" is not null) or ("value_kind" <> 'MEASUREMENT' and "measured_quantity" is null and "canonical_unit" is null and "minimum_value" is null and "maximum_value" is null and "decimal_places" is null)),
	CONSTRAINT "catalog_attribute_definitions_range_ck" CHECK ("minimum_value" is null or "maximum_value" is null or "minimum_value" <= "maximum_value"),
	CONSTRAINT "catalog_attribute_definitions_precision_ck" CHECK ("decimal_places" is null or "decimal_places" between 0 and 12),
	CONSTRAINT "catalog_attribute_definitions_special_ck" CHECK ("allows_unknown" in (0, 1) and "allows_not_applicable" in (0, 1))
);
--> statement-breakpoint
ALTER TABLE "catalog"."attribute_definitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."controlled_attribute_value_revisions" (
	"controlled_attribute_value_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"controlled_attribute_value_id" uuid NOT NULL,
	"attribute_definition_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"name" text NOT NULL,
	"lifecycle_state" text NOT NULL,
	"color_group" text,
	"preview_hex" text,
	"preview_evidence_ref" text,
	"reason" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"evidence_refs" text[] NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_controlled_value_revisions_number_uk" UNIQUE("tenant_id","controlled_attribute_value_id","revision"),
	CONSTRAINT "catalog_controlled_value_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_controlled_value_revisions_number_ck" CHECK ("revision" > 0),
	CONSTRAINT "catalog_controlled_value_revisions_lifecycle_ck" CHECK ("lifecycle_state" in ('ACTIVE', 'RETIRED')),
	CONSTRAINT "catalog_controlled_value_revisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "catalog"."controlled_attribute_value_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."controlled_attribute_values" (
	"controlled_attribute_value_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"attribute_definition_id" uuid NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"name" text NOT NULL,
	"lifecycle_state" text DEFAULT 'ACTIVE' NOT NULL,
	"color_group" text,
	"preview_hex" text,
	"preview_evidence_ref" text,
	"created_by_action_invocation_id" uuid NOT NULL,
	"created_by_principal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_controlled_values_scope_id_uk" UNIQUE("tenant_id","controlled_attribute_value_id"),
	CONSTRAINT "catalog_controlled_values_definition_id_uk" UNIQUE("tenant_id","attribute_definition_id","controlled_attribute_value_id"),
	CONSTRAINT "catalog_controlled_values_revision_ck" CHECK ("current_revision" > 0),
	CONSTRAINT "catalog_controlled_values_name_ck" CHECK ("name" = btrim("name") and length("name") between 1 and 240),
	CONSTRAINT "catalog_controlled_values_lifecycle_ck" CHECK ("lifecycle_state" in ('ACTIVE', 'RETIRED')),
	CONSTRAINT "catalog_controlled_values_preview_ck" CHECK ("preview_hex" is null or "preview_hex" ~ '^#[0-9A-Fa-f]{6}$')
);
--> statement-breakpoint
ALTER TABLE "catalog"."controlled_attribute_values" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "catalog"."attribute_definition_revisions" ADD CONSTRAINT "catalog_attribute_definition_revisions_definition_fk" FOREIGN KEY ("tenant_id","attribute_definition_id") REFERENCES "catalog"."attribute_definitions"("tenant_id","attribute_definition_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."controlled_attribute_value_revisions" ADD CONSTRAINT "catalog_controlled_value_revisions_value_fk" FOREIGN KEY ("tenant_id","attribute_definition_id","controlled_attribute_value_id") REFERENCES "catalog"."controlled_attribute_values"("tenant_id","attribute_definition_id","controlled_attribute_value_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."controlled_attribute_values" ADD CONSTRAINT "catalog_controlled_values_definition_fk" FOREIGN KEY ("tenant_id","attribute_definition_id") REFERENCES "catalog"."attribute_definitions"("tenant_id","attribute_definition_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_type_revision_attributes" ADD CONSTRAINT "catalog_product_type_revision_attributes_definition_fk" FOREIGN KEY ("tenant_id","attribute_definition_id") REFERENCES "catalog"."attribute_definitions"("tenant_id","attribute_definition_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "catalog_attribute_definition_revisions_tenant_select" ON "catalog"."attribute_definition_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."attribute_definition_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_attribute_definition_revisions_tenant_insert" ON "catalog"."attribute_definition_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."attribute_definition_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_attribute_definition_revisions_tenant_update" ON "catalog"."attribute_definition_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."attribute_definition_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."attribute_definition_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_attribute_definition_revisions_tenant_delete" ON "catalog"."attribute_definition_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."attribute_definition_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_attribute_definitions_tenant_select" ON "catalog"."attribute_definitions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."attribute_definitions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_attribute_definitions_tenant_insert" ON "catalog"."attribute_definitions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."attribute_definitions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_attribute_definitions_tenant_update" ON "catalog"."attribute_definitions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."attribute_definitions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."attribute_definitions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_attribute_definitions_tenant_delete" ON "catalog"."attribute_definitions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."attribute_definitions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_controlled_value_revisions_tenant_select" ON "catalog"."controlled_attribute_value_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."controlled_attribute_value_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_controlled_value_revisions_tenant_insert" ON "catalog"."controlled_attribute_value_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."controlled_attribute_value_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_controlled_value_revisions_tenant_update" ON "catalog"."controlled_attribute_value_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."controlled_attribute_value_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."controlled_attribute_value_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_controlled_value_revisions_tenant_delete" ON "catalog"."controlled_attribute_value_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."controlled_attribute_value_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_controlled_values_tenant_select" ON "catalog"."controlled_attribute_values" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."controlled_attribute_values"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_controlled_values_tenant_insert" ON "catalog"."controlled_attribute_values" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."controlled_attribute_values"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_controlled_values_tenant_update" ON "catalog"."controlled_attribute_values" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."controlled_attribute_values"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."controlled_attribute_values"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_controlled_values_tenant_delete" ON "catalog"."controlled_attribute_values" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."controlled_attribute_values"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "catalog"."attribute_definitions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."attribute_definition_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."controlled_attribute_values" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."controlled_attribute_value_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "catalog_attribute_definition_revisions_append_only"
BEFORE UPDATE OR DELETE ON "catalog"."attribute_definition_revisions"
FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "catalog_controlled_value_revisions_append_only"
BEFORE UPDATE OR DELETE ON "catalog"."controlled_attribute_value_revisions"
FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE FUNCTION "catalog"."protect_attribute_identity"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'catalog attribute identities cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."attribute_definition_id" IS DISTINCT FROM OLD."attribute_definition_id"
    OR NEW."created_by_action_invocation_id" IS DISTINCT FROM OLD."created_by_action_invocation_id"
    OR NEW."created_by_principal_id" IS DISTINCT FROM OLD."created_by_principal_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR NEW."current_revision" <> OLD."current_revision" + 1 THEN
    RAISE EXCEPTION 'catalog attribute identity and revision progression are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "catalog_attribute_definitions_identity_immutable"
BEFORE UPDATE OR DELETE ON "catalog"."attribute_definitions"
FOR EACH ROW EXECUTE FUNCTION "catalog"."protect_attribute_identity"();
--> statement-breakpoint
CREATE FUNCTION "catalog"."protect_controlled_value_identity"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'catalog controlled values cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."attribute_definition_id" IS DISTINCT FROM OLD."attribute_definition_id"
    OR NEW."controlled_attribute_value_id" IS DISTINCT FROM OLD."controlled_attribute_value_id"
    OR NEW."created_by_action_invocation_id" IS DISTINCT FROM OLD."created_by_action_invocation_id"
    OR NEW."created_by_principal_id" IS DISTINCT FROM OLD."created_by_principal_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR NEW."current_revision" <> OLD."current_revision" + 1 THEN
    RAISE EXCEPTION 'catalog controlled value identity and revision progression are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "catalog_controlled_values_identity_immutable"
BEFORE UPDATE OR DELETE ON "catalog"."controlled_attribute_values"
FOR EACH ROW EXECUTE FUNCTION "catalog"."protect_controlled_value_identity"();
