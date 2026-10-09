CREATE SCHEMA "catalog";
--> statement-breakpoint
CREATE TABLE "catalog"."product_lifecycle_events" (
	"product_lifecycle_event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"event" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_product_lifecycle_scope_id_uk" UNIQUE("tenant_id","product_lifecycle_event_id"),
	CONSTRAINT "catalog_product_lifecycle_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_product_lifecycle_event_ck" CHECK ("event" in ('ACTIVATED', 'RETIRED')),
	CONSTRAINT "catalog_product_lifecycle_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_lifecycle_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."product_revisions" (
	"product_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"change_kind" text NOT NULL,
	"lifecycle_state" text NOT NULL,
	"name" text,
	"description" text,
	"reason" text NOT NULL,
	"evidence_refs" text[] NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_product_revisions_scope_id_uk" UNIQUE("tenant_id","product_revision_id"),
	CONSTRAINT "catalog_product_revisions_number_uk" UNIQUE("tenant_id","product_id","revision"),
	CONSTRAINT "catalog_product_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_product_revisions_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "catalog_product_revisions_change_kind_ck" CHECK ("change_kind" in ('CREATED', 'UPDATED', 'COSMETIC_CORRECTION', 'LIFECYCLE')),
	CONSTRAINT "catalog_product_revisions_lifecycle_ck" CHECK ("lifecycle_state" in ('DRAFT', 'ACTIVE', 'RETIRED')),
	CONSTRAINT "catalog_product_revisions_name_ck" CHECK ("name" is null or ("name" = btrim("name") and length("name") between 1 and 240)),
	CONSTRAINT "catalog_product_revisions_description_ck" CHECK ("description" is null or ("description" = btrim("description") and length("description") <= 4000)),
	CONSTRAINT "catalog_product_revisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."product_variants" (
	"variant_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"lifecycle_state" text DEFAULT 'WORK_IN_PROGRESS' NOT NULL,
	"created_by_action_invocation_id" uuid NOT NULL,
	"created_by_principal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_product_variants_scope_id_uk" UNIQUE("tenant_id","variant_id"),
	CONSTRAINT "catalog_product_variants_product_id_variant_id_uk" UNIQUE("tenant_id","product_id","variant_id"),
	CONSTRAINT "catalog_product_variants_lifecycle_ck" CHECK ("lifecycle_state" in ('WORK_IN_PROGRESS', 'ACTIVE', 'RETIRED'))
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_variants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."products" (
	"product_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"lifecycle_state" text DEFAULT 'DRAFT' NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"name" text,
	"description" text,
	"retired_effective_at" timestamp with time zone,
	"retired_reason" text,
	"created_by_action_invocation_id" uuid NOT NULL,
	"created_by_principal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_products_scope_id_uk" UNIQUE("tenant_id","product_id"),
	CONSTRAINT "catalog_products_lifecycle_ck" CHECK ("lifecycle_state" in ('DRAFT', 'ACTIVE', 'RETIRED')),
	CONSTRAINT "catalog_products_revision_ck" CHECK ("current_revision" > 0),
	CONSTRAINT "catalog_products_name_ck" CHECK ("name" is null or ("name" = btrim("name") and length("name") between 1 and 240)),
	CONSTRAINT "catalog_products_description_ck" CHECK ("description" is null or ("description" = btrim("description") and length("description") <= 4000)),
	CONSTRAINT "catalog_products_retirement_ck" CHECK (("lifecycle_state" <> 'RETIRED' and "retired_effective_at" is null and "retired_reason" is null) or ("lifecycle_state" = 'RETIRED' and "retired_effective_at" is not null and "retired_reason" is not null and "retired_reason" = btrim("retired_reason") and length("retired_reason") between 1 and 1000))
);
--> statement-breakpoint
ALTER TABLE "catalog"."products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "catalog_product_lifecycle_history_idx" ON "catalog"."product_lifecycle_events" ("tenant_id","product_id","effective_at");--> statement-breakpoint
CREATE INDEX "catalog_product_revisions_history_idx" ON "catalog"."product_revisions" ("tenant_id","product_id","revision");--> statement-breakpoint
CREATE INDEX "catalog_product_variants_product_idx" ON "catalog"."product_variants" ("tenant_id","product_id","lifecycle_state");--> statement-breakpoint
CREATE INDEX "catalog_products_tenant_lifecycle_idx" ON "catalog"."products" ("tenant_id","lifecycle_state");--> statement-breakpoint
CREATE INDEX "catalog_products_tenant_name_idx" ON "catalog"."products" ("tenant_id","name");--> statement-breakpoint
ALTER TABLE "catalog"."product_lifecycle_events" ADD CONSTRAINT "catalog_product_lifecycle_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "catalog"."products"("tenant_id","product_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_revisions" ADD CONSTRAINT "catalog_product_revisions_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "catalog"."products"("tenant_id","product_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_variants" ADD CONSTRAINT "catalog_product_variants_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "catalog"."products"("tenant_id","product_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "catalog_product_lifecycle_tenant_select" ON "catalog"."product_lifecycle_events" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_lifecycle_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_lifecycle_tenant_insert" ON "catalog"."product_lifecycle_events" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_lifecycle_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_lifecycle_tenant_update" ON "catalog"."product_lifecycle_events" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_lifecycle_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_lifecycle_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_lifecycle_tenant_delete" ON "catalog"."product_lifecycle_events" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_lifecycle_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_revisions_tenant_select" ON "catalog"."product_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_revisions_tenant_insert" ON "catalog"."product_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_revisions_tenant_update" ON "catalog"."product_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_revisions_tenant_delete" ON "catalog"."product_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_variants_tenant_select" ON "catalog"."product_variants" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_variants"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_variants_tenant_insert" ON "catalog"."product_variants" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_variants"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_variants_tenant_update" ON "catalog"."product_variants" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_variants"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_variants"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_variants_tenant_delete" ON "catalog"."product_variants" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_variants"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_products_tenant_select" ON "catalog"."products" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."products"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_products_tenant_insert" ON "catalog"."products" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."products"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_products_tenant_update" ON "catalog"."products" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."products"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."products"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_products_tenant_delete" ON "catalog"."products" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."products"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);