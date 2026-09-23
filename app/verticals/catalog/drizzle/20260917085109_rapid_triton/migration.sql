CREATE TABLE "catalog"."product_relationship_revisions" (
	"tenant_id" uuid,
	"relationship_id" uuid,
	"revision" integer,
	"relationship_type" text NOT NULL,
	"source_product_id" uuid,
	"source_variant_id" uuid,
	"target_product_id" uuid,
	"target_variant_id" uuid,
	"effective_from" timestamp with time zone,
	"effective_to" timestamp with time zone,
	"change_kind" text NOT NULL,
	"reason" text NOT NULL,
	"evidence_refs" text[] NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_product_relationship_revisions_pk" PRIMARY KEY("tenant_id","relationship_id","revision"),
	CONSTRAINT "catalog_product_relationship_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_product_relationship_revisions_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "catalog_product_relationship_revisions_type_ck" CHECK ("relationship_type" in ('ACCESSORY_FOR', 'RELATED_PRODUCT', 'SUCCESSOR')),
	CONSTRAINT "catalog_product_relationship_revisions_source_ck" CHECK (num_nonnulls("source_product_id", "source_variant_id") = 1),
	CONSTRAINT "catalog_product_relationship_revisions_target_ck" CHECK (num_nonnulls("target_product_id", "target_variant_id") = 1),
	CONSTRAINT "catalog_product_relationship_revisions_self_ck" CHECK ("source_product_id" is distinct from "target_product_id" or "source_variant_id" is distinct from "target_variant_id"),
	CONSTRAINT "catalog_product_relationship_revisions_period_ck" CHECK ("effective_from" is null or "effective_to" is null or "effective_from" < "effective_to"),
	CONSTRAINT "catalog_product_relationship_revisions_kind_ck" CHECK ("change_kind" in ('CREATED', 'CORRECTED', 'ENDED')),
	CONSTRAINT "catalog_product_relationship_revisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000),
	CONSTRAINT "catalog_product_relationship_revisions_evidence_ck" CHECK (cardinality("evidence_refs") > 0 and array_position("evidence_refs", null) is null)
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_relationship_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."product_relationships" (
	"relationship_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"relationship_type" text NOT NULL,
	"source_product_id" uuid,
	"source_variant_id" uuid,
	"target_product_id" uuid,
	"target_variant_id" uuid,
	"effective_from" timestamp with time zone,
	"effective_to" timestamp with time zone,
	"current_revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_product_relationships_scope_id_uk" UNIQUE("tenant_id","relationship_id"),
	CONSTRAINT "catalog_product_relationships_exact_uk" UNIQUE NULLS NOT DISTINCT("tenant_id","relationship_type","source_product_id","source_variant_id","target_product_id","target_variant_id","effective_from","effective_to"),
	CONSTRAINT "catalog_product_relationships_type_ck" CHECK ("relationship_type" in ('ACCESSORY_FOR', 'RELATED_PRODUCT', 'SUCCESSOR')),
	CONSTRAINT "catalog_product_relationships_source_ck" CHECK (num_nonnulls("source_product_id", "source_variant_id") = 1),
	CONSTRAINT "catalog_product_relationships_target_ck" CHECK (num_nonnulls("target_product_id", "target_variant_id") = 1),
	CONSTRAINT "catalog_product_relationships_self_ck" CHECK ("source_product_id" is distinct from "target_product_id" or "source_variant_id" is distinct from "target_variant_id"),
	CONSTRAINT "catalog_product_relationships_period_ck" CHECK ("effective_from" is null or "effective_to" is null or "effective_from" < "effective_to"),
	CONSTRAINT "catalog_product_relationships_revision_ck" CHECK ("current_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_relationships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "catalog_product_relationships_source_product_idx" ON "catalog"."product_relationships" ("tenant_id","source_product_id");--> statement-breakpoint
CREATE INDEX "catalog_product_relationships_source_variant_idx" ON "catalog"."product_relationships" ("tenant_id","source_variant_id");--> statement-breakpoint
CREATE INDEX "catalog_product_relationships_target_product_idx" ON "catalog"."product_relationships" ("tenant_id","target_product_id");--> statement-breakpoint
CREATE INDEX "catalog_product_relationships_target_variant_idx" ON "catalog"."product_relationships" ("tenant_id","target_variant_id");--> statement-breakpoint
ALTER TABLE "catalog"."product_relationship_revisions" ADD CONSTRAINT "catalog_product_relationship_revisions_relationship_fk" FOREIGN KEY ("tenant_id","relationship_id") REFERENCES "catalog"."product_relationships"("tenant_id","relationship_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_relationship_revisions" ADD CONSTRAINT "catalog_product_relationship_revisions_source_product_fk" FOREIGN KEY ("tenant_id","source_product_id") REFERENCES "catalog"."products"("tenant_id","product_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_relationship_revisions" ADD CONSTRAINT "catalog_product_relationship_revisions_source_variant_fk" FOREIGN KEY ("tenant_id","source_variant_id") REFERENCES "catalog"."product_variants"("tenant_id","variant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_relationship_revisions" ADD CONSTRAINT "catalog_product_relationship_revisions_target_product_fk" FOREIGN KEY ("tenant_id","target_product_id") REFERENCES "catalog"."products"("tenant_id","product_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_relationship_revisions" ADD CONSTRAINT "catalog_product_relationship_revisions_target_variant_fk" FOREIGN KEY ("tenant_id","target_variant_id") REFERENCES "catalog"."product_variants"("tenant_id","variant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_relationships" ADD CONSTRAINT "catalog_product_relationships_source_product_fk" FOREIGN KEY ("tenant_id","source_product_id") REFERENCES "catalog"."products"("tenant_id","product_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_relationships" ADD CONSTRAINT "catalog_product_relationships_source_variant_fk" FOREIGN KEY ("tenant_id","source_variant_id") REFERENCES "catalog"."product_variants"("tenant_id","variant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_relationships" ADD CONSTRAINT "catalog_product_relationships_target_product_fk" FOREIGN KEY ("tenant_id","target_product_id") REFERENCES "catalog"."products"("tenant_id","product_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_relationships" ADD CONSTRAINT "catalog_product_relationships_target_variant_fk" FOREIGN KEY ("tenant_id","target_variant_id") REFERENCES "catalog"."product_variants"("tenant_id","variant_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "catalog_product_relationship_revisions_tenant_select" ON "catalog"."product_relationship_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_relationship_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_relationship_revisions_tenant_insert" ON "catalog"."product_relationship_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_relationship_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_relationship_revisions_tenant_update" ON "catalog"."product_relationship_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_relationship_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_relationship_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_relationship_revisions_tenant_delete" ON "catalog"."product_relationship_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_relationship_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_relationships_tenant_select" ON "catalog"."product_relationships" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_relationships"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_relationships_tenant_insert" ON "catalog"."product_relationships" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_relationships"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_relationships_tenant_update" ON "catalog"."product_relationships" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_relationships"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_relationships"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_relationships_tenant_delete" ON "catalog"."product_relationships" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_relationships"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "catalog"."product_relationships" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."product_relationship_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "catalog_product_relationship_revisions_append_only"
BEFORE UPDATE OR DELETE ON "catalog"."product_relationship_revisions"
FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE FUNCTION "catalog"."protect_product_relationship_identity"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR NEW."relationship_id" IS DISTINCT FROM OLD."relationship_id"
    OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'catalog relationship identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "catalog_product_relationships_identity_immutable"
BEFORE UPDATE OR DELETE ON "catalog"."product_relationships"
FOR EACH ROW EXECUTE FUNCTION "catalog"."protect_product_relationship_identity"();
