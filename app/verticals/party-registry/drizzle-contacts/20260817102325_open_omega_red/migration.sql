ALTER TABLE "crm"."customers" ADD COLUMN "ico" text;--> statement-breakpoint
ALTER TABLE "crm"."customers" ADD COLUMN "dic" text;--> statement-breakpoint
ALTER TABLE "crm"."customers" ADD COLUMN "legal_form_code" text;--> statement-breakpoint
ALTER TABLE "crm"."customers" ADD COLUMN "established_on" date;--> statement-breakpoint
ALTER TABLE "crm"."customers" ADD COLUMN "dissolved_on" date;--> statement-breakpoint
CREATE UNIQUE INDEX "crm_customers_tenant_ico_uk" ON "crm"."customers" USING btree ("tenant_id","ico");--> statement-breakpoint
ALTER TABLE "crm"."customers" ADD CONSTRAINT "crm_customers_ico_ck" CHECK ("crm"."customers"."ico" is null or "crm"."customers"."ico" ~ '^[0-9]{8}$');--> statement-breakpoint
ALTER TABLE "crm"."customers" ADD CONSTRAINT "crm_customers_dic_ck" CHECK ("crm"."customers"."dic" is null or ("crm"."customers"."dic" = btrim("crm"."customers"."dic") and length("crm"."customers"."dic") between 1 and 20));--> statement-breakpoint
ALTER TABLE "crm"."customers" ADD CONSTRAINT "crm_customers_legal_form_code_ck" CHECK ("crm"."customers"."legal_form_code" is null or "crm"."customers"."legal_form_code" ~ '^[0-9]{3}$');--> statement-breakpoint
ALTER TABLE "crm"."customers" ADD CONSTRAINT "crm_customers_lifecycle_dates_ck" CHECK ("crm"."customers"."dissolved_on" is null or "crm"."customers"."established_on" is null or "crm"."customers"."dissolved_on" >= "crm"."customers"."established_on");