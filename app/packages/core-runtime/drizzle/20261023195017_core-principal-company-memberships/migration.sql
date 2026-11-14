CREATE TABLE "core"."principal_company_memberships" (
	"tenant_id" uuid,
	"legal_entity_id" uuid,
	"principal_id" uuid,
	"affiliation" text,
	"status" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_principal_company_memberships_pk" PRIMARY KEY("tenant_id","legal_entity_id","principal_id"),
	CONSTRAINT "core_company_memberships_affiliation_ck" CHECK ("affiliation" in ('employee', 'external')),
	CONSTRAINT "core_company_memberships_status_ck" CHECK ("status" in ('invited', 'active', 'disabled', 'departed')),
	CONSTRAINT "core_company_memberships_revision_ck" CHECK ("revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "core"."principal_company_memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "core_company_memberships_principal_idx" ON "core"."principal_company_memberships" ("tenant_id","principal_id");--> statement-breakpoint
ALTER TABLE "core"."principal_company_memberships" ADD CONSTRAINT "principal_company_memberships_tenant_id_tenants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."principal_company_memberships" ADD CONSTRAINT "core_company_memberships_principal_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "core"."principals"("tenant_id","principal_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."principal_company_memberships" ADD CONSTRAINT "core_company_memberships_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "core"."legal_entities"("tenant_id","legal_entity_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "core_company_memberships_select" ON "core"."principal_company_memberships" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("core"."principal_company_memberships"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "core"."principal_company_memberships"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "core_company_memberships_insert" ON "core"."principal_company_memberships" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("core"."principal_company_memberships"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "core"."principal_company_memberships"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "core_company_memberships_update" ON "core"."principal_company_memberships" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("core"."principal_company_memberships"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "core"."principal_company_memberships"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("core"."principal_company_memberships"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "core"."principal_company_memberships"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);