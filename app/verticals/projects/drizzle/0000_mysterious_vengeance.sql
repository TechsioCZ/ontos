CREATE SCHEMA "projects";
--> statement-breakpoint
CREATE TABLE "projects"."contacts" (
	"contact_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "projects_contacts_name_ck" CHECK ("projects"."contacts"."name" = btrim("projects"."contacts"."name") and length("projects"."contacts"."name") > 0),
	CONSTRAINT "projects_contacts_email_ck" CHECK (length(btrim("projects"."contacts"."email")) > 0),
	CONSTRAINT "projects_contacts_phone_ck" CHECK (length(btrim("projects"."contacts"."phone")) > 0)
);
--> statement-breakpoint
ALTER TABLE "projects"."contacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Drizzle models RLS enablement and policies but cannot express PostgreSQL FORCE ROW LEVEL SECURITY.
ALTER TABLE "projects"."contacts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "projects"."customers" (
	"customer_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"ico" text,
	"dic" text,
	"legal_form_code" text,
	"established_on" date,
	"dissolved_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "projects_customers_tenant_id_uk" UNIQUE("tenant_id","customer_id"),
	CONSTRAINT "projects_customers_name_ck" CHECK ("projects"."customers"."name" = btrim("projects"."customers"."name") and length("projects"."customers"."name") > 0),
	CONSTRAINT "projects_customers_ico_ck" CHECK ("projects"."customers"."ico" is null or "projects"."customers"."ico" ~ '^[0-9]{8}$'),
	CONSTRAINT "projects_customers_dic_ck" CHECK ("projects"."customers"."dic" is null or ("projects"."customers"."dic" = btrim("projects"."customers"."dic") and length("projects"."customers"."dic") between 1 and 20)),
	CONSTRAINT "projects_customers_legal_form_code_ck" CHECK ("projects"."customers"."legal_form_code" is null or "projects"."customers"."legal_form_code" ~ '^[0-9]{3}$'),
	CONSTRAINT "projects_customers_lifecycle_dates_ck" CHECK ("projects"."customers"."dissolved_on" is null or "projects"."customers"."established_on" is null or "projects"."customers"."dissolved_on" >= "projects"."customers"."established_on")
);
--> statement-breakpoint
ALTER TABLE "projects"."customers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Drizzle models RLS enablement and policies but cannot express PostgreSQL FORCE ROW LEVEL SECURITY.
ALTER TABLE "projects"."customers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "projects"."contacts" ADD CONSTRAINT "projects_contacts_tenant_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "projects"."customers"("tenant_id","customer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_contacts_tenant_id_uk" ON "projects"."contacts" USING btree ("tenant_id","contact_id");--> statement-breakpoint
CREATE INDEX "projects_contacts_tenant_customer_active_idx" ON "projects"."contacts" USING btree ("tenant_id","customer_id","name") WHERE "projects"."contacts"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "projects_customers_tenant_active_idx" ON "projects"."customers" USING btree ("tenant_id","name") WHERE "projects"."customers"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_customers_tenant_ico_uk" ON "projects"."customers" USING btree ("tenant_id","ico");--> statement-breakpoint
CREATE POLICY "projects_contacts_tenant_select" ON "projects"."contacts" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("projects"."contacts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "projects_contacts_tenant_insert" ON "projects"."contacts" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("projects"."contacts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "projects_contacts_tenant_update" ON "projects"."contacts" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("projects"."contacts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("projects"."contacts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "projects_contacts_tenant_delete" ON "projects"."contacts" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("projects"."contacts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "projects_customers_tenant_select" ON "projects"."customers" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("projects"."customers"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "projects_customers_tenant_insert" ON "projects"."customers" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("projects"."customers"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "projects_customers_tenant_update" ON "projects"."customers" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("projects"."customers"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("projects"."customers"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "projects_customers_tenant_delete" ON "projects"."customers" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("projects"."customers"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
