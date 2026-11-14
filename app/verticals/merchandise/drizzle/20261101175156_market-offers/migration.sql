CREATE TABLE "demo_merchandise"."market_product_offers" (
	"legal_entity_id" uuid,
	"tenant_id" uuid,
	"market_id" uuid,
	"offered" boolean NOT NULL,
	"product_id" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "market_product_offers_pkey" PRIMARY KEY("tenant_id","legal_entity_id","market_id","product_id")
);
--> statement-breakpoint
ALTER TABLE "demo_merchandise"."market_product_offers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "demo_merchandise"."market_settings" (
	"legal_entity_id" uuid,
	"tenant_id" uuid,
	"currency" text NOT NULL,
	"exchange_rate" numeric NOT NULL,
	"market_code" text NOT NULL,
	"market_id" uuid,
	"offer_mode" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"rounding_minor" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "market_settings_pkey" PRIMARY KEY("tenant_id","legal_entity_id","market_id"),
	CONSTRAINT "demo_merchandise_market_offer_mode" CHECK ("offer_mode" in ('WHOLE_CATALOGUE', 'SELECTED_PRODUCTS')),
	CONSTRAINT "demo_merchandise_market_currency" CHECK ("currency" in ('CZK', 'EUR', 'PLN')),
	CONSTRAINT "demo_merchandise_market_rate_positive" CHECK ("exchange_rate" > 0),
	CONSTRAINT "demo_merchandise_market_rounding_positive" CHECK ("rounding_minor" >= 1),
	CONSTRAINT "demo_merchandise_market_revision_positive" CHECK ("revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "demo_merchandise"."market_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "demo_merchandise_market_offers_product" ON "demo_merchandise"."market_product_offers" ("tenant_id","legal_entity_id","product_id");--> statement-breakpoint
CREATE POLICY "demo_merchandise_market_offer_scope_select" ON "demo_merchandise"."market_product_offers" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("demo_merchandise"."market_product_offers"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "demo_merchandise"."market_product_offers"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "demo_merchandise_market_offer_scope_insert" ON "demo_merchandise"."market_product_offers" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("demo_merchandise"."market_product_offers"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "demo_merchandise"."market_product_offers"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "demo_merchandise_market_offer_scope_update" ON "demo_merchandise"."market_product_offers" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("demo_merchandise"."market_product_offers"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "demo_merchandise"."market_product_offers"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("demo_merchandise"."market_product_offers"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "demo_merchandise"."market_product_offers"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "demo_merchandise_market_offer_scope_delete" ON "demo_merchandise"."market_product_offers" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("demo_merchandise"."market_product_offers"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "demo_merchandise"."market_product_offers"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "demo_merchandise_market_scope_select" ON "demo_merchandise"."market_settings" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("demo_merchandise"."market_settings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "demo_merchandise"."market_settings"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "demo_merchandise_market_scope_insert" ON "demo_merchandise"."market_settings" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("demo_merchandise"."market_settings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "demo_merchandise"."market_settings"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "demo_merchandise_market_scope_update" ON "demo_merchandise"."market_settings" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("demo_merchandise"."market_settings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "demo_merchandise"."market_settings"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("demo_merchandise"."market_settings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "demo_merchandise"."market_settings"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "demo_merchandise_market_scope_delete" ON "demo_merchandise"."market_settings" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("demo_merchandise"."market_settings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "demo_merchandise"."market_settings"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "demo_merchandise"."market_settings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "demo_merchandise"."market_product_offers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "demo_merchandise"."market_settings", "demo_merchandise"."market_product_offers" TO ontos_runtime;
