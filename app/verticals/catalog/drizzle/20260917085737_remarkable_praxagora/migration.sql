CREATE TABLE "catalog"."brand_revisions" (
	"tenant_id" uuid,
	"brand_id" uuid,
	"revision" integer,
	"name" text NOT NULL,
	"lifecycle_state" text NOT NULL,
	"change_kind" text NOT NULL,
	"reason" text NOT NULL,
	"evidence_refs" text[] NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_brand_revisions_pk" PRIMARY KEY("tenant_id","brand_id","revision"),
	CONSTRAINT "catalog_brand_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_brand_revisions_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "catalog_brand_revisions_name_ck" CHECK ("name" = btrim("name") and length("name") between 1 and 240),
	CONSTRAINT "catalog_brand_revisions_lifecycle_ck" CHECK ("lifecycle_state" in ('ACTIVE', 'RETIRED')),
	CONSTRAINT "catalog_brand_revisions_kind_ck" CHECK ("change_kind" in ('CREATED', 'RENAMED', 'RETIRED', 'REACTIVATED')),
	CONSTRAINT "catalog_brand_revisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "catalog"."brand_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."brands" (
	"brand_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"lifecycle_state" text NOT NULL,
	"current_revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_brands_scope_id_uk" UNIQUE("tenant_id","brand_id"),
	CONSTRAINT "catalog_brands_name_ck" CHECK ("name" = btrim("name") and length("name") between 1 and 240),
	CONSTRAINT "catalog_brands_lifecycle_ck" CHECK ("lifecycle_state" in ('ACTIVE', 'RETIRED')),
	CONSTRAINT "catalog_brands_revision_ck" CHECK ("current_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "catalog"."brands" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."manufacturer_relation_revisions" (
	"tenant_id" uuid,
	"relation_id" uuid,
	"revision" integer,
	"product_id" uuid,
	"variant_id" uuid,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"disposition" text NOT NULL,
	"effective_from" timestamp with time zone,
	"effective_to" timestamp with time zone,
	"reason" text NOT NULL,
	"evidence_refs" text[] NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_manufacturer_relation_revisions_pk" PRIMARY KEY("tenant_id","relation_id","revision"),
	CONSTRAINT "catalog_manufacturer_relation_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_manufacturer_relation_revisions_subject_ck" CHECK (("product_id" is null) <> ("variant_id" is null)),
	CONSTRAINT "catalog_manufacturer_relation_revisions_target_ck" CHECK ("target_kind" in ('PARTY', 'LEGAL_ENTITY')),
	CONSTRAINT "catalog_manufacturer_relation_revisions_number_ck" CHECK ("revision" > 0),
	CONSTRAINT "catalog_manufacturer_relation_revisions_disposition_ck" CHECK ("disposition" in ('CONFIRMED', 'RETRACTED')),
	CONSTRAINT "catalog_manufacturer_relation_revisions_period_ck" CHECK ("effective_from" is null or "effective_to" is null or "effective_from" < "effective_to"),
	CONSTRAINT "catalog_manufacturer_relation_revisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "catalog"."manufacturer_relation_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."manufacturer_relations" (
	"relation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"product_id" uuid,
	"variant_id" uuid,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"current_revision" integer NOT NULL,
	"disposition" text NOT NULL,
	"effective_from" timestamp with time zone,
	"effective_to" timestamp with time zone,
	"reason" text NOT NULL,
	"evidence_refs" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_manufacturer_relations_scope_id_uk" UNIQUE("tenant_id","relation_id"),
	CONSTRAINT "catalog_manufacturer_relations_subject_ck" CHECK (("product_id" is null) <> ("variant_id" is null)),
	CONSTRAINT "catalog_manufacturer_relations_target_ck" CHECK ("target_kind" in ('PARTY', 'LEGAL_ENTITY')),
	CONSTRAINT "catalog_manufacturer_relations_revision_ck" CHECK ("current_revision" > 0),
	CONSTRAINT "catalog_manufacturer_relations_disposition_ck" CHECK ("disposition" in ('CONFIRMED', 'RETRACTED')),
	CONSTRAINT "catalog_manufacturer_relations_period_ck" CHECK ("effective_from" is null or "effective_to" is null or "effective_from" < "effective_to"),
	CONSTRAINT "catalog_manufacturer_relations_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "catalog"."manufacturer_relations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."product_brand_assignment_revisions" (
	"tenant_id" uuid,
	"product_id" uuid,
	"revision" integer,
	"claim_kind" text NOT NULL,
	"brand_id" uuid,
	"evidence_ref" text,
	"reason" text NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_product_brand_assignment_revisions_pk" PRIMARY KEY("tenant_id","product_id","revision"),
	CONSTRAINT "catalog_product_brand_assignment_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_product_brand_assignment_revisions_number_ck" CHECK ("revision" > 0),
	CONSTRAINT "catalog_product_brand_assignment_revisions_claim_ck" CHECK (("claim_kind" = 'UNKNOWN' and "brand_id" is null and "evidence_ref" is null) or ("claim_kind" = 'CONFIRMED_UNBRANDED' and "brand_id" is null and "evidence_ref" is not null) or ("claim_kind" = 'BRANDED' and "brand_id" is not null and "evidence_ref" is not null)),
	CONSTRAINT "catalog_product_brand_assignment_revisions_evidence_ck" CHECK ("evidence_ref" is null or ("evidence_ref" = btrim("evidence_ref") and length("evidence_ref") between 1 and 1000)),
	CONSTRAINT "catalog_product_brand_assignment_revisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_brand_assignment_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."product_brand_assignments" (
	"tenant_id" uuid,
	"product_id" uuid,
	"current_revision" integer NOT NULL,
	"claim_kind" text NOT NULL,
	"brand_id" uuid,
	"evidence_ref" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_product_brand_assignments_pk" PRIMARY KEY("tenant_id","product_id"),
	CONSTRAINT "catalog_product_brand_assignments_revision_ck" CHECK ("current_revision" > 0),
	CONSTRAINT "catalog_product_brand_assignments_claim_ck" CHECK (("claim_kind" = 'UNKNOWN' and "brand_id" is null and "evidence_ref" is null) or ("claim_kind" = 'CONFIRMED_UNBRANDED' and "brand_id" is null and "evidence_ref" is not null) or ("claim_kind" = 'BRANDED' and "brand_id" is not null and "evidence_ref" is not null)),
	CONSTRAINT "catalog_product_brand_assignments_evidence_ck" CHECK ("evidence_ref" is null or ("evidence_ref" = btrim("evidence_ref") and length("evidence_ref") between 1 and 1000))
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_brand_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "catalog_manufacturer_relations_product_idx" ON "catalog"."manufacturer_relations" ("tenant_id","product_id");--> statement-breakpoint
CREATE INDEX "catalog_manufacturer_relations_variant_idx" ON "catalog"."manufacturer_relations" ("tenant_id","variant_id");--> statement-breakpoint
ALTER TABLE "catalog"."brand_revisions" ADD CONSTRAINT "catalog_brand_revisions_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "catalog"."brands"("tenant_id","brand_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."manufacturer_relation_revisions" ADD CONSTRAINT "catalog_manufacturer_relation_revisions_relation_fk" FOREIGN KEY ("tenant_id","relation_id") REFERENCES "catalog"."manufacturer_relations"("tenant_id","relation_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."manufacturer_relation_revisions" ADD CONSTRAINT "catalog_manufacturer_relation_revisions_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "catalog"."products"("tenant_id","product_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."manufacturer_relation_revisions" ADD CONSTRAINT "catalog_manufacturer_relation_revisions_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "catalog"."product_variants"("tenant_id","variant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."manufacturer_relations" ADD CONSTRAINT "catalog_manufacturer_relations_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "catalog"."products"("tenant_id","product_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."manufacturer_relations" ADD CONSTRAINT "catalog_manufacturer_relations_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "catalog"."product_variants"("tenant_id","variant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_brand_assignment_revisions" ADD CONSTRAINT "catalog_product_brand_assignment_revisions_assignment_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "catalog"."product_brand_assignments"("tenant_id","product_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_brand_assignment_revisions" ADD CONSTRAINT "catalog_product_brand_assignment_revisions_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "catalog"."brands"("tenant_id","brand_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_brand_assignments" ADD CONSTRAINT "catalog_product_brand_assignments_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "catalog"."products"("tenant_id","product_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_brand_assignments" ADD CONSTRAINT "catalog_product_brand_assignments_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "catalog"."brands"("tenant_id","brand_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "catalog_brand_revisions_tenant_select" ON "catalog"."brand_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."brand_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_brand_revisions_tenant_insert" ON "catalog"."brand_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."brand_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_brand_revisions_tenant_update" ON "catalog"."brand_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."brand_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."brand_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_brand_revisions_tenant_delete" ON "catalog"."brand_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."brand_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_brands_tenant_select" ON "catalog"."brands" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."brands"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_brands_tenant_insert" ON "catalog"."brands" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."brands"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_brands_tenant_update" ON "catalog"."brands" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."brands"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."brands"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_brands_tenant_delete" ON "catalog"."brands" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."brands"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_manufacturer_relation_revisions_tenant_select" ON "catalog"."manufacturer_relation_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."manufacturer_relation_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_manufacturer_relation_revisions_tenant_insert" ON "catalog"."manufacturer_relation_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."manufacturer_relation_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_manufacturer_relation_revisions_tenant_update" ON "catalog"."manufacturer_relation_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."manufacturer_relation_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."manufacturer_relation_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_manufacturer_relation_revisions_tenant_delete" ON "catalog"."manufacturer_relation_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."manufacturer_relation_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_manufacturer_relations_tenant_select" ON "catalog"."manufacturer_relations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."manufacturer_relations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_manufacturer_relations_tenant_insert" ON "catalog"."manufacturer_relations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."manufacturer_relations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_manufacturer_relations_tenant_update" ON "catalog"."manufacturer_relations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."manufacturer_relations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."manufacturer_relations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_manufacturer_relations_tenant_delete" ON "catalog"."manufacturer_relations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."manufacturer_relations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_brand_assignment_revisions_tenant_select" ON "catalog"."product_brand_assignment_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_brand_assignment_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_brand_assignment_revisions_tenant_insert" ON "catalog"."product_brand_assignment_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_brand_assignment_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_brand_assignment_revisions_tenant_update" ON "catalog"."product_brand_assignment_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_brand_assignment_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_brand_assignment_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_brand_assignment_revisions_tenant_delete" ON "catalog"."product_brand_assignment_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_brand_assignment_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_brand_assignments_tenant_select" ON "catalog"."product_brand_assignments" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_brand_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_brand_assignments_tenant_insert" ON "catalog"."product_brand_assignments" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_brand_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_brand_assignments_tenant_update" ON "catalog"."product_brand_assignments" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_brand_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_brand_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_brand_assignments_tenant_delete" ON "catalog"."product_brand_assignments" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_brand_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- All new Catalog tables remain tenant-isolated even for their owners.
ALTER TABLE "catalog"."brands" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."brand_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."product_brand_assignments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."product_brand_assignment_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."manufacturer_relations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."manufacturer_relation_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "catalog_brand_revisions_append_only" BEFORE UPDATE OR DELETE ON "catalog"."brand_revisions" FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "catalog_product_brand_assignment_revisions_append_only" BEFORE UPDATE OR DELETE ON "catalog"."product_brand_assignment_revisions" FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "catalog_manufacturer_relation_revisions_append_only" BEFORE UPDATE OR DELETE ON "catalog"."manufacturer_relation_revisions" FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE FUNCTION "catalog"."protect_404_identity"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'catalog identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'brands' AND NEW.brand_id IS DISTINCT FROM OLD.brand_id THEN
    RAISE EXCEPTION 'catalog brand identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'product_brand_assignments' AND NEW.product_id IS DISTINCT FROM OLD.product_id THEN
    RAISE EXCEPTION 'catalog Product brand subject is immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'manufacturer_relations' AND
    (NEW.relation_id IS DISTINCT FROM OLD.relation_id OR NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.variant_id IS DISTINCT FROM OLD.variant_id) THEN
    RAISE EXCEPTION 'catalog manufacturer relation identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.current_revision <= OLD.current_revision THEN
    RAISE EXCEPTION 'catalog current revision must advance' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "catalog_brands_identity_immutable" BEFORE UPDATE OR DELETE ON "catalog"."brands" FOR EACH ROW EXECUTE FUNCTION "catalog"."protect_404_identity"();
--> statement-breakpoint
CREATE TRIGGER "catalog_product_brand_assignments_identity_immutable" BEFORE UPDATE OR DELETE ON "catalog"."product_brand_assignments" FOR EACH ROW EXECUTE FUNCTION "catalog"."protect_404_identity"();
--> statement-breakpoint
CREATE TRIGGER "catalog_manufacturer_relations_identity_immutable" BEFORE UPDATE OR DELETE ON "catalog"."manufacturer_relations" FOR EACH ROW EXECUTE FUNCTION "catalog"."protect_404_identity"();
