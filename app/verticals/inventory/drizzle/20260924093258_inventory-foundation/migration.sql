CREATE SCHEMA "inventory";
--> statement-breakpoint
CREATE TABLE "inventory"."stock_items" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"exact_selection_kind" text NOT NULL,
	"exact_selection_meaning_id" text NOT NULL,
	"lifecycle_state" text DEFAULT 'CURRENT' NOT NULL,
	"retired_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"stock_item_id" uuid PRIMARY KEY,
	"stock_unit_module_id" text NOT NULL,
	"stock_unit_resource_id" uuid NOT NULL,
	"stock_unit_resource_type" text NOT NULL,
	"stock_unit_tenant_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "inventory_stock_items_meaning_ck" CHECK (char_length(btrim("exact_selection_meaning_id")) between 1 and 300 and "exact_selection_kind" in ('PRODUCT_VARIANT', 'PACKAGE_OPTION', 'SET_VARIANT', 'CONFIGURED_SELECTION')),
	CONSTRAINT "inventory_stock_items_unit_ck" CHECK ("stock_unit_module_id" = 'commerce.catalog' and "stock_unit_resource_type" = 'commerce.catalog.product-unit' and "stock_unit_tenant_id" = "tenant_id"),
	CONSTRAINT "inventory_stock_items_revision_ck" CHECK ("revision" >= 1),
	CONSTRAINT "inventory_stock_items_lifecycle_ck" CHECK ("lifecycle_state" in ('CURRENT', 'RETIRED')),
	CONSTRAINT "inventory_stock_items_retirement_ck" CHECK (("lifecycle_state" = 'CURRENT' and "retired_at" is null) or ("lifecycle_state" = 'RETIRED' and "retired_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "inventory"."stock_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "inventory"."stock_location_revisions" (
	"stock_location_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"stock_location_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_stock_location_revisions_scope_id_uk" UNIQUE("tenant_id","stock_location_revision_id"),
	CONSTRAINT "inventory_stock_location_revisions_number_uk" UNIQUE("tenant_id","stock_location_id","revision"),
	CONSTRAINT "inventory_stock_location_revisions_revision_ck" CHECK ("revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "inventory"."stock_location_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "inventory"."stock_locations" (
	"stock_location_id" uuid PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"scope_kind" text NOT NULL,
	"physical_site_keys" jsonb NOT NULL,
	"address_evidence" jsonb,
	"lifecycle_state" text NOT NULL,
	"successor_stock_location_id" uuid,
	"transition_reason" text,
	"transitioned_at" timestamp with time zone,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_stock_locations_scope_id_uk" UNIQUE("tenant_id","stock_location_id"),
	CONSTRAINT "inventory_stock_locations_revision_ck" CHECK ("current_revision" >= 1),
	CONSTRAINT "inventory_stock_locations_display_name_ck" CHECK ("display_name" = btrim("display_name") and length("display_name") between 1 and 300),
	CONSTRAINT "inventory_stock_locations_scope_kind_ck" CHECK ("scope_kind" in ('PHYSICAL_SITE', 'LOGICAL_AGGREGATE')),
	CONSTRAINT "inventory_stock_locations_site_keys_ck" CHECK (jsonb_typeof("physical_site_keys") = 'array' and jsonb_array_length("physical_site_keys") <= 100 and ("scope_kind" <> 'PHYSICAL_SITE' or jsonb_array_length("physical_site_keys") = 1)),
	CONSTRAINT "inventory_stock_locations_lifecycle_ck" CHECK ("lifecycle_state" in ('ACTIVE', 'RETIRED', 'REPLACED', 'MERGED')),
	CONSTRAINT "inventory_stock_locations_successor_ck" CHECK ((("lifecycle_state" in ('ACTIVE', 'RETIRED')) and "successor_stock_location_id" is null) or (("lifecycle_state" in ('REPLACED', 'MERGED')) and "successor_stock_location_id" is not null and "successor_stock_location_id" <> "stock_location_id")),
	CONSTRAINT "inventory_stock_locations_transition_ck" CHECK (("lifecycle_state" = 'ACTIVE' and "transition_reason" is null and "transitioned_at" is null) or ("lifecycle_state" <> 'ACTIVE' and "transition_reason" = btrim("transition_reason") and length("transition_reason") between 1 and 1000 and "transitioned_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "inventory"."stock_locations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_stock_items_scope_id_uk" ON "inventory"."stock_items" ("tenant_id","stock_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_stock_items_exact_meaning_uk" ON "inventory"."stock_items" ("tenant_id","exact_selection_meaning_id");--> statement-breakpoint
CREATE INDEX "inventory_stock_items_current_idx" ON "inventory"."stock_items" ("tenant_id","lifecycle_state") WHERE "lifecycle_state" = 'CURRENT';--> statement-breakpoint
CREATE INDEX "inventory_stock_locations_lifecycle_idx" ON "inventory"."stock_locations" ("tenant_id","lifecycle_state");--> statement-breakpoint
ALTER TABLE "inventory"."stock_location_revisions" ADD CONSTRAINT "inventory_stock_location_revisions_location_fk" FOREIGN KEY ("tenant_id","stock_location_id") REFERENCES "inventory"."stock_locations"("tenant_id","stock_location_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory"."stock_locations" ADD CONSTRAINT "inventory_stock_locations_successor_fk" FOREIGN KEY ("tenant_id","successor_stock_location_id") REFERENCES "inventory"."stock_locations"("tenant_id","stock_location_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "inventory_stock_items_tenant_select" ON "inventory"."stock_items" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."stock_items"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_items_tenant_insert" ON "inventory"."stock_items" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."stock_items"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_items_tenant_update" ON "inventory"."stock_items" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."stock_items"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."stock_items"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_items_tenant_delete" ON "inventory"."stock_items" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."stock_items"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_location_revisions_tenant_select" ON "inventory"."stock_location_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."stock_location_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_location_revisions_tenant_insert" ON "inventory"."stock_location_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."stock_location_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_location_revisions_tenant_update" ON "inventory"."stock_location_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."stock_location_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."stock_location_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_location_revisions_tenant_delete" ON "inventory"."stock_location_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."stock_location_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_locations_tenant_select" ON "inventory"."stock_locations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."stock_locations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_locations_tenant_insert" ON "inventory"."stock_locations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."stock_locations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_locations_tenant_update" ON "inventory"."stock_locations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."stock_locations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."stock_locations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_stock_locations_tenant_delete" ON "inventory"."stock_locations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."stock_locations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);