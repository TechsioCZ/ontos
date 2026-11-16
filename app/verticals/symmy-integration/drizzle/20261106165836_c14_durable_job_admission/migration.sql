CREATE SCHEMA "symmy_integration";
--> statement-breakpoint
CREATE TABLE "symmy_integration"."gateway_assertion_redemptions" (
	"audience" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"issuer" text NOT NULL,
	"jti" uuid NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "symmy_gateway_assertion_redemptions_identity_uk" UNIQUE("issuer","audience","jti"),
	CONSTRAINT "symmy_gateway_assertion_redemptions_audience_ck" CHECK ("audience" = 'symmy-integration')
);
--> statement-breakpoint
CREATE TABLE "symmy_integration"."import_jobs" (
	"admitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fixture_id" text NOT NULL,
	"idempotency_digest" text NOT NULL,
	"intent_digest" text NOT NULL,
	"job_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"legal_entity_id" uuid,
	"mapping_version" text NOT NULL,
	"phase" text NOT NULL,
	"principal_id" uuid NOT NULL,
	"route_code" text,
	"route_id" uuid NOT NULL,
	"route_key" text NOT NULL,
	"route_revision" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "symmy_import_jobs_admission_uq" UNIQUE("tenant_id","route_id","route_key","idempotency_digest"),
	CONSTRAINT "symmy_import_jobs_digests_ck" CHECK ("idempotency_digest" ~ '^[0-9a-f]{64}$' and "intent_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "symmy_import_jobs_fixture_id_ck" CHECK (char_length("fixture_id") between 1 and 80),
	CONSTRAINT "symmy_import_jobs_phase_ck" CHECK ("phase" = 'admitted')
);
--> statement-breakpoint
ALTER TABLE "symmy_integration"."import_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "symmy_integration"."job_routes" (
	"active" boolean NOT NULL,
	"fixture_ids" text[] NOT NULL,
	"legal_entity_id" uuid,
	"mapping_version" text NOT NULL,
	"principal_id" uuid NOT NULL,
	"route_code" text,
	"route_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"route_key" text NOT NULL,
	"route_revision" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "symmy_job_routes_tenant_route_uq" UNIQUE("tenant_id","route_id"),
	CONSTRAINT "symmy_job_routes_scope_selector_uq" UNIQUE NULLS NOT DISTINCT("tenant_id","principal_id","legal_entity_id","route_key","route_code"),
	CONSTRAINT "symmy_job_routes_selector_ck" CHECK ((
        "route_key" in ('customerGroupCustomersBatch', 'priceListPricesBatch')
        and "route_code" is not null and char_length("route_code") between 1 and 80
      ) or (
        "route_key" in ('customersBatch', 'priceListsBatchUpsert', 'productsBatch') and "route_code" is null
      )),
	CONSTRAINT "symmy_job_routes_fixture_ids_ck" CHECK (cardinality("fixture_ids") between 1 and 32 and array_position("fixture_ids", null) is null),
	CONSTRAINT "symmy_job_routes_versions_ck" CHECK (char_length("route_revision") between 1 and 80 and char_length("mapping_version") between 1 and 80)
);
--> statement-breakpoint
ALTER TABLE "symmy_integration"."job_routes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "symmy_gateway_assertion_redemptions_expiry_idx" ON "symmy_integration"."gateway_assertion_redemptions" ("expires_at");--> statement-breakpoint
ALTER TABLE "symmy_integration"."import_jobs" ADD CONSTRAINT "symmy_import_jobs_route_fk" FOREIGN KEY ("tenant_id","route_id") REFERENCES "symmy_integration"."job_routes"("tenant_id","route_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "symmy_import_jobs_tenant_select" ON "symmy_integration"."import_jobs" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("symmy_integration"."import_jobs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_import_jobs_tenant_insert" ON "symmy_integration"."import_jobs" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("symmy_integration"."import_jobs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_import_jobs_tenant_update" ON "symmy_integration"."import_jobs" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("symmy_integration"."import_jobs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("symmy_integration"."import_jobs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_import_jobs_tenant_delete" ON "symmy_integration"."import_jobs" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("symmy_integration"."import_jobs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_job_routes_tenant_select" ON "symmy_integration"."job_routes" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("symmy_integration"."job_routes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_job_routes_tenant_insert" ON "symmy_integration"."job_routes" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("symmy_integration"."job_routes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_job_routes_tenant_update" ON "symmy_integration"."job_routes" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("symmy_integration"."job_routes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("symmy_integration"."job_routes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_job_routes_tenant_delete" ON "symmy_integration"."job_routes" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("symmy_integration"."job_routes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "symmy_integration"."import_jobs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "symmy_integration"."job_routes" FORCE ROW LEVEL SECURITY;
