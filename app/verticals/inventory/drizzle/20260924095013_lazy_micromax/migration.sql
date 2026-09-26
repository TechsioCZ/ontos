CREATE TABLE "inventory"."backend_configurations" (
	"backend_id" text NOT NULL,
	"backend_kind" text NOT NULL,
	"configuration_id" uuid PRIMARY KEY,
	"customer_configuration_id" text NOT NULL,
	"exact_reservation_capability" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"selected_at" timestamp with time zone NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "inventory_backend_configurations_identity_ck" CHECK (length(btrim("backend_id")) between 1 and 300 and length(btrim("customer_configuration_id")) between 1 and 300),
	CONSTRAINT "inventory_backend_configurations_backend_ck" CHECK ("backend_kind" in ('external_business_system', 'ontos_wms')),
	CONSTRAINT "inventory_backend_configurations_capability_ck" CHECK ("exact_reservation_capability" in ('SUPPORTED', 'UNSUPPORTED') and ("backend_kind" <> 'ontos_wms' or "exact_reservation_capability" = 'SUPPORTED')),
	CONSTRAINT "inventory_backend_configurations_revision_ck" CHECK ("revision" = 1)
);
--> statement-breakpoint
ALTER TABLE "inventory"."backend_configurations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_backend_configurations_scope_id_uk" ON "inventory"."backend_configurations" ("tenant_id","configuration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_backend_configurations_customer_uk" ON "inventory"."backend_configurations" ("tenant_id","customer_configuration_id");--> statement-breakpoint
CREATE POLICY "inventory_backend_configurations_tenant_select" ON "inventory"."backend_configurations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("inventory"."backend_configurations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_backend_configurations_tenant_insert" ON "inventory"."backend_configurations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("inventory"."backend_configurations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_backend_configurations_tenant_update" ON "inventory"."backend_configurations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("inventory"."backend_configurations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("inventory"."backend_configurations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inventory_backend_configurations_tenant_delete" ON "inventory"."backend_configurations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("inventory"."backend_configurations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
