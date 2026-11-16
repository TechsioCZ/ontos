CREATE TABLE "symmy_integration"."sync_admissions" (
	"admission_id" uuid PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"route_revision" text NOT NULL,
	"mapping_version" text NOT NULL,
	"legal_entity_id" uuid,
	"idempotency_digest" text NOT NULL,
	"intent_digest" text NOT NULL,
	"execution_plan" jsonb NOT NULL,
	"lifecycle_policy" jsonb,
	"admitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "symmy_sync_admissions_request_uq" UNIQUE("tenant_id","route_id","idempotency_digest"),
	CONSTRAINT "symmy_sync_admissions_digest_ck" CHECK ("idempotency_digest" ~ '^[0-9a-f]{64}$' and "intent_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "symmy_integration"."sync_admissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "symmy_integration"."sync_admissions" ADD CONSTRAINT "symmy_sync_admissions_route_fk" FOREIGN KEY ("tenant_id","route_id") REFERENCES "symmy_integration"."job_routes"("tenant_id","route_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "symmy_sync_admissions_tenant_select" ON "symmy_integration"."sync_admissions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("symmy_integration"."sync_admissions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_sync_admissions_tenant_insert" ON "symmy_integration"."sync_admissions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("symmy_integration"."sync_admissions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_sync_admissions_tenant_update" ON "symmy_integration"."sync_admissions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("symmy_integration"."sync_admissions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("symmy_integration"."sync_admissions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_sync_admissions_tenant_delete" ON "symmy_integration"."sync_admissions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("symmy_integration"."sync_admissions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);