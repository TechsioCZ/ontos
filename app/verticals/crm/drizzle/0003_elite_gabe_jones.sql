CREATE TYPE "crm"."deal_currency_code" AS ENUM('AED', 'AFN', 'ALL', 'AMD', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN', 'BAM', 'BBD', 'BDT', 'BHD', 'BIF', 'BMD', 'BND', 'BOB', 'BOV', 'BRL', 'BSD', 'BTN', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHE', 'CHF', 'CHW', 'CLF', 'CLP', 'CNY', 'COP', 'COU', 'CRC', 'CUP', 'CVE', 'CZK', 'DJF', 'DKK', 'DOP', 'DZD', 'EGP', 'ERN', 'ETB', 'EUR', 'FJD', 'FKP', 'GBP', 'GEL', 'GHS', 'GIP', 'GMD', 'GNF', 'GTQ', 'GYD', 'HKD', 'HNL', 'HTG', 'HUF', 'IDR', 'ILS', 'INR', 'IQD', 'IRR', 'ISK', 'JMD', 'JOD', 'JPY', 'KES', 'KGS', 'KHR', 'KMF', 'KPW', 'KRW', 'KWD', 'KYD', 'KZT', 'LAK', 'LBP', 'LKR', 'LRD', 'LSL', 'LYD', 'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MRU', 'MUR', 'MVR', 'MWK', 'MXN', 'MXV', 'MYR', 'MZN', 'NAD', 'NGN', 'NIO', 'NOK', 'NPR', 'NZD', 'OMR', 'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'PYG', 'QAR', 'RON', 'RSD', 'RUB', 'RWF', 'SAR', 'SBD', 'SCR', 'SDG', 'SEK', 'SGD', 'SHP', 'SLE', 'SOS', 'SRD', 'SSP', 'STN', 'SVC', 'SYP', 'SZL', 'THB', 'TJS', 'TMT', 'TND', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS', 'UAH', 'UGX', 'USD', 'USN', 'UYI', 'UYU', 'UYW', 'UZS', 'VED', 'VES', 'VND', 'VUV', 'WST', 'XAD', 'XAF', 'XAG', 'XAU', 'XBA', 'XBB', 'XBC', 'XBD', 'XCD', 'XCG', 'XDR', 'XOF', 'XPD', 'XPF', 'XPT', 'XSU', 'XTS', 'XUA', 'XXX', 'YER', 'ZAR', 'ZMW', 'ZWG');--> statement-breakpoint
CREATE TABLE "crm"."deals" (
	"deal_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"contact_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"expected_value" numeric(14, 2) NOT NULL,
	"currency" "crm"."deal_currency_code" NOT NULL,
	"expected_close_date" date,
	"status" text DEFAULT 'New' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "crm_deals_title_ck" CHECK ("crm"."deals"."title" = btrim("crm"."deals"."title") and char_length("crm"."deals"."title") between 1 and 300),
	CONSTRAINT "crm_deals_description_ck" CHECK ("crm"."deals"."description" is null or ("crm"."deals"."description" = btrim("crm"."deals"."description") and char_length("crm"."deals"."description") between 1 and 5000)),
	CONSTRAINT "crm_deals_expected_value_ck" CHECK ("crm"."deals"."expected_value" >= 0 and "crm"."deals"."expected_value" <= 999999999999.99),
	CONSTRAINT "crm_deals_expected_close_date_ck" CHECK ("crm"."deals"."expected_close_date" is null or extract(year from "crm"."deals"."expected_close_date") between 1 and 9999),
	CONSTRAINT "crm_deals_status_ck" CHECK ("crm"."deals"."status" in ('New', 'Qualified', 'Offer sent', 'Negotiation', 'Won', 'Lost')),
	CONSTRAINT "crm_deals_version_ck" CHECK ("crm"."deals"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "crm"."deals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm"."deals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm"."deals" ADD CONSTRAINT "crm_deals_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "crm"."customers"("tenant_id","customer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."deals" ADD CONSTRAINT "crm_deals_contact_fk" FOREIGN KEY ("tenant_id","customer_id","contact_id") REFERENCES "crm"."contacts"("tenant_id","customer_id","contact_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "crm_deals_tenant_legal_entity_deal_uk" ON "crm"."deals" USING btree ("tenant_id","legal_entity_id","deal_id");--> statement-breakpoint
CREATE INDEX "crm_deals_active_scope_updated_id_idx" ON "crm"."deals" USING btree ("tenant_id","legal_entity_id","updated_at" DESC NULLS LAST,"deal_id" DESC NULLS LAST) WHERE "crm"."deals"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "crm_deals_active_scope_customer_updated_id_idx" ON "crm"."deals" USING btree ("tenant_id","legal_entity_id","customer_id","updated_at" DESC NULLS LAST,"deal_id" DESC NULLS LAST) WHERE "crm"."deals"."deleted_at" is null;--> statement-breakpoint
CREATE POLICY "crm_deals_tenant_legal_entity_select" ON "crm"."deals" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("crm"."deals"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "crm"."deals"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "crm_deals_tenant_legal_entity_insert" ON "crm"."deals" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("crm"."deals"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "crm"."deals"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "crm_deals_tenant_legal_entity_update" ON "crm"."deals" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("crm"."deals"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "crm"."deals"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("crm"."deals"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "crm"."deals"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "crm_deals_tenant_legal_entity_delete" ON "crm"."deals" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("crm"."deals"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "crm"."deals"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
