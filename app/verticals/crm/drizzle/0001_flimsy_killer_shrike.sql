CREATE TABLE "crm"."customers" (
	"customer_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"company_registration_number" text,
	"tax_identification_number" text,
	"email" text,
	"phone" text,
	"website" text,
	"address_line_1" text,
	"address_line_2" text,
	"city" text,
	"region" text,
	"postal_code" text,
	"country_code" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "crm_customers_name_ck" CHECK ("crm"."customers"."name" = btrim("crm"."customers"."name") and char_length("crm"."customers"."name") between 1 and 300),
	CONSTRAINT "crm_customers_version_ck" CHECK ("crm"."customers"."version" >= 1),
	CONSTRAINT "crm_customers_country_code_ck" CHECK ("crm"."customers"."country_code" is null or "crm"."customers"."country_code" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
ALTER TABLE "crm"."customers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm"."customers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "crm_customers_tenant_customer_uk" ON "crm"."customers" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_customers_active_registration_uk" ON "crm"."customers" USING btree ("tenant_id","company_registration_number") WHERE "crm"."customers"."company_registration_number" is not null and "crm"."customers"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "crm_customers_tenant_name_id_idx" ON "crm"."customers" USING btree ("tenant_id","name","customer_id");--> statement-breakpoint
CREATE POLICY "crm_customers_tenant_select" ON "crm"."customers" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("crm"."customers"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "crm_customers_tenant_insert" ON "crm"."customers" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("crm"."customers"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "crm_customers_tenant_update" ON "crm"."customers" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("crm"."customers"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("crm"."customers"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "crm_customers_tenant_delete" ON "crm"."customers" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("crm"."customers"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
