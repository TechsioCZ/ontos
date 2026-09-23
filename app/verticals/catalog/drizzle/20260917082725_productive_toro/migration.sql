CREATE TABLE "catalog"."package_content_revisions" (
	"tenant_id" uuid,
	"package_definition_id" uuid,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"revision" integer,
	"lifecycle_state" text NOT NULL,
	"amount" numeric NOT NULL,
	"unit_resource_type" text NOT NULL,
	"unit_resource_id" uuid NOT NULL,
	"configuration_key" text,
	"effective_at" timestamp with time zone NOT NULL,
	"lower_package_definition_id" uuid,
	"lower_revision" integer,
	"lower_count" numeric,
	"set_composition_resource_id" uuid,
	"set_composition_revision" integer,
	"reason" text NOT NULL,
	"evidence_refs" text[] NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_package_content_revisions_pk" PRIMARY KEY("tenant_id","package_definition_id","revision"),
	CONSTRAINT "catalog_package_content_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_package_content_revisions_number_ck" CHECK ("revision" > 0),
	CONSTRAINT "catalog_package_content_revisions_state_ck" CHECK ("lifecycle_state" in ('DRAFT', 'ACTIVE', 'RETIRED')),
	CONSTRAINT "catalog_package_content_revisions_amount_ck" CHECK ("amount" > 0),
	CONSTRAINT "catalog_package_content_revisions_unit_ck" CHECK ("unit_resource_type" = 'commerce.catalog.unit'),
	CONSTRAINT "catalog_package_content_revisions_configuration_ck" CHECK ("configuration_key" is null or ("configuration_key" = btrim("configuration_key") and length("configuration_key") between 1 and 300)),
	CONSTRAINT "catalog_package_content_revisions_lower_ck" CHECK (("lower_package_definition_id" is null and "lower_revision" is null and "lower_count" is null) or ("lower_package_definition_id" is not null and "lower_revision" is not null and "lower_revision" > 0 and "lower_count" is not null and "lower_count" > 0 and "lower_count" = trunc("lower_count") and "lower_package_definition_id" <> "package_definition_id")),
	CONSTRAINT "catalog_package_content_revisions_set_ck" CHECK (("set_composition_resource_id" is null and "set_composition_revision" is null) or ("set_composition_resource_id" is not null and "set_composition_revision" is not null and "set_composition_revision" > 0)),
	CONSTRAINT "catalog_package_content_revisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "catalog"."package_content_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."package_definitions" (
	"package_definition_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"lifecycle_state" text DEFAULT 'DRAFT' NOT NULL,
	"option_state" text DEFAULT 'NOT_SELECTABLE' NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"created_by_action_invocation_id" uuid NOT NULL,
	"created_by_principal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_package_definitions_scope_id_uk" UNIQUE("tenant_id","package_definition_id"),
	CONSTRAINT "catalog_package_definitions_form_id_uk" UNIQUE("tenant_id","product_id","variant_id","package_definition_id"),
	CONSTRAINT "catalog_package_definitions_revision_ck" CHECK ("current_revision" > 0),
	CONSTRAINT "catalog_package_definitions_state_ck" CHECK ("lifecycle_state" in ('DRAFT', 'ACTIVE', 'RETIRED')),
	CONSTRAINT "catalog_package_definitions_option_ck" CHECK ("option_state" in ('NOT_SELECTABLE', 'ACTIVE', 'RETIRED'))
);
--> statement-breakpoint
ALTER TABLE "catalog"."package_definitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "catalog_package_content_revisions_effective_idx" ON "catalog"."package_content_revisions" ("tenant_id","package_definition_id","effective_at");--> statement-breakpoint
CREATE INDEX "catalog_package_definitions_variant_idx" ON "catalog"."package_definitions" ("tenant_id","product_id","variant_id");--> statement-breakpoint
ALTER TABLE "catalog"."package_content_revisions" ADD CONSTRAINT "catalog_package_content_revisions_definition_fk" FOREIGN KEY ("tenant_id","product_id","variant_id","package_definition_id") REFERENCES "catalog"."package_definitions"("tenant_id","product_id","variant_id","package_definition_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."package_content_revisions" ADD CONSTRAINT "catalog_package_content_revisions_lower_form_fk" FOREIGN KEY ("tenant_id","product_id","variant_id","lower_package_definition_id") REFERENCES "catalog"."package_definitions"("tenant_id","product_id","variant_id","package_definition_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."package_content_revisions" ADD CONSTRAINT "catalog_package_content_revisions_lower_revision_fk" FOREIGN KEY ("tenant_id","lower_package_definition_id","lower_revision") REFERENCES "catalog"."package_content_revisions"("tenant_id","package_definition_id","revision") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."package_definitions" ADD CONSTRAINT "catalog_package_definitions_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "catalog"."product_variants"("tenant_id","product_id","variant_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "catalog_package_content_revisions_tenant_select" ON "catalog"."package_content_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."package_content_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_package_content_revisions_tenant_insert" ON "catalog"."package_content_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."package_content_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_package_content_revisions_tenant_update" ON "catalog"."package_content_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."package_content_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."package_content_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_package_content_revisions_tenant_delete" ON "catalog"."package_content_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."package_content_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_package_definitions_tenant_select" ON "catalog"."package_definitions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."package_definitions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_package_definitions_tenant_insert" ON "catalog"."package_definitions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."package_definitions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_package_definitions_tenant_update" ON "catalog"."package_definitions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."package_definitions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."package_definitions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_package_definitions_tenant_delete" ON "catalog"."package_definitions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."package_definitions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "catalog"."package_definitions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."package_content_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "catalog_package_content_revisions_append_only"
BEFORE UPDATE OR DELETE ON "catalog"."package_content_revisions"
FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE FUNCTION "catalog"."protect_package_definition_identity"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR NEW."package_definition_id" IS DISTINCT FROM OLD."package_definition_id"
    OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."product_id" IS DISTINCT FROM OLD."product_id"
    OR NEW."variant_id" IS DISTINCT FROM OLD."variant_id"
    OR NEW."created_by_action_invocation_id" IS DISTINCT FROM OLD."created_by_action_invocation_id"
    OR NEW."created_by_principal_id" IS DISTINCT FROM OLD."created_by_principal_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'catalog package definition identity and creation evidence are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "catalog_package_definitions_identity_immutable"
BEFORE UPDATE OR DELETE ON "catalog"."package_definitions"
FOR EACH ROW EXECUTE FUNCTION "catalog"."protect_package_definition_identity"();
