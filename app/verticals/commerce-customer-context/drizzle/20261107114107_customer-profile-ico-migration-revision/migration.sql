CREATE TABLE "commerce_customer_context"."customer_profile_ico_migration_history" (
	"tenant_id" uuid,
	"revision" integer,
	"phase" text NOT NULL,
	"plan_id" text NOT NULL,
	"plan" jsonb NOT NULL,
	"inventory_version" text NOT NULL,
	"party_fence_id" text NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_profile_ico_migration_history_pk" PRIMARY KEY("tenant_id","revision"),
	CONSTRAINT "ccc_profile_ico_migration_history_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "ccc_profile_ico_migration_history_phase_ck" CHECK ("phase" in ('STAGING','COMMERCE'))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_profile_ico_migration_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_profile_ico_authority" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_profile_ico_authority" ADD CONSTRAINT "ccc_profile_ico_authority_revision_ck" CHECK ("revision" > 0);--> statement-breakpoint
CREATE POLICY "ccc_profile_ico_migration_history_scope_select" ON "commerce_customer_context"."customer_profile_ico_migration_history" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."customer_profile_ico_migration_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_profile_ico_migration_history_scope_insert" ON "commerce_customer_context"."customer_profile_ico_migration_history" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."customer_profile_ico_migration_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_profile_ico_migration_history_scope_update" ON "commerce_customer_context"."customer_profile_ico_migration_history" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."customer_profile_ico_migration_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_profile_ico_migration_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_profile_ico_migration_history_scope_delete" ON "commerce_customer_context"."customer_profile_ico_migration_history" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."customer_profile_ico_migration_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_profile_ico_migration_history_scope_owner_routine" ON "commerce_customer_context"."customer_profile_ico_migration_history" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."customer_profile_ico_migration_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_profile_ico_migration_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);