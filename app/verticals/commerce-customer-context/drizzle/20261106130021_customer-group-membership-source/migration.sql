CREATE TABLE "commerce_customer_context"."customer_group_membership_source_receipts" (
	"legal_entity_id" uuid,
	"tenant_id" uuid,
	"assertion_id" text NOT NULL,
	"customer_profile_id" uuid,
	"effect_id" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"fingerprint" text NOT NULL,
	"issuer" text,
	"result" jsonb NOT NULL,
	"source_namespace" text,
	"source_order" integer,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_membership_source_receipts_pk" PRIMARY KEY("tenant_id","legal_entity_id","customer_profile_id","issuer","source_namespace","source_order"),
	CONSTRAINT "ccc_membership_source_receipts_effect_uk" UNIQUE("tenant_id","legal_entity_id","customer_profile_id","issuer","source_namespace","effect_id"),
	CONSTRAINT "ccc_membership_source_receipts_assertion_uk" UNIQUE("tenant_id","legal_entity_id","customer_profile_id","issuer","source_namespace","assertion_id"),
	CONSTRAINT "ccc_membership_source_receipts_order_ck" CHECK ("source_order" > 0),
	CONSTRAINT "ccc_membership_source_receipts_fingerprint_ck" CHECK ("fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "ccc_membership_source_receipts_result_ck" CHECK (jsonb_typeof("result") = 'object')
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_membership_source_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."customer_group_membership_source_routes" (
	"legal_entity_id" uuid,
	"tenant_id" uuid,
	"active" boolean DEFAULT false NOT NULL,
	"allow_complete" boolean DEFAULT false NOT NULL,
	"issuer" text NOT NULL,
	"principal_id" uuid NOT NULL,
	"route_id" text,
	"route_revision" text NOT NULL,
	"source_namespace" text NOT NULL,
	CONSTRAINT "ccc_membership_source_routes_pk" PRIMARY KEY("tenant_id","legal_entity_id","route_id"),
	CONSTRAINT "ccc_membership_source_route_id_ck" CHECK ("route_id" = btrim("route_id") and length("route_id") > 0),
	CONSTRAINT "ccc_membership_source_route_revision_ck" CHECK ("route_revision" = btrim("route_revision") and length("route_revision") > 0),
	CONSTRAINT "ccc_membership_source_route_issuer_ck" CHECK ("issuer" = btrim("issuer") and length("issuer") > 0),
	CONSTRAINT "ccc_membership_source_route_namespace_ck" CHECK ("source_namespace" = btrim("source_namespace") and length("source_namespace") > 0)
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_membership_source_routes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_memberships" ADD COLUMN "management" jsonb DEFAULT '{"kind":"LEGACY_UNATTRIBUTED"}' NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_membership_source_receipts" ADD CONSTRAINT "ccc_membership_source_receipts_profile_fk" FOREIGN KEY ("tenant_id","legal_entity_id","customer_profile_id") REFERENCES "commerce_customer_context"."customer_profiles"("tenant_id","legal_entity_id","customer_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_memberships" ADD CONSTRAINT "ccc_memberships_management_ck" CHECK (jsonb_typeof("management") = 'object' and coalesce(
        "management"->>'kind' in ('MANUAL', 'LEGACY_UNATTRIBUTED')
        or ("management"->>'kind' = 'EXTERNAL_SOURCE'
          and "management" #>> '{manager,tenantId}' = "tenant_id"::text
          and "management" #>> '{manager,factFamily}' = 'CUSTOMER_GROUP_MEMBERSHIP'
          and length("management" #>> '{manager,issuer}') > 0
          and length("management" #>> '{manager,sourceNamespace}') > 0
          and jsonb_typeof("management"->'source') = 'object'), false));--> statement-breakpoint
CREATE POLICY "ccc_membership_source_receipts_select" ON "commerce_customer_context"."customer_group_membership_source_receipts" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."customer_group_membership_source_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_membership_source_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_membership_source_receipts_insert" ON "commerce_customer_context"."customer_group_membership_source_receipts" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."customer_group_membership_source_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_membership_source_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_membership_source_receipts_update" ON "commerce_customer_context"."customer_group_membership_source_receipts" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."customer_group_membership_source_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_membership_source_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_group_membership_source_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_membership_source_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_membership_source_receipts_delete" ON "commerce_customer_context"."customer_group_membership_source_receipts" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."customer_group_membership_source_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_membership_source_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_membership_source_receipts_owner_routine" ON "commerce_customer_context"."customer_group_membership_source_receipts" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."customer_group_membership_source_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_membership_source_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_group_membership_source_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_membership_source_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_membership_source_routes_select" ON "commerce_customer_context"."customer_group_membership_source_routes" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."customer_group_membership_source_routes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_membership_source_routes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_membership_source_routes_insert" ON "commerce_customer_context"."customer_group_membership_source_routes" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."customer_group_membership_source_routes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_membership_source_routes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_membership_source_routes_update" ON "commerce_customer_context"."customer_group_membership_source_routes" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."customer_group_membership_source_routes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_membership_source_routes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_group_membership_source_routes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_membership_source_routes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_membership_source_routes_delete" ON "commerce_customer_context"."customer_group_membership_source_routes" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."customer_group_membership_source_routes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_membership_source_routes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_membership_source_routes_owner_routine" ON "commerce_customer_context"."customer_group_membership_source_routes" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."customer_group_membership_source_routes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_membership_source_routes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_group_membership_source_routes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_membership_source_routes"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);