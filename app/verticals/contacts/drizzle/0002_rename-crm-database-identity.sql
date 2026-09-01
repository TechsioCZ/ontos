DO $$
BEGIN
  IF to_regnamespace('crm') IS NOT NULL AND to_regnamespace('contacts') IS NOT NULL THEN
    RAISE EXCEPTION 'Ambiguous Contacts migration state: both crm and contacts schemas exist';
  END IF;
  IF to_regnamespace('crm') IS NOT NULL THEN
    ALTER SCHEMA crm RENAME TO contacts;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "contacts"."contacts" RENAME CONSTRAINT "crm_contacts_name_ck" TO "contacts_contacts_name_ck";
--> statement-breakpoint
ALTER TABLE "contacts"."contacts" RENAME CONSTRAINT "crm_contacts_email_ck" TO "contacts_contacts_email_ck";
--> statement-breakpoint
ALTER TABLE "contacts"."contacts" RENAME CONSTRAINT "crm_contacts_phone_ck" TO "contacts_contacts_phone_ck";
--> statement-breakpoint
ALTER TABLE "contacts"."contacts" RENAME CONSTRAINT "crm_contacts_tenant_customer_fk" TO "contacts_contacts_tenant_customer_fk";
--> statement-breakpoint
ALTER TABLE "contacts"."customers" RENAME CONSTRAINT "crm_customers_tenant_id_uk" TO "contacts_customers_tenant_id_uk";
--> statement-breakpoint
ALTER TABLE "contacts"."customers" RENAME CONSTRAINT "crm_customers_name_ck" TO "contacts_customers_name_ck";
--> statement-breakpoint
ALTER TABLE "contacts"."customers" RENAME CONSTRAINT "crm_customers_ico_ck" TO "contacts_customers_ico_ck";
--> statement-breakpoint
ALTER TABLE "contacts"."customers" RENAME CONSTRAINT "crm_customers_dic_ck" TO "contacts_customers_dic_ck";
--> statement-breakpoint
ALTER TABLE "contacts"."customers" RENAME CONSTRAINT "crm_customers_legal_form_code_ck" TO "contacts_customers_legal_form_code_ck";
--> statement-breakpoint
ALTER TABLE "contacts"."customers" RENAME CONSTRAINT "crm_customers_lifecycle_dates_ck" TO "contacts_customers_lifecycle_dates_ck";
--> statement-breakpoint
ALTER INDEX "contacts"."crm_contacts_tenant_id_uk" RENAME TO "contacts_contacts_tenant_id_uk";
--> statement-breakpoint
ALTER INDEX "contacts"."crm_contacts_tenant_customer_active_idx" RENAME TO "contacts_contacts_tenant_customer_active_idx";
--> statement-breakpoint
ALTER INDEX "contacts"."crm_customers_tenant_active_idx" RENAME TO "contacts_customers_tenant_active_idx";
--> statement-breakpoint
ALTER INDEX "contacts"."crm_customers_tenant_ico_uk" RENAME TO "contacts_customers_tenant_ico_uk";
--> statement-breakpoint
ALTER POLICY "crm_contacts_tenant_select" ON "contacts"."contacts" RENAME TO "contacts_contacts_tenant_select";
--> statement-breakpoint
ALTER POLICY "crm_contacts_tenant_insert" ON "contacts"."contacts" RENAME TO "contacts_contacts_tenant_insert";
--> statement-breakpoint
ALTER POLICY "crm_contacts_tenant_update" ON "contacts"."contacts" RENAME TO "contacts_contacts_tenant_update";
--> statement-breakpoint
ALTER POLICY "crm_contacts_tenant_delete" ON "contacts"."contacts" RENAME TO "contacts_contacts_tenant_delete";
--> statement-breakpoint
ALTER POLICY "crm_customers_tenant_select" ON "contacts"."customers" RENAME TO "contacts_customers_tenant_select";
--> statement-breakpoint
ALTER POLICY "crm_customers_tenant_insert" ON "contacts"."customers" RENAME TO "contacts_customers_tenant_insert";
--> statement-breakpoint
ALTER POLICY "crm_customers_tenant_update" ON "contacts"."customers" RENAME TO "contacts_customers_tenant_update";
--> statement-breakpoint
ALTER POLICY "crm_customers_tenant_delete" ON "contacts"."customers" RENAME TO "contacts_customers_tenant_delete";
