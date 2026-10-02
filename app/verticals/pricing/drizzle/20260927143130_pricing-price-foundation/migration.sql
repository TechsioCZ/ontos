CREATE TABLE "pricing"."price_current_revisions" (
	"price_current_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"price_id" uuid NOT NULL,
	"price_revision_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"bound_by_action_invocation_id" uuid NOT NULL,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_price_current_scope_price_uk" UNIQUE("tenant_id","legal_entity_id","price_id"),
	CONSTRAINT "pricing_price_current_scope_revision_uk" UNIQUE("tenant_id","legal_entity_id","price_id","price_revision_id"),
	CONSTRAINT "pricing_price_current_revision_number_ck" CHECK ("revision_number" > 0)
);
--> statement-breakpoint
ALTER TABLE "pricing"."price_current_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."price_revisions" (
	"price_revision_id" uuid PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"price_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"amount" numeric(38,9) NOT NULL,
	"currency_code" text NOT NULL,
	"monetary_boundary" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_price_revisions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","price_id","price_revision_id"),
	CONSTRAINT "pricing_price_revisions_number_uk" UNIQUE("tenant_id","legal_entity_id","price_id","revision_number"),
	CONSTRAINT "pricing_price_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "pricing_price_revisions_number_ck" CHECK ("revision_number" > 0),
	CONSTRAINT "pricing_price_revisions_amount_ck" CHECK ("amount" >= 0),
	CONSTRAINT "pricing_price_revisions_currency_ck" CHECK ("currency_code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "pricing_price_revisions_boundary_ck" CHECK ("monetary_boundary" = 'PRE_TAX'),
	CONSTRAINT "pricing_price_revisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "pricing"."price_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."prices" (
	"price_id" uuid PRIMARY KEY,
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
	"created_by_principal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_prices_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","price_id"),
	CONSTRAINT "pricing_prices_invocation_uk" UNIQUE("tenant_id","created_by_action_invocation_id"),
	CONSTRAINT "pricing_prices_exact_identity_uk" UNIQUE("tenant_id","catalog_selection","legal_entity_id","channel_id","market_id","currency_code","unit_ref","basis_quantity","price_group_selector"),
	CONSTRAINT "pricing_prices_catalog_selection_ck" CHECK (jsonb_typeof("catalog_selection") = 'object' and jsonb_typeof("catalog_selection"->'productRef') = 'object' and jsonb_typeof("catalog_selection"->'variantRef') = 'object'),
	CONSTRAINT "pricing_prices_commercial_scope_ck" CHECK ("channel_id" = btrim("channel_id") and length("channel_id") between 1 and 300 and "channel_id" <> '*' and "market_id" = btrim("market_id") and length("market_id") between 1 and 300 and "market_id" <> '*'),
	CONSTRAINT "pricing_prices_currency_ck" CHECK ("currency_code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "pricing_prices_unit_basis_ck" CHECK ("basis_quantity" > 0 and jsonb_typeof("unit_ref") = 'object' and "unit_ref"->>'resourceType' = 'commerce.catalog.product-unit'),
	CONSTRAINT "pricing_prices_group_selector_ck" CHECK (jsonb_typeof("price_group_selector") = 'object' and (("price_group_selector"->>'kind' = 'NO_GROUP' and not ("price_group_selector" ? 'priceGroupRef')) or ("price_group_selector"->>'kind' = 'PRICE_GROUP' and jsonb_typeof("price_group_selector"->'priceGroupRef') = 'object')))
);
--> statement-breakpoint
ALTER TABLE "pricing"."prices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "pricing_price_revisions_history_idx" ON "pricing"."price_revisions" ("tenant_id","legal_entity_id","price_id","revision_number");--> statement-breakpoint
ALTER TABLE "pricing"."price_current_revisions" ADD CONSTRAINT "pricing_price_current_revision_fk" FOREIGN KEY ("tenant_id","legal_entity_id","price_id","price_revision_id") REFERENCES "pricing"."price_revisions"("tenant_id","legal_entity_id","price_id","price_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."price_revisions" ADD CONSTRAINT "pricing_price_revisions_price_fk" FOREIGN KEY ("tenant_id","legal_entity_id","price_id") REFERENCES "pricing"."prices"("tenant_id","legal_entity_id","price_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "pricing_price_current_scope_select" ON "pricing"."price_current_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."price_current_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_current_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_price_current_scope_insert" ON "pricing"."price_current_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."price_current_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_current_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_price_current_scope_update" ON "pricing"."price_current_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("pricing"."price_current_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_current_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("pricing"."price_current_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_current_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_price_current_scope_delete" ON "pricing"."price_current_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("pricing"."price_current_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_current_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_price_revisions_scope_select" ON "pricing"."price_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."price_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_price_revisions_scope_insert" ON "pricing"."price_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."price_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_price_revisions_scope_update" ON "pricing"."price_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("pricing"."price_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("pricing"."price_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_price_revisions_scope_delete" ON "pricing"."price_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("pricing"."price_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_prices_scope_select" ON "pricing"."prices" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."prices"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."prices"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_prices_scope_insert" ON "pricing"."prices" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."prices"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."prices"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_prices_scope_update" ON "pricing"."prices" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("pricing"."prices"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."prices"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("pricing"."prices"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."prices"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_prices_scope_delete" ON "pricing"."prices" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("pricing"."prices"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."prices"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);