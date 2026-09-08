CREATE TABLE "core"."search_projection_rebuilds" (
	"tenant_id" uuid NOT NULL,
	"source_module_key" text NOT NULL,
	"source_resource_type" text NOT NULL,
	"rebuild_version" bigint NOT NULL,
	"fingerprint" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_search_projection_rebuilds_pk" PRIMARY KEY("tenant_id","source_module_key","source_resource_type"),
	CONSTRAINT "core_search_projection_rebuilds_version_ck" CHECK ("core"."search_projection_rebuilds"."rebuild_version" > 0),
	CONSTRAINT "core_search_projection_rebuilds_fingerprint_ck" CHECK ("core"."search_projection_rebuilds"."fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "core"."search_projection_rebuilds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."search_projection_rebuilds" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."search_projection_rebuilds" ADD CONSTRAINT "search_projection_rebuilds_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "core_search_projection_rebuilds_tenant_select" ON "core"."search_projection_rebuilds" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("core"."search_projection_rebuilds"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "core_search_projection_rebuilds_tenant_insert" ON "core"."search_projection_rebuilds" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("core"."search_projection_rebuilds"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "core_search_projection_rebuilds_tenant_update" ON "core"."search_projection_rebuilds" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("core"."search_projection_rebuilds"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("core"."search_projection_rebuilds"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
