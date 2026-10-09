CREATE TABLE "catalog"."product_attribute_applicability" (
	"tenant_id" uuid,
	"product_id" uuid,
	"attribute_definition_id" uuid,
	"current_revision" integer NOT NULL,
	"product_level" boolean NOT NULL,
	"variant_level" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_product_attribute_applicability_pk" PRIMARY KEY("tenant_id","product_id","attribute_definition_id"),
	CONSTRAINT "catalog_product_attribute_applicability_revision_ck" CHECK ("current_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_attribute_applicability" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."product_attribute_applicability_revisions" (
	"tenant_id" uuid,
	"product_id" uuid,
	"attribute_definition_id" uuid,
	"revision" integer,
	"product_level" boolean NOT NULL,
	"variant_level" boolean NOT NULL,
	"reason" text NOT NULL,
	"evidence_refs" text[] NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_product_attribute_applicability_revisions_pk" PRIMARY KEY("tenant_id","product_id","attribute_definition_id","revision"),
	CONSTRAINT "catalog_product_attribute_applicability_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_product_attribute_applicability_revisions_number_ck" CHECK ("revision" > 0),
	CONSTRAINT "catalog_product_attribute_applicability_revisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_attribute_applicability_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "catalog"."product_attribute_applicability" ADD CONSTRAINT "catalog_product_attribute_applicability_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "catalog"."products"("tenant_id","product_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_attribute_applicability" ADD CONSTRAINT "catalog_product_attribute_applicability_definition_fk" FOREIGN KEY ("tenant_id","attribute_definition_id") REFERENCES "catalog"."attribute_definitions"("tenant_id","attribute_definition_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_attribute_applicability_revisions" ADD CONSTRAINT "catalog_product_attribute_applicability_revisions_current_fk" FOREIGN KEY ("tenant_id","product_id","attribute_definition_id") REFERENCES "catalog"."product_attribute_applicability"("tenant_id","product_id","attribute_definition_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "catalog_product_attribute_applicability_tenant_select" ON "catalog"."product_attribute_applicability" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_attribute_applicability"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_attribute_applicability_tenant_insert" ON "catalog"."product_attribute_applicability" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_attribute_applicability"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_attribute_applicability_tenant_update" ON "catalog"."product_attribute_applicability" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_attribute_applicability"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_attribute_applicability"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_attribute_applicability_tenant_delete" ON "catalog"."product_attribute_applicability" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_attribute_applicability"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_attribute_applicability_revisions_tenant_select" ON "catalog"."product_attribute_applicability_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_attribute_applicability_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_attribute_applicability_revisions_tenant_insert" ON "catalog"."product_attribute_applicability_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_attribute_applicability_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_attribute_applicability_revisions_tenant_update" ON "catalog"."product_attribute_applicability_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_attribute_applicability_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_attribute_applicability_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_attribute_applicability_revisions_tenant_delete" ON "catalog"."product_attribute_applicability_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_attribute_applicability_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);