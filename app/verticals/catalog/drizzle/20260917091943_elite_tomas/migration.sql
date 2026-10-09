CREATE TABLE "catalog"."product_size_usage_items" (
	"tenant_id" uuid,
	"product_id" uuid,
	"position" integer,
	"size_value_id" uuid NOT NULL,
	"size_specialization" text DEFAULT 'SIZE' NOT NULL,
	CONSTRAINT "catalog_product_size_usage_items_pk" PRIMARY KEY("tenant_id","product_id","position"),
	CONSTRAINT "catalog_product_size_usage_items_value_uk" UNIQUE("tenant_id","product_id","size_value_id"),
	CONSTRAINT "catalog_product_size_usage_items_position_ck" CHECK ("position" >= 0),
	CONSTRAINT "catalog_product_size_usage_items_kind_ck" CHECK ("size_specialization" = 'SIZE')
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_size_usage_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."product_size_usage_revision_items" (
	"tenant_id" uuid,
	"product_id" uuid,
	"revision" integer,
	"position" integer,
	"size_value_id" uuid NOT NULL,
	"size_specialization" text DEFAULT 'SIZE' NOT NULL,
	CONSTRAINT "catalog_product_size_usage_revision_items_pk" PRIMARY KEY("tenant_id","product_id","revision","position"),
	CONSTRAINT "catalog_product_size_usage_revision_items_value_uk" UNIQUE("tenant_id","product_id","revision","size_value_id"),
	CONSTRAINT "catalog_product_size_usage_revision_items_position_ck" CHECK ("position" >= 0),
	CONSTRAINT "catalog_product_size_usage_revision_items_kind_ck" CHECK ("size_specialization" = 'SIZE')
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_size_usage_revision_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."product_size_usage_revisions" (
	"tenant_id" uuid,
	"product_id" uuid,
	"revision" integer,
	"reason" text NOT NULL,
	"evidence_refs" text[] NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_product_size_usage_revisions_pk" PRIMARY KEY("tenant_id","product_id","revision"),
	CONSTRAINT "catalog_product_size_usage_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_product_size_usage_revisions_number_ck" CHECK ("revision" > 0),
	CONSTRAINT "catalog_product_size_usage_revisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_size_usage_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."product_size_usage_sets" (
	"tenant_id" uuid,
	"product_id" uuid,
	"current_revision" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_product_size_usage_sets_pk" PRIMARY KEY("tenant_id","product_id"),
	CONSTRAINT "catalog_product_size_usage_sets_revision_ck" CHECK ("current_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_size_usage_sets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."size_equivalence_assertions" (
	"assertion_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"left_size_value_id" uuid NOT NULL,
	"right_size_value_id" uuid NOT NULL,
	"left_specialization" text DEFAULT 'SIZE' NOT NULL,
	"right_specialization" text DEFAULT 'SIZE' NOT NULL,
	"scope" text NOT NULL,
	"evidence_ref" text NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_size_equivalence_assertions_scope_id_uk" UNIQUE("tenant_id","assertion_id"),
	CONSTRAINT "catalog_size_equivalence_assertions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_size_equivalence_assertions_kind_ck" CHECK ("left_specialization" = 'SIZE' and "right_specialization" = 'SIZE'),
	CONSTRAINT "catalog_size_equivalence_assertions_distinct_ck" CHECK ("left_size_value_id" <> "right_size_value_id"),
	CONSTRAINT "catalog_size_equivalence_assertions_scope_ck" CHECK ("scope" = btrim("scope") and length("scope") between 1 and 1000),
	CONSTRAINT "catalog_size_equivalence_assertions_evidence_ck" CHECK ("evidence_ref" = btrim("evidence_ref") and length("evidence_ref") between 1 and 1000),
	CONSTRAINT "catalog_size_equivalence_assertions_period_ck" CHECK ("valid_until" is null or "valid_from" is null or "valid_until" > "valid_from")
);
--> statement-breakpoint
ALTER TABLE "catalog"."size_equivalence_assertions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "catalog"."controlled_attribute_values" ADD CONSTRAINT "catalog_controlled_values_size_kind_uk" UNIQUE("tenant_id","controlled_attribute_value_id","specialization");--> statement-breakpoint
ALTER TABLE "catalog"."product_size_usage_items" ADD CONSTRAINT "catalog_product_size_usage_items_set_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "catalog"."product_size_usage_sets"("tenant_id","product_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_size_usage_items" ADD CONSTRAINT "catalog_product_size_usage_items_size_fk" FOREIGN KEY ("tenant_id","size_value_id","size_specialization") REFERENCES "catalog"."controlled_attribute_values"("tenant_id","controlled_attribute_value_id","specialization") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_size_usage_revision_items" ADD CONSTRAINT "catalog_product_size_usage_revision_items_revision_fk" FOREIGN KEY ("tenant_id","product_id","revision") REFERENCES "catalog"."product_size_usage_revisions"("tenant_id","product_id","revision") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_size_usage_revision_items" ADD CONSTRAINT "catalog_product_size_usage_revision_items_size_fk" FOREIGN KEY ("tenant_id","size_value_id","size_specialization") REFERENCES "catalog"."controlled_attribute_values"("tenant_id","controlled_attribute_value_id","specialization") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_size_usage_revisions" ADD CONSTRAINT "catalog_product_size_usage_revisions_set_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "catalog"."product_size_usage_sets"("tenant_id","product_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_size_usage_sets" ADD CONSTRAINT "catalog_product_size_usage_sets_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "catalog"."products"("tenant_id","product_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."size_equivalence_assertions" ADD CONSTRAINT "catalog_size_equivalence_assertions_left_fk" FOREIGN KEY ("tenant_id","left_size_value_id","left_specialization") REFERENCES "catalog"."controlled_attribute_values"("tenant_id","controlled_attribute_value_id","specialization") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."size_equivalence_assertions" ADD CONSTRAINT "catalog_size_equivalence_assertions_right_fk" FOREIGN KEY ("tenant_id","right_size_value_id","right_specialization") REFERENCES "catalog"."controlled_attribute_values"("tenant_id","controlled_attribute_value_id","specialization") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "catalog_product_size_usage_items_tenant_select" ON "catalog"."product_size_usage_items" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_size_usage_items"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_size_usage_items_tenant_insert" ON "catalog"."product_size_usage_items" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_size_usage_items"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_size_usage_items_tenant_update" ON "catalog"."product_size_usage_items" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_size_usage_items"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_size_usage_items"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_size_usage_items_tenant_delete" ON "catalog"."product_size_usage_items" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_size_usage_items"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_size_usage_revision_items_tenant_select" ON "catalog"."product_size_usage_revision_items" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_size_usage_revision_items"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_size_usage_revision_items_tenant_insert" ON "catalog"."product_size_usage_revision_items" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_size_usage_revision_items"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_size_usage_revision_items_tenant_update" ON "catalog"."product_size_usage_revision_items" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_size_usage_revision_items"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_size_usage_revision_items"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_size_usage_revision_items_tenant_delete" ON "catalog"."product_size_usage_revision_items" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_size_usage_revision_items"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_size_usage_revisions_tenant_select" ON "catalog"."product_size_usage_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_size_usage_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_size_usage_revisions_tenant_insert" ON "catalog"."product_size_usage_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_size_usage_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_size_usage_revisions_tenant_update" ON "catalog"."product_size_usage_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_size_usage_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_size_usage_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_size_usage_revisions_tenant_delete" ON "catalog"."product_size_usage_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_size_usage_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_size_usage_sets_tenant_select" ON "catalog"."product_size_usage_sets" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_size_usage_sets"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_size_usage_sets_tenant_insert" ON "catalog"."product_size_usage_sets" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_size_usage_sets"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_size_usage_sets_tenant_update" ON "catalog"."product_size_usage_sets" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_size_usage_sets"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_size_usage_sets"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_size_usage_sets_tenant_delete" ON "catalog"."product_size_usage_sets" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_size_usage_sets"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_size_equivalence_assertions_tenant_select" ON "catalog"."size_equivalence_assertions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."size_equivalence_assertions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_size_equivalence_assertions_tenant_insert" ON "catalog"."size_equivalence_assertions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."size_equivalence_assertions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_size_equivalence_assertions_tenant_update" ON "catalog"."size_equivalence_assertions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."size_equivalence_assertions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."size_equivalence_assertions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_size_equivalence_assertions_tenant_delete" ON "catalog"."size_equivalence_assertions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."size_equivalence_assertions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "catalog"."product_size_usage_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."product_size_usage_revision_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."product_size_usage_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."product_size_usage_sets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."size_equivalence_assertions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "catalog_product_size_usage_revisions_append_only" BEFORE UPDATE OR DELETE ON "catalog"."product_size_usage_revisions" FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "catalog_product_size_usage_revision_items_append_only" BEFORE UPDATE OR DELETE ON "catalog"."product_size_usage_revision_items" FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "catalog_size_equivalence_assertions_append_only" BEFORE UPDATE OR DELETE ON "catalog"."size_equivalence_assertions" FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE FUNCTION "catalog"."protect_size_usage_identity"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.product_id IS DISTINCT FROM OLD.product_id
    OR NEW.current_revision <= OLD.current_revision THEN
    RAISE EXCEPTION 'catalog size usage identity or revision is invalid' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "catalog_product_size_usage_sets_identity_immutable" BEFORE UPDATE OR DELETE ON "catalog"."product_size_usage_sets" FOR EACH ROW EXECUTE FUNCTION "catalog"."protect_size_usage_identity"();
