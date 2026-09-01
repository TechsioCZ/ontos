CREATE SCHEMA "crm";
--> statement-breakpoint
CREATE TABLE "crm"."contacts" (
	"contact_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "crm_contacts_name_ck" CHECK ("crm"."contacts"."name" = btrim("crm"."contacts"."name") and length("crm"."contacts"."name") > 0),
	CONSTRAINT "crm_contacts_email_ck" CHECK (length(btrim("crm"."contacts"."email")) > 0),
	CONSTRAINT "crm_contacts_phone_ck" CHECK (length(btrim("crm"."contacts"."phone")) > 0)
);
--> statement-breakpoint
ALTER TABLE "crm"."contacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Drizzle models RLS enablement and policies but cannot express PostgreSQL FORCE ROW LEVEL SECURITY.
ALTER TABLE "crm"."contacts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "crm"."customers" (
	"customer_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "crm_customers_tenant_id_uk" UNIQUE("tenant_id","customer_id"),
	CONSTRAINT "crm_customers_name_ck" CHECK ("crm"."customers"."name" = btrim("crm"."customers"."name") and length("crm"."customers"."name") > 0)
);
--> statement-breakpoint
ALTER TABLE "crm"."customers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Drizzle models RLS enablement and policies but cannot express PostgreSQL FORCE ROW LEVEL SECURITY.
ALTER TABLE "crm"."customers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm"."contacts" ADD CONSTRAINT "crm_contacts_tenant_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "crm"."customers"("tenant_id","customer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "crm_contacts_tenant_id_uk" ON "crm"."contacts" USING btree ("tenant_id","contact_id");--> statement-breakpoint
CREATE INDEX "crm_contacts_tenant_customer_active_idx" ON "crm"."contacts" USING btree ("tenant_id","customer_id","name") WHERE "crm"."contacts"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "crm_customers_tenant_active_idx" ON "crm"."customers" USING btree ("tenant_id","name") WHERE "crm"."customers"."archived_at" is null;--> statement-breakpoint
CREATE POLICY "crm_contacts_tenant_select" ON "crm"."contacts" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("crm"."contacts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "crm_contacts_tenant_insert" ON "crm"."contacts" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("crm"."contacts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "crm_contacts_tenant_update" ON "crm"."contacts" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("crm"."contacts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("crm"."contacts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "crm_contacts_tenant_delete" ON "crm"."contacts" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("crm"."contacts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "crm_customers_tenant_select" ON "crm"."customers" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("crm"."customers"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "crm_customers_tenant_insert" ON "crm"."customers" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("crm"."customers"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "crm_customers_tenant_update" ON "crm"."customers" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("crm"."customers"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("crm"."customers"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "crm_customers_tenant_delete" ON "crm"."customers" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("crm"."customers"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
