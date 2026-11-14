CREATE TABLE "core"."search_derived_repair_jobs" (
	"tenant_id" uuid,
	"source_module_key" text,
	"source_resource_type" text,
	"epoch" bigint NOT NULL,
	"cas_version" bigint NOT NULL,
	"cursor" text,
	"sweep_cursor" text,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_search_derived_repair_jobs_pk" PRIMARY KEY("tenant_id","source_module_key","source_resource_type"),
	CONSTRAINT "core_search_derived_repair_jobs_epoch_ck" CHECK ("epoch" > 0),
	CONSTRAINT "core_search_derived_repair_jobs_cas_ck" CHECK ("cas_version" > 0),
	CONSTRAINT "core_search_derived_repair_jobs_state_ck" CHECK ("state" in ('sweeping', 'resweep', 'complete'))
);
--> statement-breakpoint
ALTER TABLE "core"."search_derived_repair_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."search_derived_repair_jobs" ADD CONSTRAINT "search_derived_repair_jobs_tenant_id_tenants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "core_search_derived_repair_jobs_tenant_select" ON "core"."search_derived_repair_jobs" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("core"."search_derived_repair_jobs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "core"."search_derived_repair_jobs"."source_module_key" <> 'party.registry');--> statement-breakpoint
CREATE POLICY "core_search_derived_repair_jobs_tenant_insert" ON "core"."search_derived_repair_jobs" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("core"."search_derived_repair_jobs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "core"."search_derived_repair_jobs"."source_module_key" <> 'party.registry');--> statement-breakpoint
CREATE POLICY "core_search_derived_repair_jobs_tenant_update" ON "core"."search_derived_repair_jobs" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("core"."search_derived_repair_jobs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "core"."search_derived_repair_jobs"."source_module_key" <> 'party.registry') WITH CHECK ("core"."search_derived_repair_jobs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "core"."search_derived_repair_jobs"."source_module_key" <> 'party.registry');--> statement-breakpoint
CREATE POLICY "core_search_derived_repair_jobs_party_registry_worker_select" ON "core"."search_derived_repair_jobs" AS PERMISSIVE FOR SELECT TO "party_registry_worker" USING ("core"."search_derived_repair_jobs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "core"."search_derived_repair_jobs"."source_module_key" = 'party.registry');--> statement-breakpoint
CREATE POLICY "core_search_derived_repair_jobs_party_registry_worker_insert" ON "core"."search_derived_repair_jobs" AS PERMISSIVE FOR INSERT TO "party_registry_worker" WITH CHECK ("core"."search_derived_repair_jobs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "core"."search_derived_repair_jobs"."source_module_key" = 'party.registry');--> statement-breakpoint
CREATE POLICY "core_search_derived_repair_jobs_party_registry_worker_update" ON "core"."search_derived_repair_jobs" AS PERMISSIVE FOR UPDATE TO "party_registry_worker" USING ("core"."search_derived_repair_jobs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "core"."search_derived_repair_jobs"."source_module_key" = 'party.registry') WITH CHECK ("core"."search_derived_repair_jobs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "core"."search_derived_repair_jobs"."source_module_key" = 'party.registry');--> statement-breakpoint
ALTER TABLE "core"."search_derived_repair_jobs" FORCE ROW LEVEL SECURITY;
