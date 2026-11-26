CREATE TABLE "symmy_integration"."executor_workload_grants" (
	"executor_principal_id" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_by_ref" text NOT NULL,
	"granted_reason" text NOT NULL,
	"granted_row_id" uuid,
	"kind" text NOT NULL,
	"legal_entity_id" uuid,
	"tenant_id" uuid,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_by_ref" text,
	"workload_binding_id" uuid NOT NULL,
	"workload_key" text NOT NULL,
	CONSTRAINT "symmy_executor_workload_grants_pk" PRIMARY KEY("tenant_id","granted_row_id"),
	CONSTRAINT "symmy_executor_workload_grants_values_ck" CHECK (char_length("workload_key") between 1 and 200 and char_length("granted_by_ref") between 1 and 200
        and char_length("granted_reason") between 1 and 500
        and "kind" in ('binding', 'company_registration')
        and ("kind" = 'company_registration') = ("legal_entity_id" is not null)
        and ("kind" = 'binding') = ("granted_row_id" = "workload_binding_id")
        and ("withdrawn_at" is null) = ("withdrawn_by_ref" is null))
);
--> statement-breakpoint
ALTER TABLE "symmy_integration"."executor_workload_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "symmy_executor_workload_grants_tenant_select" ON "symmy_integration"."executor_workload_grants" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("symmy_integration"."executor_workload_grants"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_executor_workload_grants_tenant_insert" ON "symmy_integration"."executor_workload_grants" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("symmy_integration"."executor_workload_grants"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_executor_workload_grants_tenant_update" ON "symmy_integration"."executor_workload_grants" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("symmy_integration"."executor_workload_grants"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("symmy_integration"."executor_workload_grants"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_executor_workload_grants_tenant_delete" ON "symmy_integration"."executor_workload_grants" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("symmy_integration"."executor_workload_grants"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
-- integration.symmy.manage-symmy-routes records, under the runtime role in the administrator's Tenant scope, each
-- binding or company registration it writes for the Tenant's Symmy executor, and marks it withdrawn once no active route
-- calls under the workload any more. A grant is never deleted.
GRANT SELECT, INSERT, UPDATE ON TABLE symmy_integration.executor_workload_grants TO ontos_runtime;
--> statement-breakpoint
ALTER TABLE symmy_integration.executor_workload_grants FORCE ROW LEVEL SECURITY;
