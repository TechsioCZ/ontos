CREATE TABLE "core"."search_label_refresh_jobs" (
	"tenant_id" uuid,
	"source_module_key" text,
	"label_source_module_key" text,
	"label_source_resource_type" text,
	"label_source_resource_id" text,
	"legal_entity_id" uuid,
	"source_revision" bigint NOT NULL,
	"epoch" bigint NOT NULL,
	"cas_version" bigint NOT NULL,
	"cursor" text,
	"sweep_cursor" text,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_search_label_refresh_jobs_pk" PRIMARY KEY("tenant_id","source_module_key","label_source_module_key","label_source_resource_type","label_source_resource_id","legal_entity_id"),
	CONSTRAINT "core_search_label_refresh_jobs_revision_ck" CHECK ("source_revision" >= 0),
	CONSTRAINT "core_search_label_refresh_jobs_epoch_ck" CHECK ("epoch" > 0),
	CONSTRAINT "core_search_label_refresh_jobs_cas_ck" CHECK ("cas_version" > 0),
	CONSTRAINT "core_search_label_refresh_jobs_state_ck" CHECK ("state" in ('sweeping', 'resweep', 'complete'))
);
--> statement-breakpoint
ALTER TABLE "core"."search_label_refresh_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."search_label_source_revisions" (
	"tenant_id" uuid,
	"source_module_key" text,
	"label_source_module_key" text,
	"label_source_resource_type" text,
	"label_source_resource_id" text,
	"legal_entity_id" uuid,
	"source_revision" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_search_label_source_revisions_pk" PRIMARY KEY("tenant_id","source_module_key","label_source_module_key","label_source_resource_type","label_source_resource_id","legal_entity_id"),
	CONSTRAINT "core_search_label_source_revisions_revision_ck" CHECK ("source_revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "core"."search_label_source_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "core_search_label_source_revisions_lookup_idx" ON "core"."search_label_source_revisions" ("tenant_id","source_module_key","legal_entity_id");--> statement-breakpoint
ALTER TABLE "core"."search_label_refresh_jobs" ADD CONSTRAINT "search_label_refresh_jobs_tenant_id_tenants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."search_label_refresh_jobs" ADD CONSTRAINT "core_search_label_refresh_jobs_tenant_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "core"."legal_entities"("tenant_id","legal_entity_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."search_label_source_revisions" ADD CONSTRAINT "search_label_source_revisions_tenant_id_tenants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."search_label_source_revisions" ADD CONSTRAINT "core_search_label_source_revisions_tenant_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "core"."legal_entities"("tenant_id","legal_entity_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "core_search_label_source_revisions_tenant_select" ON "core"."search_label_source_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("core"."search_label_source_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "core"."search_label_source_revisions"."source_module_key" <> 'party.registry');--> statement-breakpoint
CREATE POLICY "core_search_label_source_revisions_tenant_insert" ON "core"."search_label_source_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("core"."search_label_source_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "core"."search_label_source_revisions"."source_module_key" <> 'party.registry');--> statement-breakpoint
CREATE POLICY "core_search_label_source_revisions_tenant_update" ON "core"."search_label_source_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("core"."search_label_source_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "core"."search_label_source_revisions"."source_module_key" <> 'party.registry') WITH CHECK ("core"."search_label_source_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "core"."search_label_source_revisions"."source_module_key" <> 'party.registry');--> statement-breakpoint
CREATE POLICY "core_search_label_source_revisions_party_registry_worker_select" ON "core"."search_label_source_revisions" AS PERMISSIVE FOR SELECT TO "party_registry_worker" USING ("core"."search_label_source_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "core"."search_label_source_revisions"."source_module_key" = 'party.registry');--> statement-breakpoint
CREATE POLICY "core_search_label_source_revisions_party_registry_worker_insert" ON "core"."search_label_source_revisions" AS PERMISSIVE FOR INSERT TO "party_registry_worker" WITH CHECK ("core"."search_label_source_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "core"."search_label_source_revisions"."source_module_key" = 'party.registry');--> statement-breakpoint
CREATE POLICY "core_search_label_source_revisions_party_registry_worker_update" ON "core"."search_label_source_revisions" AS PERMISSIVE FOR UPDATE TO "party_registry_worker" USING ("core"."search_label_source_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "core"."search_label_source_revisions"."source_module_key" = 'party.registry') WITH CHECK ("core"."search_label_source_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "core"."search_label_source_revisions"."source_module_key" = 'party.registry');--> statement-breakpoint
CREATE POLICY "core_search_label_refresh_jobs_tenant_select" ON "core"."search_label_refresh_jobs" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("core"."search_label_refresh_jobs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "core"."search_label_refresh_jobs"."source_module_key" <> 'party.registry');--> statement-breakpoint
CREATE POLICY "core_search_label_refresh_jobs_tenant_insert" ON "core"."search_label_refresh_jobs" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("core"."search_label_refresh_jobs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "core"."search_label_refresh_jobs"."source_module_key" <> 'party.registry');--> statement-breakpoint
CREATE POLICY "core_search_label_refresh_jobs_tenant_update" ON "core"."search_label_refresh_jobs" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("core"."search_label_refresh_jobs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "core"."search_label_refresh_jobs"."source_module_key" <> 'party.registry') WITH CHECK ("core"."search_label_refresh_jobs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "core"."search_label_refresh_jobs"."source_module_key" <> 'party.registry');--> statement-breakpoint
CREATE POLICY "core_search_label_refresh_jobs_party_registry_worker_select" ON "core"."search_label_refresh_jobs" AS PERMISSIVE FOR SELECT TO "party_registry_worker" USING ("core"."search_label_refresh_jobs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "core"."search_label_refresh_jobs"."source_module_key" = 'party.registry');--> statement-breakpoint
CREATE POLICY "core_search_label_refresh_jobs_party_registry_worker_insert" ON "core"."search_label_refresh_jobs" AS PERMISSIVE FOR INSERT TO "party_registry_worker" WITH CHECK ("core"."search_label_refresh_jobs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "core"."search_label_refresh_jobs"."source_module_key" = 'party.registry');--> statement-breakpoint
CREATE POLICY "core_search_label_refresh_jobs_party_registry_worker_update" ON "core"."search_label_refresh_jobs" AS PERMISSIVE FOR UPDATE TO "party_registry_worker" USING ("core"."search_label_refresh_jobs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "core"."search_label_refresh_jobs"."source_module_key" = 'party.registry') WITH CHECK ("core"."search_label_refresh_jobs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "core"."search_label_refresh_jobs"."source_module_key" = 'party.registry');--> statement-breakpoint
ALTER TABLE "core"."search_label_source_revisions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."search_label_refresh_jobs" FORCE ROW LEVEL SECURITY;
