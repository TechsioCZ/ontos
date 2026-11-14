CREATE TABLE "commerce_customer_context"."customer_group_definition_source_bindings" (
	"legal_entity_id" uuid,
	"tenant_id" uuid,
	"issuer" text,
	"namespace" text,
	"record_id" text,
	"source_code" text NOT NULL,
	"customer_group_id" uuid NOT NULL,
	"source_order" integer NOT NULL,
	"source_revision" text NOT NULL,
	"source_intent" jsonb NOT NULL,
	CONSTRAINT "ccc_group_def_source_bindings_pk" PRIMARY KEY("tenant_id","legal_entity_id","issuer","namespace","record_id"),
	CONSTRAINT "ccc_group_def_source_binding_group_uk" UNIQUE("tenant_id","legal_entity_id","customer_group_id"),
	CONSTRAINT "ccc_group_def_source_binding_code_uk" UNIQUE("tenant_id","legal_entity_id","issuer","namespace","source_code"),
	CONSTRAINT "ccc_group_def_source_order_ck" CHECK ("source_order" >= 0),
	CONSTRAINT "ccc_group_def_source_binding_issuer_ck" CHECK ("issuer" = btrim("issuer") and length("issuer") > 0),
	CONSTRAINT "ccc_group_def_source_binding_namespace_ck" CHECK ("namespace" = btrim("namespace") and length("namespace") > 0),
	CONSTRAINT "ccc_group_def_source_binding_record_ck" CHECK ("record_id" = btrim("record_id") and length("record_id") > 0),
	CONSTRAINT "ccc_group_def_source_binding_code_ck" CHECK ("source_code" = btrim("source_code") and length("source_code") > 0),
	CONSTRAINT "ccc_group_def_source_binding_revision_ck" CHECK ("source_revision" = btrim("source_revision") and length("source_revision") > 0)
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_definition_source_bindings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."customer_group_definition_source_receipts" (
	"legal_entity_id" uuid,
	"tenant_id" uuid,
	"issuer" text,
	"namespace" text,
	"effect_id" text,
	"intent" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_group_def_source_receipts_pk" PRIMARY KEY("tenant_id","legal_entity_id","issuer","namespace","effect_id"),
	CONSTRAINT "ccc_group_def_source_receipt_issuer_ck" CHECK ("issuer" = btrim("issuer") and length("issuer") > 0),
	CONSTRAINT "ccc_group_def_source_receipt_namespace_ck" CHECK ("namespace" = btrim("namespace") and length("namespace") > 0),
	CONSTRAINT "ccc_group_def_source_receipt_effect_ck" CHECK ("effect_id" = btrim("effect_id") and length("effect_id") > 0)
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_definition_source_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."customer_group_definition_source_routes" (
	"legal_entity_id" uuid,
	"tenant_id" uuid,
	"route_id" text,
	"route_revision" text NOT NULL,
	"principal_id" uuid NOT NULL,
	"issuer" text NOT NULL,
	"namespace" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	CONSTRAINT "ccc_group_def_source_routes_pk" PRIMARY KEY("tenant_id","legal_entity_id","route_id"),
	CONSTRAINT "ccc_group_def_source_route_id_ck" CHECK ("route_id" = btrim("route_id") and length("route_id") > 0),
	CONSTRAINT "ccc_group_def_source_route_revision_ck" CHECK ("route_revision" = btrim("route_revision") and length("route_revision") > 0),
	CONSTRAINT "ccc_group_def_source_route_issuer_ck" CHECK ("issuer" = btrim("issuer") and length("issuer") > 0),
	CONSTRAINT "ccc_group_def_source_route_namespace_ck" CHECK ("namespace" = btrim("namespace") and length("namespace") > 0)
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_definition_source_routes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_definition_source_bindings" ADD CONSTRAINT "ccc_group_def_source_binding_group_fk" FOREIGN KEY ("tenant_id","legal_entity_id","customer_group_id") REFERENCES "commerce_customer_context"."customer_groups"("tenant_id","legal_entity_id","customer_group_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "ccc_group_def_source_bindings_scope_select" ON "commerce_customer_context"."customer_group_definition_source_bindings" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."customer_group_definition_source_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_definition_source_bindings"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_group_def_source_bindings_scope_insert" ON "commerce_customer_context"."customer_group_definition_source_bindings" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."customer_group_definition_source_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_definition_source_bindings"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_group_def_source_bindings_scope_update" ON "commerce_customer_context"."customer_group_definition_source_bindings" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."customer_group_definition_source_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_definition_source_bindings"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_group_definition_source_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_definition_source_bindings"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_group_def_source_bindings_scope_delete" ON "commerce_customer_context"."customer_group_definition_source_bindings" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."customer_group_definition_source_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_definition_source_bindings"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_group_def_source_bindings_scope_owner_routine" ON "commerce_customer_context"."customer_group_definition_source_bindings" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."customer_group_definition_source_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_definition_source_bindings"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_group_definition_source_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_definition_source_bindings"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_group_def_source_receipts_scope_select" ON "commerce_customer_context"."customer_group_definition_source_receipts" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."customer_group_definition_source_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_definition_source_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_group_def_source_receipts_scope_insert" ON "commerce_customer_context"."customer_group_definition_source_receipts" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."customer_group_definition_source_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_definition_source_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_group_def_source_receipts_scope_update" ON "commerce_customer_context"."customer_group_definition_source_receipts" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."customer_group_definition_source_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_definition_source_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_group_definition_source_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_definition_source_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_group_def_source_receipts_scope_delete" ON "commerce_customer_context"."customer_group_definition_source_receipts" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."customer_group_definition_source_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_definition_source_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_group_def_source_receipts_scope_owner_routine" ON "commerce_customer_context"."customer_group_definition_source_receipts" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."customer_group_definition_source_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_definition_source_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_group_definition_source_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_definition_source_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_group_def_source_routes_scope_select" ON "commerce_customer_context"."customer_group_definition_source_routes" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."customer_group_definition_source_routes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_definition_source_routes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_group_def_source_routes_scope_insert" ON "commerce_customer_context"."customer_group_definition_source_routes" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."customer_group_definition_source_routes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_definition_source_routes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_group_def_source_routes_scope_update" ON "commerce_customer_context"."customer_group_definition_source_routes" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."customer_group_definition_source_routes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_definition_source_routes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_group_definition_source_routes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_definition_source_routes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_group_def_source_routes_scope_delete" ON "commerce_customer_context"."customer_group_definition_source_routes" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."customer_group_definition_source_routes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_definition_source_routes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_group_def_source_routes_scope_owner_routine" ON "commerce_customer_context"."customer_group_definition_source_routes" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."customer_group_definition_source_routes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_definition_source_routes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_group_definition_source_routes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_definition_source_routes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);