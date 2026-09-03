CREATE TABLE "contacts"."organization_engagement_profiles" (
	"engagement_profile_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"party_resource_id" text NOT NULL,
	"counterparty_resource_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "contacts_organization_engagement_profiles_tenant_id_uk" UNIQUE("tenant_id","engagement_profile_id"),
	CONSTRAINT "contacts_organization_engagement_profiles_party_resource_id_ck" CHECK ("contacts"."organization_engagement_profiles"."party_resource_id" = btrim("contacts"."organization_engagement_profiles"."party_resource_id") and length("contacts"."organization_engagement_profiles"."party_resource_id") > 0),
	CONSTRAINT "contacts_organization_engagement_profiles_counterparty_resource_id_ck" CHECK ("contacts"."organization_engagement_profiles"."counterparty_resource_id" = btrim("contacts"."organization_engagement_profiles"."counterparty_resource_id") and length("contacts"."organization_engagement_profiles"."counterparty_resource_id") > 0)
);
--> statement-breakpoint
ALTER TABLE "contacts"."organization_engagement_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contacts"."organization_engagement_profiles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "contacts"."person_engagement_profiles" (
	"engagement_profile_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"party_resource_id" text NOT NULL,
	"counterparty_resource_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "contacts_person_engagement_profiles_tenant_id_uk" UNIQUE("tenant_id","engagement_profile_id"),
	CONSTRAINT "contacts_person_engagement_profiles_party_resource_id_ck" CHECK ("contacts"."person_engagement_profiles"."party_resource_id" = btrim("contacts"."person_engagement_profiles"."party_resource_id") and length("contacts"."person_engagement_profiles"."party_resource_id") > 0),
	CONSTRAINT "contacts_person_engagement_profiles_counterparty_resource_id_ck" CHECK ("contacts"."person_engagement_profiles"."counterparty_resource_id" = btrim("contacts"."person_engagement_profiles"."counterparty_resource_id") and length("contacts"."person_engagement_profiles"."counterparty_resource_id") > 0)
);
--> statement-breakpoint
ALTER TABLE "contacts"."person_engagement_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contacts"."person_engagement_profiles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY "contacts_contacts_tenant_select" ON "contacts"."contacts" CASCADE;--> statement-breakpoint
DROP POLICY "contacts_contacts_tenant_insert" ON "contacts"."contacts" CASCADE;--> statement-breakpoint
DROP POLICY "contacts_contacts_tenant_update" ON "contacts"."contacts" CASCADE;--> statement-breakpoint
DROP POLICY "contacts_contacts_tenant_delete" ON "contacts"."contacts" CASCADE;--> statement-breakpoint
DROP TABLE "contacts"."contacts" CASCADE;--> statement-breakpoint
DROP POLICY "contacts_customers_tenant_select" ON "contacts"."customers" CASCADE;--> statement-breakpoint
DROP POLICY "contacts_customers_tenant_insert" ON "contacts"."customers" CASCADE;--> statement-breakpoint
DROP POLICY "contacts_customers_tenant_update" ON "contacts"."customers" CASCADE;--> statement-breakpoint
DROP POLICY "contacts_customers_tenant_delete" ON "contacts"."customers" CASCADE;--> statement-breakpoint
DROP TABLE "contacts"."customers" CASCADE;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_organization_engagement_profiles_counterparty_uk" ON "contacts"."organization_engagement_profiles" USING btree ("tenant_id","counterparty_resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_organization_engagement_profiles_party_uk" ON "contacts"."organization_engagement_profiles" USING btree ("tenant_id","party_resource_id");--> statement-breakpoint
CREATE INDEX "contacts_organization_engagement_profiles_active_idx" ON "contacts"."organization_engagement_profiles" USING btree ("tenant_id","counterparty_resource_id") WHERE "contacts"."organization_engagement_profiles"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_person_engagement_profiles_party_counterparty_uk" ON "contacts"."person_engagement_profiles" USING btree ("tenant_id","party_resource_id","counterparty_resource_id");--> statement-breakpoint
CREATE INDEX "contacts_person_engagement_profiles_active_idx" ON "contacts"."person_engagement_profiles" USING btree ("tenant_id","counterparty_resource_id","party_resource_id") WHERE "contacts"."person_engagement_profiles"."archived_at" is null;--> statement-breakpoint
CREATE POLICY "contacts_organization_engagement_profiles_tenant_select" ON "contacts"."organization_engagement_profiles" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("contacts"."organization_engagement_profiles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "contacts_organization_engagement_profiles_tenant_insert" ON "contacts"."organization_engagement_profiles" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("contacts"."organization_engagement_profiles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "contacts_organization_engagement_profiles_tenant_update" ON "contacts"."organization_engagement_profiles" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("contacts"."organization_engagement_profiles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("contacts"."organization_engagement_profiles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "contacts_organization_engagement_profiles_tenant_delete" ON "contacts"."organization_engagement_profiles" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("contacts"."organization_engagement_profiles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "contacts_person_engagement_profiles_tenant_select" ON "contacts"."person_engagement_profiles" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("contacts"."person_engagement_profiles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "contacts_person_engagement_profiles_tenant_insert" ON "contacts"."person_engagement_profiles" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("contacts"."person_engagement_profiles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "contacts_person_engagement_profiles_tenant_update" ON "contacts"."person_engagement_profiles" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("contacts"."person_engagement_profiles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("contacts"."person_engagement_profiles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "contacts_person_engagement_profiles_tenant_delete" ON "contacts"."person_engagement_profiles" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("contacts"."person_engagement_profiles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
