CREATE TABLE "symmy_integration"."route_price_read_sources" (
	"owner_module_id" text NOT NULL,
	"route_id" uuid NOT NULL,
	"source_system_ref" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "symmy_route_price_read_sources_route_uq" UNIQUE("tenant_id","route_id"),
	CONSTRAINT "symmy_route_price_read_sources_values_ck" CHECK (char_length("owner_module_id") between 1 and 120 and char_length("source_system_ref") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "symmy_integration"."route_price_read_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "symmy_integration"."route_retention_policies" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"governance_legal_entity_id" uuid NOT NULL,
	"policy_id" text NOT NULL,
	"retention_ms" bigint NOT NULL,
	"revision" text NOT NULL,
	"route_family" text,
	"route_id" uuid NOT NULL,
	"target_legal_entity_id" uuid,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "symmy_route_retention_policies_uq" UNIQUE("tenant_id","route_id","policy_id","revision"),
	CONSTRAINT "symmy_route_retention_policies_values_ck" CHECK ("retention_ms" between 1 and 315576000000
        and char_length("policy_id") between 1 and 120 and char_length("revision") between 1 and 120
        and ("route_family" is null or "route_family" = 'DEMO_GROUP_MEMBERSHIP')
        and ("target_legal_entity_id" is null or "target_legal_entity_id" = "governance_legal_entity_id"))
);
--> statement-breakpoint
ALTER TABLE "symmy_integration"."route_retention_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "symmy_integration"."job_routes" ALTER COLUMN "change_token" SET DEFAULT 0;--> statement-breakpoint
DROP INDEX "symmy_integration"."symmy_job_routes_active_tenant_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "symmy_job_routes_active_tenant_uq" ON "symmy_integration"."job_routes" ("tenant_id","principal_id","route_key") WHERE "active" and "legal_entity_id" is null and "route_code" is null;--> statement-breakpoint
DROP INDEX "symmy_integration"."symmy_job_routes_active_company_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "symmy_job_routes_active_company_uq" ON "symmy_integration"."job_routes" ("tenant_id","principal_id","legal_entity_id","route_key") WHERE "active" and "legal_entity_id" is not null and "route_code" is null;--> statement-breakpoint
DROP INDEX "symmy_integration"."symmy_job_routes_active_tenant_code_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "symmy_job_routes_active_tenant_code_uq" ON "symmy_integration"."job_routes" ("tenant_id","principal_id","route_key","route_code") WHERE "active" and "legal_entity_id" is null and "route_code" is not null;--> statement-breakpoint
DROP INDEX "symmy_integration"."symmy_job_routes_active_company_code_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "symmy_job_routes_active_company_code_uq" ON "symmy_integration"."job_routes" ("tenant_id","principal_id","legal_entity_id","route_key","route_code") WHERE "active" and "legal_entity_id" is not null and "route_code" is not null;--> statement-breakpoint
ALTER TABLE "symmy_integration"."route_price_read_sources" ADD CONSTRAINT "symmy_route_price_read_sources_route_fk" FOREIGN KEY ("tenant_id","route_id") REFERENCES "symmy_integration"."job_routes"("tenant_id","route_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "symmy_integration"."route_retention_policies" ADD CONSTRAINT "symmy_route_retention_policies_route_fk" FOREIGN KEY ("tenant_id","route_id") REFERENCES "symmy_integration"."job_routes"("tenant_id","route_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "symmy_route_enrollment_records_tenant_select" ON "symmy_integration"."route_enrollment_records" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("symmy_integration"."route_enrollment_records"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_route_enrollment_records_tenant_insert" ON "symmy_integration"."route_enrollment_records" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("symmy_integration"."route_enrollment_records"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_route_enrollment_records_tenant_update" ON "symmy_integration"."route_enrollment_records" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("symmy_integration"."route_enrollment_records"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("symmy_integration"."route_enrollment_records"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_route_enrollment_records_tenant_delete" ON "symmy_integration"."route_enrollment_records" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("symmy_integration"."route_enrollment_records"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_route_price_read_sources_tenant_select" ON "symmy_integration"."route_price_read_sources" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("symmy_integration"."route_price_read_sources"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_route_price_read_sources_tenant_insert" ON "symmy_integration"."route_price_read_sources" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("symmy_integration"."route_price_read_sources"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_route_price_read_sources_tenant_update" ON "symmy_integration"."route_price_read_sources" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("symmy_integration"."route_price_read_sources"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("symmy_integration"."route_price_read_sources"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_route_price_read_sources_tenant_delete" ON "symmy_integration"."route_price_read_sources" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("symmy_integration"."route_price_read_sources"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_route_retention_policies_tenant_select" ON "symmy_integration"."route_retention_policies" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("symmy_integration"."route_retention_policies"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_route_retention_policies_tenant_insert" ON "symmy_integration"."route_retention_policies" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("symmy_integration"."route_retention_policies"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_route_retention_policies_tenant_update" ON "symmy_integration"."route_retention_policies" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("symmy_integration"."route_retention_policies"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("symmy_integration"."route_retention_policies"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_route_retention_policies_tenant_delete" ON "symmy_integration"."route_retention_policies" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("symmy_integration"."route_retention_policies"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
-- A tenant administrator enrolls, replaces and deactivates routes through integration.symmy.manage-symmy-routes, which
-- runs under the runtime role in the administrator's Tenant scope: it writes only that Tenant's routes (RLS above), and
-- appends its enrollment record in the same transaction. No route is ever deleted.
GRANT INSERT, UPDATE ON TABLE symmy_integration.job_routes TO ontos_runtime;
--> statement-breakpoint
GRANT INSERT ON TABLE symmy_integration.route_enrollment_records TO ontos_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE symmy_integration.route_retention_policies TO ontos_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE symmy_integration.route_price_read_sources TO ontos_runtime;
--> statement-breakpoint
-- A route stops or is replaced only when no unpurged job of it is outstanding: the change reads which jobs retention
-- purged, in its own Tenant only (the tenant select policy of the ledger migration).
GRANT SELECT ON TABLE symmy_integration.job_retention_tombstones TO ontos_runtime;
--> statement-breakpoint
ALTER TABLE symmy_integration.route_retention_policies FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE symmy_integration.route_price_read_sources FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- The change token stays the migration's private sequence: the BEFORE trigger, running as its owner, takes every token,
-- so the column default (0, replaced on every insert) is nothing the runtime role has to evaluate.
ALTER FUNCTION symmy_integration.advance_route_change_token() SECURITY DEFINER;
--> statement-breakpoint
-- The execution gate of a route is still published only by this trigger, now for every writer of the route row.
ALTER FUNCTION symmy_integration.publish_route_execution_gate() SECURITY DEFINER;
--> statement-breakpoint
-- The AKROS stage demo's route retention and price read source, formerly ONTOS_SYMMY_JOB_RETENTION_POLICIES and
-- ONTOS_SYMMY_PRICE_READ_SOURCES, become route data. Only rows of routes enrolled in this database are written.
INSERT INTO symmy_integration.route_retention_policies
  (tenant_id, route_id, policy_id, revision, governance_legal_entity_id, target_legal_entity_id, retention_ms, route_family)
SELECT r.tenant_id, r.route_id, p.policy_id, 'v1', 'c0c78a3e-6e2a-57e0-9d0d-86253499fee7'::uuid,
  CASE WHEN p.company_target THEN 'c0c78a3e-6e2a-57e0-9d0d-86253499fee7'::uuid END, 2592000000, p.route_family
FROM (VALUES
  ('1a24b716-0542-40d5-8906-c78554b7436d'::uuid, 'akros-symmy-products', true, NULL::text),
  ('042ef863-a837-48d6-81de-59a239148312'::uuid, 'akros-symmy-stock', false, NULL),
  ('9e355544-4242-4704-a9d3-0ef0832fc328'::uuid, 'akros-symmy-price-lists', true, NULL),
  ('3276fa39-f868-4be3-942c-501a6996a74a'::uuid, 'akros-symmy-prices', true, NULL),
  ('f637a6ec-865b-43bc-9c28-57783757f367'::uuid, 'akros-symmy-customer-groups', true, NULL),
  ('20f8cb1e-ecc1-8fda-912d-699274afc835'::uuid, 'akros-symmy-stock-source-v1', false, NULL),
  ('5158ef08-7315-57e1-a9ed-b0fef8cd9ac1'::uuid, 'akros-symmy-customers', true, NULL),
  ('f637a6ec-865b-43bc-9c28-57783757f367'::uuid, 'akros-symmy-memberships', true, 'DEMO_GROUP_MEMBERSHIP')
) AS p(route_id, policy_id, company_target, route_family)
JOIN symmy_integration.job_routes r
  ON r.tenant_id = 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9'::uuid AND r.route_id = p.route_id
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO symmy_integration.route_price_read_sources (tenant_id, route_id, owner_module_id, source_system_ref)
SELECT r.tenant_id, r.route_id, 'external.symmy', 'symmy-akros'
FROM symmy_integration.job_routes r
WHERE r.tenant_id = 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9'::uuid
  AND r.route_id = '6d1d4cdb-72f9-4485-8c07-5806ec9468fe'::uuid
  AND r.legal_entity_id = 'c0c78a3e-6e2a-57e0-9d0d-86253499fee7'::uuid
ON CONFLICT DO NOTHING;
