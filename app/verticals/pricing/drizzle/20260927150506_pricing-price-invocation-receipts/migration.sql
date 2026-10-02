CREATE TABLE "pricing"."price_invocation_receipts" (
	"price_invocation_receipt_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"requested_price_id" uuid NOT NULL,
	"resolved_price_id" uuid NOT NULL,
	"resolved_price_revision_id" uuid NOT NULL,
	"catalog_selection" jsonb NOT NULL,
	"channel_id" text NOT NULL,
	"market_id" text NOT NULL,
	"currency_code" text NOT NULL,
	"unit_ref" jsonb NOT NULL,
	"basis_quantity" numeric(38,9) NOT NULL,
	"price_group_selector" jsonb NOT NULL,
	"amount" numeric(38,9) NOT NULL,
	"monetary_boundary" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_price_invocation_receipts_action_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "pricing_price_invocation_receipts_catalog_selection_ck" CHECK (jsonb_typeof("catalog_selection") = 'object' and jsonb_typeof("catalog_selection"->'productRef') = 'object' and jsonb_typeof("catalog_selection"->'variantRef') = 'object'),
	CONSTRAINT "pricing_price_invocation_receipts_dimensions_ck" CHECK ("channel_id" = btrim("channel_id") and length("channel_id") between 1 and 300 and "channel_id" <> '*' and "market_id" = btrim("market_id") and length("market_id") between 1 and 300 and "market_id" <> '*'),
	CONSTRAINT "pricing_price_invocation_receipts_currency_ck" CHECK ("currency_code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "pricing_price_invocation_receipts_values_ck" CHECK ("basis_quantity" > 0 and "amount" >= 0 and "monetary_boundary" = 'PRE_TAX'),
	CONSTRAINT "pricing_price_invocation_receipts_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "pricing"."price_invocation_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "pricing_price_invocation_receipts_resolved_idx" ON "pricing"."price_invocation_receipts" ("tenant_id","legal_entity_id","resolved_price_id","resolved_price_revision_id");--> statement-breakpoint
ALTER TABLE "pricing"."price_invocation_receipts" ADD CONSTRAINT "pricing_price_invocation_receipts_revision_fk" FOREIGN KEY ("tenant_id","legal_entity_id","resolved_price_id","resolved_price_revision_id") REFERENCES "pricing"."price_revisions"("tenant_id","legal_entity_id","price_id","price_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "pricing_price_invocation_receipts_scope_select" ON "pricing"."price_invocation_receipts" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."price_invocation_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_invocation_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_price_invocation_receipts_scope_insert" ON "pricing"."price_invocation_receipts" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."price_invocation_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."price_invocation_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_price_invocation_receipts_scope_update" ON "pricing"."price_invocation_receipts" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_price_invocation_receipts_scope_delete" ON "pricing"."price_invocation_receipts" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);