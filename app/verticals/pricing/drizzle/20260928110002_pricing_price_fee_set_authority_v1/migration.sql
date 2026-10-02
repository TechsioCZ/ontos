CREATE TABLE "pricing"."fee_set_heads" (
	"fee_set_head_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"fee_set_root_id" uuid NOT NULL,
	"fee_set_revision_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	CONSTRAINT "pricing_fee_set_heads_root_uk" UNIQUE("tenant_id","legal_entity_id","fee_set_root_id"),
	CONSTRAINT "pricing_fee_set_heads_generation_ck" CHECK ("generation" > 0)
);
--> statement-breakpoint
ALTER TABLE "pricing"."fee_set_heads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."fee_set_revisions" (
	"fee_set_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"fee_set_root_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"previous_fee_set_revision_id" uuid,
	"action_invocation_id" uuid NOT NULL,
	"mutation_kind" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_fee_set_revisions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","fee_set_root_id","fee_set_revision_id"),
	CONSTRAINT "pricing_fee_set_revisions_generation_uk" UNIQUE("tenant_id","legal_entity_id","fee_set_root_id","generation"),
	CONSTRAINT "pricing_fee_set_revisions_invocation_uk" UNIQUE("tenant_id","fee_set_root_id","action_invocation_id"),
	CONSTRAINT "pricing_fee_set_revisions_generation_ck" CHECK ("generation" > 0),
	CONSTRAINT "pricing_fee_set_revisions_lineage_ck" CHECK (("generation" = 1 and "previous_fee_set_revision_id" is null and "mutation_kind" in ('PRICE_PREDICATE_INITIALIZED', 'FEE_DEFINED')) or ("generation" > 1 and "previous_fee_set_revision_id" is not null and "mutation_kind" in ('FEE_DEFINED', 'FEE_SCHEDULE_CHANGED')))
);
--> statement-breakpoint
ALTER TABLE "pricing"."fee_set_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."fee_set_roots" (
	"fee_set_root_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"variant_ref" jsonb NOT NULL,
	"channel_id" text NOT NULL,
	"market_id" text NOT NULL,
	"currency_code" text NOT NULL,
	"monetary_boundary" text NOT NULL,
	"created_by_action_invocation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_fee_set_roots_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","fee_set_root_id"),
	CONSTRAINT "pricing_fee_set_roots_predicate_uk" UNIQUE("tenant_id","legal_entity_id","variant_ref","channel_id","market_id","currency_code","monetary_boundary"),
	CONSTRAINT "pricing_fee_set_roots_variant_ck" CHECK (jsonb_typeof("variant_ref") = 'object' and "variant_ref" = jsonb_build_object('moduleId', 'commerce.catalog', 'resourceId', (("variant_ref"->>'resourceId')::uuid)::text, 'resourceType', 'commerce.catalog.variant', 'tenantId', "tenant_id"::text)),
	CONSTRAINT "pricing_fee_set_roots_scope_ck" CHECK ("channel_id" in ('B2C', 'B2B') and "market_id" = btrim("market_id") and length("market_id") between 1 and 300 and "market_id" <> '*'),
	CONSTRAINT "pricing_fee_set_roots_currency_ck" CHECK ("currency_code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "pricing_fee_set_roots_boundary_ck" CHECK ("monetary_boundary" = 'PRE_TAX')
);
--> statement-breakpoint
ALTER TABLE "pricing"."fee_set_roots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."price_candidate_set_heads" (
	"price_candidate_set_head_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"price_candidate_set_root_id" uuid NOT NULL,
	"price_candidate_set_revision_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	CONSTRAINT "pricing_price_candidate_set_heads_root_uk" UNIQUE("tenant_id","legal_entity_id","price_candidate_set_root_id"),
	CONSTRAINT "pricing_price_candidate_set_heads_generation_ck" CHECK ("generation" > 0)
);
--> statement-breakpoint
ALTER TABLE "pricing"."price_candidate_set_heads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."price_candidate_set_revisions" (
	"price_candidate_set_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"price_candidate_set_root_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"previous_price_candidate_set_revision_id" uuid,
	"action_invocation_id" uuid NOT NULL,
	"mutation_kind" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_price_candidate_set_revisions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","price_candidate_set_root_id","price_candidate_set_revision_id"),
	CONSTRAINT "pricing_price_candidate_set_revisions_generation_uk" UNIQUE("tenant_id","legal_entity_id","price_candidate_set_root_id","generation"),
	CONSTRAINT "pricing_price_candidate_set_revisions_invocation_uk" UNIQUE("tenant_id","price_candidate_set_root_id","action_invocation_id"),
	CONSTRAINT "pricing_price_candidate_set_revisions_generation_ck" CHECK ("generation" > 0),
	CONSTRAINT "pricing_price_candidate_set_revisions_lineage_ck" CHECK (("generation" = 1 and "previous_price_candidate_set_revision_id" is null and "mutation_kind" = 'PRICE_DEFINED') or ("generation" > 1 and "previous_price_candidate_set_revision_id" is not null and "mutation_kind" in ('PRICE_SCHEDULE_CHANGED', 'PRICE_SOURCE_CHANGED')))
);
--> statement-breakpoint
ALTER TABLE "pricing"."price_candidate_set_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."price_candidate_set_roots" (
	"price_candidate_set_root_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"catalog_selection" jsonb NOT NULL,
	"channel_id" text NOT NULL,
	"market_id" text NOT NULL,
	"currency_code" text NOT NULL,
	"unit_ref" jsonb NOT NULL,
	"basis_quantity" numeric(38,9) NOT NULL,
	"price_group_selector" jsonb NOT NULL,
	"created_by_action_invocation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_price_candidate_set_roots_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","price_candidate_set_root_id"),
	CONSTRAINT "pricing_price_candidate_set_roots_predicate_uk" UNIQUE("tenant_id","catalog_selection","legal_entity_id","channel_id","market_id","currency_code","unit_ref","basis_quantity","price_group_selector"),
	CONSTRAINT "pricing_price_candidate_set_roots_catalog_ck" CHECK (jsonb_typeof("catalog_selection") = 'object' and "catalog_selection" #>> '{productRef,tenantId}' = "tenant_id"::text and "catalog_selection" #>> '{variantRef,tenantId}' = "tenant_id"::text),
	CONSTRAINT "pricing_price_candidate_set_roots_scope_ck" CHECK ("channel_id" = btrim("channel_id") and length("channel_id") between 1 and 300 and "channel_id" <> '*' and "market_id" = btrim("market_id") and length("market_id") between 1 and 300 and "market_id" <> '*'),
	CONSTRAINT "pricing_price_candidate_set_roots_currency_ck" CHECK ("currency_code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "pricing_price_candidate_set_roots_basis_ck" CHECK ("basis_quantity" > 0 and jsonb_typeof("unit_ref") = 'object' and "unit_ref"->>'resourceType' = 'commerce.catalog.product-unit'),
	CONSTRAINT "pricing_price_candidate_set_roots_group_ck" CHECK (jsonb_typeof("price_group_selector") = 'object' and (("price_group_selector"->>'kind' = 'NO_GROUP' and not ("price_group_selector" ? 'priceGroupRef')) or ("price_group_selector"->>'kind' = 'PRICE_GROUP' and jsonb_typeof("price_group_selector"->'priceGroupRef') = 'object')))
);
--> statement-breakpoint
ALTER TABLE "pricing"."price_candidate_set_roots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pricing"."fee_set_heads" ADD CONSTRAINT "pricing_fee_set_heads_revision_fk" FOREIGN KEY ("tenant_id","legal_entity_id","fee_set_root_id","fee_set_revision_id") REFERENCES "pricing"."fee_set_revisions"("tenant_id","legal_entity_id","fee_set_root_id","fee_set_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."fee_set_revisions" ADD CONSTRAINT "pricing_fee_set_revisions_root_fk" FOREIGN KEY ("tenant_id","legal_entity_id","fee_set_root_id") REFERENCES "pricing"."fee_set_roots"("tenant_id","legal_entity_id","fee_set_root_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."fee_set_revisions" ADD CONSTRAINT "pricing_fee_set_revisions_previous_fk" FOREIGN KEY ("tenant_id","legal_entity_id","fee_set_root_id","previous_fee_set_revision_id") REFERENCES "pricing"."fee_set_revisions"("tenant_id","legal_entity_id","fee_set_root_id","fee_set_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."price_candidate_set_heads" ADD CONSTRAINT "pricing_price_candidate_set_heads_revision_fk" FOREIGN KEY ("tenant_id","legal_entity_id","price_candidate_set_root_id","price_candidate_set_revision_id") REFERENCES "pricing"."price_candidate_set_revisions"("tenant_id","legal_entity_id","price_candidate_set_root_id","price_candidate_set_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."price_candidate_set_revisions" ADD CONSTRAINT "pricing_price_candidate_set_revisions_root_fk" FOREIGN KEY ("tenant_id","legal_entity_id","price_candidate_set_root_id") REFERENCES "pricing"."price_candidate_set_roots"("tenant_id","legal_entity_id","price_candidate_set_root_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."price_candidate_set_revisions" ADD CONSTRAINT "pricing_price_candidate_set_revisions_previous_fk" FOREIGN KEY ("tenant_id","legal_entity_id","price_candidate_set_root_id","previous_price_candidate_set_revision_id") REFERENCES "pricing"."price_candidate_set_revisions"("tenant_id","legal_entity_id","price_candidate_set_root_id","price_candidate_set_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "pricing_fee_set_heads_scope_select" ON "pricing"."fee_set_heads" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."fee_set_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."fee_set_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_fee_set_heads_scope_insert" ON "pricing"."fee_set_heads" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."fee_set_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."fee_set_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_fee_set_heads_scope_update" ON "pricing"."fee_set_heads" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("pricing"."fee_set_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."fee_set_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("pricing"."fee_set_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."fee_set_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_fee_set_heads_scope_delete" ON "pricing"."fee_set_heads" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("pricing"."fee_set_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."fee_set_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_fee_set_revisions_scope_select" ON "pricing"."fee_set_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."fee_set_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."fee_set_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_fee_set_revisions_scope_insert" ON "pricing"."fee_set_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."fee_set_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."fee_set_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_fee_set_revisions_scope_update" ON "pricing"."fee_set_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_fee_set_revisions_scope_delete" ON "pricing"."fee_set_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);--> statement-breakpoint
CREATE POLICY "pricing_fee_set_roots_scope_select" ON "pricing"."fee_set_roots" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."fee_set_roots"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."fee_set_roots"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_fee_set_roots_scope_insert" ON "pricing"."fee_set_roots" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."fee_set_roots"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."fee_set_roots"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_fee_set_roots_scope_update" ON "pricing"."fee_set_roots" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_fee_set_roots_scope_delete" ON "pricing"."fee_set_roots" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);--> statement-breakpoint
CREATE POLICY "pricing_price_candidate_set_heads_scope_select" ON "pricing"."price_candidate_set_heads" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."price_candidate_set_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_candidate_set_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_price_candidate_set_heads_scope_insert" ON "pricing"."price_candidate_set_heads" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."price_candidate_set_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_candidate_set_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_price_candidate_set_heads_scope_update" ON "pricing"."price_candidate_set_heads" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("pricing"."price_candidate_set_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_candidate_set_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("pricing"."price_candidate_set_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_candidate_set_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_price_candidate_set_heads_scope_delete" ON "pricing"."price_candidate_set_heads" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("pricing"."price_candidate_set_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_candidate_set_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_price_candidate_set_revisions_scope_select" ON "pricing"."price_candidate_set_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."price_candidate_set_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_candidate_set_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_price_candidate_set_revisions_scope_insert" ON "pricing"."price_candidate_set_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."price_candidate_set_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_candidate_set_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_price_candidate_set_revisions_scope_update" ON "pricing"."price_candidate_set_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_price_candidate_set_revisions_scope_delete" ON "pricing"."price_candidate_set_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);--> statement-breakpoint
CREATE POLICY "pricing_price_candidate_set_roots_scope_select" ON "pricing"."price_candidate_set_roots" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."price_candidate_set_roots"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_candidate_set_roots"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_price_candidate_set_roots_scope_insert" ON "pricing"."price_candidate_set_roots" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."price_candidate_set_roots"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_candidate_set_roots"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_price_candidate_set_roots_scope_update" ON "pricing"."price_candidate_set_roots" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_price_candidate_set_roots_scope_delete" ON "pricing"."price_candidate_set_roots" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);
