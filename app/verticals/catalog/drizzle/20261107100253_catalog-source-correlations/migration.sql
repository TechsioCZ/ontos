CREATE TABLE "catalog"."catalog_source_correlations" (
	"tenant_id" uuid,
	"issuer_id" text,
	"route_scope" text,
	"record_namespace" text,
	"entity_kind" text,
	"record_id" text,
	"mapping_revision" text NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"intent_fingerprint" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_source_correlations_pk" PRIMARY KEY("tenant_id","issuer_id","route_scope","record_namespace","entity_kind","record_id"),
	CONSTRAINT "catalog_source_correlations_kind_ck" CHECK ("entity_kind" in ('PRODUCT', 'VARIANT')),
	CONSTRAINT "catalog_source_correlations_fingerprint_ck" CHECK ("intent_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "catalog_source_correlations_parts_ck" CHECK ("issuer_id" = btrim("issuer_id") and length("issuer_id") between 1 and 300 and "route_scope" = btrim("route_scope") and length("route_scope") between 1 and 300 and "record_namespace" = btrim("record_namespace") and length("record_namespace") between 1 and 300 and "record_id" = btrim("record_id") and length("record_id") between 1 and 300 and "mapping_revision" = btrim("mapping_revision") and length("mapping_revision") between 1 and 300)
);
--> statement-breakpoint
ALTER TABLE "catalog"."catalog_source_correlations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_source_correlations_variant_source_uk" ON "catalog"."catalog_source_correlations" ("tenant_id","issuer_id","route_scope","record_namespace","variant_id") WHERE "entity_kind" = 'VARIANT';--> statement-breakpoint
ALTER TABLE "catalog"."catalog_source_correlations" ADD CONSTRAINT "catalog_source_correlations_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "catalog"."product_variants"("tenant_id","product_id","variant_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "catalog_source_correlations_tenant_select" ON "catalog"."catalog_source_correlations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."catalog_source_correlations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_source_correlations_tenant_insert" ON "catalog"."catalog_source_correlations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."catalog_source_correlations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_source_correlations_tenant_update" ON "catalog"."catalog_source_correlations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."catalog_source_correlations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."catalog_source_correlations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_source_correlations_tenant_delete" ON "catalog"."catalog_source_correlations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."catalog_source_correlations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);