CREATE TABLE "core"."access_workload_company_bindings" (
	"company_binding_id" uuid PRIMARY KEY,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"incarnation" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"status" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workload_binding_id" uuid NOT NULL,
	CONSTRAINT "access_workload_company_bindings_status_ck" CHECK ("status" in ('active', 'revoked')),
	CONSTRAINT "access_workload_company_bindings_revoked_ck" CHECK (("status" = 'revoked') = ("revoked_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "core"."access_workload_company_bindings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "access_workload_company_bindings_tenant_id_uk" ON "core"."access_workload_company_bindings" ("tenant_id","company_binding_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_workload_company_bindings_incarnation_uk" ON "core"."access_workload_company_bindings" ("tenant_id","incarnation");--> statement-breakpoint
CREATE UNIQUE INDEX "access_workload_company_bindings_active_uk" ON "core"."access_workload_company_bindings" ("tenant_id","workload_binding_id") WHERE "status" = 'active';--> statement-breakpoint
ALTER TABLE "core"."access_workload_company_bindings" ADD CONSTRAINT "access_workload_company_bindings_m1IOgxFNT4zx_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_workload_company_bindings" ADD CONSTRAINT "access_workload_company_bindings_binding_fk" FOREIGN KEY ("tenant_id","workload_binding_id") REFERENCES "core"."access_workload_bindings"("tenant_id","binding_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_workload_company_bindings" ADD CONSTRAINT "access_workload_company_bindings_company_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "core"."legal_entities"("tenant_id","legal_entity_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "access_workload_company_bindings_select" ON "core"."access_workload_company_bindings" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("core"."access_workload_company_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_workload_company_bindings_insert" ON "core"."access_workload_company_bindings" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("core"."access_workload_company_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_workload_company_bindings_update" ON "core"."access_workload_company_bindings" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("core"."access_workload_company_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("core"."access_workload_company_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_workload_company_bindings_delete" ON "core"."access_workload_company_bindings" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("core"."access_workload_company_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_workload_company_bindings_gateway_request_select" ON "core"."access_workload_company_bindings" AS PERMISSIVE FOR SELECT TO "party_registry_runtime" USING ("core"."access_workload_company_bindings"."tenant_id" = (select trust.current_tenant_id()));