CREATE TABLE "catalog"."package_unit_divisibility" (
	"tenant_id" uuid,
	"package_definition_id" uuid,
	"unit_id" uuid NOT NULL,
	"current_revision" integer NOT NULL,
	"divisible" boolean NOT NULL,
	CONSTRAINT "catalog_package_unit_divisibility_pk" PRIMARY KEY("tenant_id","package_definition_id"),
	CONSTRAINT "catalog_package_unit_divisibility_revision_ck" CHECK ("current_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "catalog"."package_unit_divisibility" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."package_unit_divisibility_revisions" (
	"tenant_id" uuid,
	"package_definition_id" uuid,
	"revision" integer,
	"unit_id" uuid NOT NULL,
	"divisible" boolean NOT NULL,
	"reason" text NOT NULL,
	"evidence_refs" text[] NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_package_unit_divisibility_revisions_pk" PRIMARY KEY("tenant_id","package_definition_id","revision"),
	CONSTRAINT "catalog_package_unit_divisibility_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_package_unit_divisibility_revisions_number_ck" CHECK ("revision" > 0),
	CONSTRAINT "catalog_package_unit_divisibility_revisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "catalog"."package_unit_divisibility_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."product_unit_rule_revisions" (
	"tenant_id" uuid,
	"unit_id" uuid,
	"revision" integer,
	"step" numeric NOT NULL,
	"rounding" text NOT NULL,
	"lifecycle_state" text NOT NULL,
	"change_kind" text NOT NULL,
	"reason" text NOT NULL,
	"evidence_refs" text[] NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_product_unit_rule_revisions_pk" PRIMARY KEY("tenant_id","unit_id","revision"),
	CONSTRAINT "catalog_product_unit_rule_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_product_unit_rule_revisions_number_ck" CHECK ("revision" > 0),
	CONSTRAINT "catalog_product_unit_rule_revisions_step_ck" CHECK ("step" > 0),
	CONSTRAINT "catalog_product_unit_rule_revisions_rounding_ck" CHECK ("rounding" in ('UP', 'DOWN', 'HALF_UP')),
	CONSTRAINT "catalog_product_unit_rule_revisions_lifecycle_ck" CHECK ("lifecycle_state" in ('ACTIVE', 'RETIRED')),
	CONSTRAINT "catalog_product_unit_rule_revisions_kind_ck" CHECK ("change_kind" in ('CREATED', 'REVISED', 'RETIRED')),
	CONSTRAINT "catalog_product_unit_rule_revisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_unit_rule_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."product_units" (
	"unit_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"lifecycle_state" text NOT NULL,
	"current_rule_revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_product_units_scope_id_uk" UNIQUE("tenant_id","unit_id"),
	CONSTRAINT "catalog_product_units_code_uk" UNIQUE("tenant_id","code"),
	CONSTRAINT "catalog_product_units_revision_ck" CHECK ("current_rule_revision" > 0),
	CONSTRAINT "catalog_product_units_code_ck" CHECK ("code" = btrim("code") and length("code") between 1 and 80),
	CONSTRAINT "catalog_product_units_label_ck" CHECK ("label" = btrim("label") and length("label") between 1 and 240),
	CONSTRAINT "catalog_product_units_lifecycle_ck" CHECK ("lifecycle_state" in ('ACTIVE', 'RETIRED'))
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_units" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."variant_unit_divisibility" (
	"tenant_id" uuid,
	"variant_id" uuid,
	"unit_id" uuid NOT NULL,
	"current_revision" integer NOT NULL,
	"divisible" boolean NOT NULL,
	CONSTRAINT "catalog_variant_unit_divisibility_pk" PRIMARY KEY("tenant_id","variant_id"),
	CONSTRAINT "catalog_variant_unit_divisibility_revision_ck" CHECK ("current_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "catalog"."variant_unit_divisibility" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."variant_unit_divisibility_revisions" (
	"tenant_id" uuid,
	"variant_id" uuid,
	"revision" integer,
	"unit_id" uuid NOT NULL,
	"divisible" boolean NOT NULL,
	"reason" text NOT NULL,
	"evidence_refs" text[] NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_variant_unit_divisibility_revisions_pk" PRIMARY KEY("tenant_id","variant_id","revision"),
	CONSTRAINT "catalog_variant_unit_divisibility_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_variant_unit_divisibility_revisions_number_ck" CHECK ("revision" > 0),
	CONSTRAINT "catalog_variant_unit_divisibility_revisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "catalog"."variant_unit_divisibility_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "catalog"."package_content_revisions" ADD CONSTRAINT "catalog_package_content_revisions_unit_fk" FOREIGN KEY ("tenant_id","unit_resource_id") REFERENCES "catalog"."product_units"("tenant_id","unit_id") ON DELETE RESTRICT NOT VALID;--> statement-breakpoint
ALTER TABLE "catalog"."package_unit_divisibility" ADD CONSTRAINT "catalog_package_unit_divisibility_package_fk" FOREIGN KEY ("tenant_id","package_definition_id") REFERENCES "catalog"."package_definitions"("tenant_id","package_definition_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."package_unit_divisibility" ADD CONSTRAINT "catalog_package_unit_divisibility_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "catalog"."product_units"("tenant_id","unit_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."package_unit_divisibility_revisions" ADD CONSTRAINT "catalog_package_unit_divisibility_revisions_target_fk" FOREIGN KEY ("tenant_id","package_definition_id") REFERENCES "catalog"."package_unit_divisibility"("tenant_id","package_definition_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."package_unit_divisibility_revisions" ADD CONSTRAINT "catalog_package_unit_divisibility_revisions_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "catalog"."product_units"("tenant_id","unit_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_unit_rule_revisions" ADD CONSTRAINT "catalog_product_unit_rule_revisions_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "catalog"."product_units"("tenant_id","unit_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."variant_unit_divisibility" ADD CONSTRAINT "catalog_variant_unit_divisibility_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "catalog"."product_variants"("tenant_id","variant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."variant_unit_divisibility" ADD CONSTRAINT "catalog_variant_unit_divisibility_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "catalog"."product_units"("tenant_id","unit_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."variant_unit_divisibility_revisions" ADD CONSTRAINT "catalog_variant_unit_divisibility_revisions_target_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "catalog"."variant_unit_divisibility"("tenant_id","variant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."variant_unit_divisibility_revisions" ADD CONSTRAINT "catalog_variant_unit_divisibility_revisions_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "catalog"."product_units"("tenant_id","unit_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."package_content_revisions" DROP CONSTRAINT "catalog_package_content_revisions_unit_ck", ADD CONSTRAINT "catalog_package_content_revisions_unit_ck" CHECK ("unit_resource_type" = 'commerce.catalog.product-unit') NOT VALID;--> statement-breakpoint
CREATE POLICY "catalog_package_unit_divisibility_tenant_select" ON "catalog"."package_unit_divisibility" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."package_unit_divisibility"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_package_unit_divisibility_tenant_insert" ON "catalog"."package_unit_divisibility" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."package_unit_divisibility"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_package_unit_divisibility_tenant_update" ON "catalog"."package_unit_divisibility" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."package_unit_divisibility"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."package_unit_divisibility"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_package_unit_divisibility_tenant_delete" ON "catalog"."package_unit_divisibility" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."package_unit_divisibility"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_package_unit_divisibility_revisions_tenant_select" ON "catalog"."package_unit_divisibility_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."package_unit_divisibility_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_package_unit_divisibility_revisions_tenant_insert" ON "catalog"."package_unit_divisibility_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."package_unit_divisibility_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_package_unit_divisibility_revisions_tenant_update" ON "catalog"."package_unit_divisibility_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."package_unit_divisibility_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."package_unit_divisibility_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_package_unit_divisibility_revisions_tenant_delete" ON "catalog"."package_unit_divisibility_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."package_unit_divisibility_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_unit_rule_revisions_tenant_select" ON "catalog"."product_unit_rule_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_unit_rule_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_unit_rule_revisions_tenant_insert" ON "catalog"."product_unit_rule_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_unit_rule_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_unit_rule_revisions_tenant_update" ON "catalog"."product_unit_rule_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_unit_rule_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_unit_rule_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_unit_rule_revisions_tenant_delete" ON "catalog"."product_unit_rule_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_unit_rule_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_units_tenant_select" ON "catalog"."product_units" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_units"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_units_tenant_insert" ON "catalog"."product_units" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_units"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_units_tenant_update" ON "catalog"."product_units" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_units"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_units"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_units_tenant_delete" ON "catalog"."product_units" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_units"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_variant_unit_divisibility_tenant_select" ON "catalog"."variant_unit_divisibility" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."variant_unit_divisibility"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_variant_unit_divisibility_tenant_insert" ON "catalog"."variant_unit_divisibility" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."variant_unit_divisibility"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_variant_unit_divisibility_tenant_update" ON "catalog"."variant_unit_divisibility" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."variant_unit_divisibility"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."variant_unit_divisibility"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_variant_unit_divisibility_tenant_delete" ON "catalog"."variant_unit_divisibility" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."variant_unit_divisibility"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_variant_unit_divisibility_revisions_tenant_select" ON "catalog"."variant_unit_divisibility_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."variant_unit_divisibility_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_variant_unit_divisibility_revisions_tenant_insert" ON "catalog"."variant_unit_divisibility_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."variant_unit_divisibility_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_variant_unit_divisibility_revisions_tenant_update" ON "catalog"."variant_unit_divisibility_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."variant_unit_divisibility_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."variant_unit_divisibility_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_variant_unit_divisibility_revisions_tenant_delete" ON "catalog"."variant_unit_divisibility_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."variant_unit_divisibility_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "catalog"."product_units" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."product_unit_rule_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."variant_unit_divisibility" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."variant_unit_divisibility_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."package_unit_divisibility" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."package_unit_divisibility_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "catalog_product_unit_rule_revisions_append_only" BEFORE UPDATE OR DELETE ON "catalog"."product_unit_rule_revisions" FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "catalog_variant_unit_divisibility_revisions_append_only" BEFORE UPDATE OR DELETE ON "catalog"."variant_unit_divisibility_revisions" FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "catalog_package_unit_divisibility_revisions_append_only" BEFORE UPDATE OR DELETE ON "catalog"."package_unit_divisibility_revisions" FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE FUNCTION "catalog"."protect_product_unit_identity"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.unit_id IS DISTINCT FROM OLD.unit_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.code IS DISTINCT FROM OLD.code OR NEW.label IS DISTINCT FROM OLD.label OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'catalog product Unit identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "catalog_product_units_identity_immutable" BEFORE UPDATE OR DELETE ON "catalog"."product_units" FOR EACH ROW EXECUTE FUNCTION "catalog"."protect_product_unit_identity"();
--> statement-breakpoint
CREATE FUNCTION "catalog"."protect_variant_unit_target_identity"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.unit_id IS DISTINCT FROM OLD.unit_id OR NEW.variant_id IS DISTINCT FROM OLD.variant_id THEN
    RAISE EXCEPTION 'catalog Variant Unit target identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "catalog_variant_unit_divisibility_identity_immutable" BEFORE UPDATE OR DELETE ON "catalog"."variant_unit_divisibility" FOR EACH ROW EXECUTE FUNCTION "catalog"."protect_variant_unit_target_identity"();
--> statement-breakpoint
CREATE FUNCTION "catalog"."protect_package_unit_target_identity"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.unit_id IS DISTINCT FROM OLD.unit_id OR NEW.package_definition_id IS DISTINCT FROM OLD.package_definition_id THEN
    RAISE EXCEPTION 'catalog Package Unit target identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "catalog_package_unit_divisibility_identity_immutable" BEFORE UPDATE OR DELETE ON "catalog"."package_unit_divisibility" FOR EACH ROW EXECUTE FUNCTION "catalog"."protect_package_unit_target_identity"();
