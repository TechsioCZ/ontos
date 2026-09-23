CREATE SCHEMA "commerce_market_catalog";
--> statement-breakpoint
CREATE TABLE "commerce_market_catalog"."market_catalog_completeness_generations" (
	"tenant_id" uuid PRIMARY KEY,
	"generation" integer DEFAULT 0 NOT NULL,
	"last_action_invocation_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_market_catalog_completeness_generation_ck" CHECK ("generation" >= 0)
);
--> statement-breakpoint
ALTER TABLE "commerce_market_catalog"."market_catalog_completeness_generations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_market_catalog"."market_definition_revisions" (
	"market_definition_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"market_id" uuid NOT NULL,
	"selling_legal_entity_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"purpose" text NOT NULL,
	"channels" jsonb NOT NULL,
	"jurisdictions" jsonb NOT NULL,
	"supported_locales" jsonb NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"change_reason" text NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_market_catalog_definition_revisions_scope_id_uk" UNIQUE("tenant_id","market_definition_revision_id"),
	CONSTRAINT "commerce_market_catalog_definition_revisions_number_uk" UNIQUE("tenant_id","market_id","revision_number"),
	CONSTRAINT "commerce_market_catalog_definition_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "commerce_market_catalog_definition_revisions_number_ck" CHECK ("revision_number" > 0),
	CONSTRAINT "commerce_market_catalog_definition_revisions_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from"),
	CONSTRAINT "commerce_market_catalog_definition_revisions_purpose_ck" CHECK ("purpose" = btrim("purpose") and length("purpose") between 1 and 500),
	CONSTRAINT "commerce_market_catalog_definition_revisions_reason_ck" CHECK ("change_reason" = btrim("change_reason") and length("change_reason") between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "commerce_market_catalog"."market_definition_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_market_catalog"."market_lifecycle_periods" (
	"market_lifecycle_period_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"market_id" uuid NOT NULL,
	"selling_legal_entity_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"lifecycle" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"reason" text NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_market_catalog_lifecycle_scope_id_uk" UNIQUE("tenant_id","market_lifecycle_period_id"),
	CONSTRAINT "commerce_market_catalog_lifecycle_revision_uk" UNIQUE("tenant_id","market_id","revision_number"),
	CONSTRAINT "commerce_market_catalog_lifecycle_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "commerce_market_catalog_lifecycle_revision_ck" CHECK ("revision_number" > 0),
	CONSTRAINT "commerce_market_catalog_lifecycle_state_ck" CHECK ("lifecycle" in ('ACTIVE', 'SUSPENDED', 'RETIRED')),
	CONSTRAINT "commerce_market_catalog_lifecycle_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from"),
	CONSTRAINT "commerce_market_catalog_lifecycle_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "commerce_market_catalog"."market_lifecycle_periods" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_market_catalog"."markets" (
	"market_id" uuid PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"selling_legal_entity_id" uuid NOT NULL,
	"business_code" text NOT NULL,
	"current_definition_revision_id" uuid,
	"current_definition_revision" integer DEFAULT 1 NOT NULL,
	"aggregate_revision" integer DEFAULT 1 NOT NULL,
	"created_by_action_invocation_id" uuid NOT NULL,
	"created_by_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_market_catalog_markets_scope_id_uk" UNIQUE("tenant_id","market_id"),
	CONSTRAINT "commerce_market_catalog_markets_code_uk" UNIQUE("tenant_id","business_code"),
	CONSTRAINT "commerce_market_catalog_markets_code_ck" CHECK ("business_code" ~ '^[A-Z0-9][A-Z0-9_-]{1,63}$'),
	CONSTRAINT "commerce_market_catalog_markets_revision_ck" CHECK ("current_definition_revision" > 0 and "aggregate_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "commerce_market_catalog"."markets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_market_catalog"."storefront_association_revisions" (
	"storefront_association_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"storefront_association_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"market_id" uuid NOT NULL,
	"market_definition_revision_id" uuid NOT NULL,
	"selling_legal_entity_id" uuid NOT NULL,
	"storefront_app_id" text NOT NULL,
	"channel" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"provenance_kind" text NOT NULL,
	"provenance_reference" text NOT NULL,
	"removed_at" timestamp with time zone,
	"reason" text NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_market_catalog_association_revisions_scope_id_uk" UNIQUE("tenant_id","storefront_association_revision_id"),
	CONSTRAINT "commerce_market_catalog_association_revisions_number_uk" UNIQUE("tenant_id","storefront_association_id","revision_number"),
	CONSTRAINT "commerce_market_catalog_association_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "commerce_market_catalog_association_revisions_number_ck" CHECK ("revision_number" > 0),
	CONSTRAINT "commerce_market_catalog_association_revisions_channel_ck" CHECK ("channel" in ('B2C', 'B2B')),
	CONSTRAINT "commerce_market_catalog_association_revisions_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from"),
	CONSTRAINT "commerce_market_catalog_association_revisions_storefront_ck" CHECK ("storefront_app_id" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
	CONSTRAINT "commerce_market_catalog_association_revisions_removal_ck" CHECK ("removed_at" is null or "removed_at" >= "effective_from")
);
--> statement-breakpoint
ALTER TABLE "commerce_market_catalog"."storefront_association_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_market_catalog"."storefront_associations" (
	"storefront_association_id" uuid PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"selling_legal_entity_id" uuid NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"created_by_action_invocation_id" uuid NOT NULL,
	"created_by_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_market_catalog_associations_scope_id_uk" UNIQUE("tenant_id","storefront_association_id"),
	CONSTRAINT "commerce_market_catalog_associations_revision_ck" CHECK ("current_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "commerce_market_catalog"."storefront_associations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "commerce_market_catalog_markets_seller_idx" ON "commerce_market_catalog"."markets" ("tenant_id","selling_legal_entity_id");--> statement-breakpoint
CREATE INDEX "commerce_market_catalog_association_revisions_eligibility_idx" ON "commerce_market_catalog"."storefront_association_revisions" ("tenant_id","storefront_app_id","channel","effective_from");--> statement-breakpoint
ALTER TABLE "commerce_market_catalog"."market_definition_revisions" ADD CONSTRAINT "commerce_market_catalog_definition_revisions_market_fk" FOREIGN KEY ("tenant_id","market_id") REFERENCES "commerce_market_catalog"."markets"("tenant_id","market_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_market_catalog"."market_lifecycle_periods" ADD CONSTRAINT "commerce_market_catalog_lifecycle_market_fk" FOREIGN KEY ("tenant_id","market_id") REFERENCES "commerce_market_catalog"."markets"("tenant_id","market_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_market_catalog"."storefront_association_revisions" ADD CONSTRAINT "commerce_market_catalog_association_revisions_association_fk" FOREIGN KEY ("tenant_id","storefront_association_id") REFERENCES "commerce_market_catalog"."storefront_associations"("tenant_id","storefront_association_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_market_catalog"."storefront_association_revisions" ADD CONSTRAINT "commerce_market_catalog_association_revisions_market_fk" FOREIGN KEY ("tenant_id","market_id") REFERENCES "commerce_market_catalog"."markets"("tenant_id","market_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_market_catalog"."storefront_association_revisions" ADD CONSTRAINT "commerce_market_catalog_association_revisions_definition_fk" FOREIGN KEY ("tenant_id","market_definition_revision_id") REFERENCES "commerce_market_catalog"."market_definition_revisions"("tenant_id","market_definition_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "commerce_market_catalog_completeness_tenant_select" ON "commerce_market_catalog"."market_catalog_completeness_generations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_market_catalog"."market_catalog_completeness_generations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_market_catalog_completeness_tenant_insert" ON "commerce_market_catalog"."market_catalog_completeness_generations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_market_catalog"."market_catalog_completeness_generations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_market_catalog_completeness_tenant_update" ON "commerce_market_catalog"."market_catalog_completeness_generations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_market_catalog"."market_catalog_completeness_generations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("commerce_market_catalog"."market_catalog_completeness_generations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_market_catalog_completeness_tenant_delete" ON "commerce_market_catalog"."market_catalog_completeness_generations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_market_catalog"."market_catalog_completeness_generations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_market_catalog_definition_revisions_tenant_select" ON "commerce_market_catalog"."market_definition_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_market_catalog"."market_definition_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_market_catalog_definition_revisions_tenant_insert" ON "commerce_market_catalog"."market_definition_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_market_catalog"."market_definition_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_market_catalog_definition_revisions_tenant_update" ON "commerce_market_catalog"."market_definition_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_market_catalog"."market_definition_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("commerce_market_catalog"."market_definition_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_market_catalog_definition_revisions_tenant_delete" ON "commerce_market_catalog"."market_definition_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_market_catalog"."market_definition_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_market_catalog_lifecycle_tenant_select" ON "commerce_market_catalog"."market_lifecycle_periods" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_market_catalog"."market_lifecycle_periods"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_market_catalog_lifecycle_tenant_insert" ON "commerce_market_catalog"."market_lifecycle_periods" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_market_catalog"."market_lifecycle_periods"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_market_catalog_lifecycle_tenant_update" ON "commerce_market_catalog"."market_lifecycle_periods" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_market_catalog"."market_lifecycle_periods"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("commerce_market_catalog"."market_lifecycle_periods"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_market_catalog_lifecycle_tenant_delete" ON "commerce_market_catalog"."market_lifecycle_periods" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_market_catalog"."market_lifecycle_periods"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_market_catalog_markets_tenant_select" ON "commerce_market_catalog"."markets" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_market_catalog"."markets"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_market_catalog_markets_tenant_insert" ON "commerce_market_catalog"."markets" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_market_catalog"."markets"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_market_catalog_markets_tenant_update" ON "commerce_market_catalog"."markets" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_market_catalog"."markets"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("commerce_market_catalog"."markets"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_market_catalog_markets_tenant_delete" ON "commerce_market_catalog"."markets" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_market_catalog"."markets"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_market_catalog_association_revisions_tenant_select" ON "commerce_market_catalog"."storefront_association_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_market_catalog"."storefront_association_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_market_catalog_association_revisions_tenant_insert" ON "commerce_market_catalog"."storefront_association_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_market_catalog"."storefront_association_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_market_catalog_association_revisions_tenant_update" ON "commerce_market_catalog"."storefront_association_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_market_catalog"."storefront_association_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("commerce_market_catalog"."storefront_association_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_market_catalog_association_revisions_tenant_delete" ON "commerce_market_catalog"."storefront_association_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_market_catalog"."storefront_association_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_market_catalog_associations_tenant_select" ON "commerce_market_catalog"."storefront_associations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_market_catalog"."storefront_associations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_market_catalog_associations_tenant_insert" ON "commerce_market_catalog"."storefront_associations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_market_catalog"."storefront_associations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_market_catalog_associations_tenant_update" ON "commerce_market_catalog"."storefront_associations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_market_catalog"."storefront_associations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("commerce_market_catalog"."storefront_associations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "commerce_market_catalog_associations_tenant_delete" ON "commerce_market_catalog"."storefront_associations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_market_catalog"."storefront_associations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);