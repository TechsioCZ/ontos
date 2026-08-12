CREATE TABLE "crm"."contacts" (
	"contact_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"first_name" text,
	"last_name" text,
	"email" text,
	"phone" text,
	"job_title" text,
	"is_primary_contact" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "crm_contacts_name_ck" CHECK (("crm"."contacts"."first_name" is null or ("crm"."contacts"."first_name" = btrim("crm"."contacts"."first_name") and not ("crm"."contacts"."first_name" ~ '^[[:space:]]|[[:space:]]$') and char_length("crm"."contacts"."first_name") between 1 and 200)) and ("crm"."contacts"."last_name" is null or ("crm"."contacts"."last_name" = btrim("crm"."contacts"."last_name") and not ("crm"."contacts"."last_name" ~ '^[[:space:]]|[[:space:]]$') and char_length("crm"."contacts"."last_name") between 1 and 200)) and ("crm"."contacts"."first_name" is not null or "crm"."contacts"."last_name" is not null)),
	CONSTRAINT "crm_contacts_version_ck" CHECK ("crm"."contacts"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "crm"."contacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm"."contacts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm"."contacts" ADD CONSTRAINT "crm_contacts_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "crm"."customers"("tenant_id","customer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "crm_contacts_tenant_contact_uk" ON "crm"."contacts" USING btree ("tenant_id","contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_contacts_tenant_customer_contact_uk" ON "crm"."contacts" USING btree ("tenant_id","customer_id","contact_id");--> statement-breakpoint
CREATE INDEX "crm_contacts_active_customer_name_id_idx" ON "crm"."contacts" USING btree ("tenant_id","customer_id","last_name","first_name","contact_id") WHERE "crm"."contacts"."deleted_at" is null;--> statement-breakpoint
CREATE POLICY "crm_contacts_tenant_select" ON "crm"."contacts" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("crm"."contacts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "crm_contacts_tenant_insert" ON "crm"."contacts" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("crm"."contacts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "crm_contacts_tenant_update" ON "crm"."contacts" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("crm"."contacts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("crm"."contacts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "crm_contacts_tenant_delete" ON "crm"."contacts" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("crm"."contacts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
