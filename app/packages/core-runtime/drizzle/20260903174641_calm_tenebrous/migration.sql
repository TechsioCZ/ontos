CREATE TABLE "core"."search_projection_generations" (
	"tenant_id" uuid NOT NULL,
	"source_module_key" text NOT NULL,
	"generation" bigint NOT NULL,
	"event_watermark" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_search_projection_generations_pk" PRIMARY KEY("tenant_id","source_module_key"),
	CONSTRAINT "core_search_projection_generations_positive_ck" CHECK ("core"."search_projection_generations"."generation" > 0)
);
--> statement-breakpoint
ALTER TABLE "core"."search_projection_generations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."search_projection_generations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."search_projection_generations" ADD CONSTRAINT "search_projection_generations_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "core_search_projection_generations_tenant_select" ON "core"."search_projection_generations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("core"."search_projection_generations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "core_search_projection_generations_tenant_insert" ON "core"."search_projection_generations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("core"."search_projection_generations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "core_search_projection_generations_tenant_update" ON "core"."search_projection_generations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("core"."search_projection_generations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("core"."search_projection_generations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
