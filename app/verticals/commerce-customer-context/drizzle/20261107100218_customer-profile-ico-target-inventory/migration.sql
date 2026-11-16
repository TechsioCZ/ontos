CREATE TABLE "commerce_customer_context"."customer_profile_ico_target_inventory" (
	"tenant_id" uuid,
	"customer_profile_id" uuid,
	"legal_entity_id" uuid NOT NULL,
	"profile_kind" text NOT NULL,
	"subject_resource_id" text NOT NULL,
	"revision" integer NOT NULL,
	"lifecycle" text NOT NULL,
	CONSTRAINT "ccc_profile_ico_target_inventory_pk" PRIMARY KEY("tenant_id","customer_profile_id")
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_profile_ico_target_inventory" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_profile_ico_target_inventory" ADD CONSTRAINT "ccc_profile_ico_target_inventory_fk" FOREIGN KEY ("tenant_id","customer_profile_id") REFERENCES "commerce_customer_context"."customer_profiles"("tenant_id","customer_profile_id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "ccc_profile_ico_target_inventory_select" ON "commerce_customer_context"."customer_profile_ico_target_inventory" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."customer_profile_ico_target_inventory"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_profile_ico_target_inventory_insert" ON "commerce_customer_context"."customer_profile_ico_target_inventory" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."customer_profile_ico_target_inventory"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_profile_ico_target_inventory_update" ON "commerce_customer_context"."customer_profile_ico_target_inventory" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."customer_profile_ico_target_inventory"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_profile_ico_target_inventory"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_profile_ico_target_inventory_delete" ON "commerce_customer_context"."customer_profile_ico_target_inventory" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."customer_profile_ico_target_inventory"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_profile_ico_target_inventory_owner_routine" ON "commerce_customer_context"."customer_profile_ico_target_inventory" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."customer_profile_ico_target_inventory"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_profile_ico_target_inventory"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);