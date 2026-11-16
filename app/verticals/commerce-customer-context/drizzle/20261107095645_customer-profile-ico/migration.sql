CREATE TABLE "commerce_customer_context"."customer_profile_ico_assertions" (
	"tenant_id" uuid,
	"customer_profile_id" uuid,
	"revision" integer,
	"effect_id" text NOT NULL,
	"is_current" boolean NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"normalized_value" text,
	"assertion" jsonb NOT NULL,
	"intent" jsonb NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_profile_ico_assertions_pk" PRIMARY KEY("tenant_id","customer_profile_id","revision"),
	CONSTRAINT "ccc_profile_ico_effect_uk" UNIQUE("tenant_id","effect_id"),
	CONSTRAINT "ccc_profile_ico_value_ck" CHECK ("normalized_value" is null or "normalized_value" ~ '^[0-9]{8}$'),
	CONSTRAINT "ccc_profile_ico_current_ck" CHECK (not "is_current" or ("normalized_value" is not null and "effective_to" is null)),
	CONSTRAINT "ccc_profile_ico_revision_ck" CHECK ("revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_profile_ico_assertions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."customer_profile_ico_authority" (
	"tenant_id" uuid PRIMARY KEY,
	"phase" text NOT NULL,
	"plan_id" text NOT NULL,
	"inventory_version" text NOT NULL,
	"party_fence_id" text NOT NULL,
	"plan" jsonb NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_profile_ico_authority_phase_ck" CHECK ("phase" in ('STAGING', 'COMMERCE'))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_profile_ico_authority" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "ccc_profile_ico_current_uk" ON "commerce_customer_context"."customer_profile_ico_assertions" ("tenant_id","customer_profile_id") WHERE "is_current";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_profile_ico_assertions" ADD CONSTRAINT "ccc_profile_ico_profile_fk" FOREIGN KEY ("tenant_id","customer_profile_id") REFERENCES "commerce_customer_context"."customer_profiles"("tenant_id","customer_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "ccc_profile_ico_select" ON "commerce_customer_context"."customer_profile_ico_assertions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."customer_profile_ico_assertions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_profile_ico_insert" ON "commerce_customer_context"."customer_profile_ico_assertions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."customer_profile_ico_assertions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_profile_ico_update" ON "commerce_customer_context"."customer_profile_ico_assertions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."customer_profile_ico_assertions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_profile_ico_assertions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_profile_ico_delete" ON "commerce_customer_context"."customer_profile_ico_assertions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."customer_profile_ico_assertions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_profile_ico_owner_routine" ON "commerce_customer_context"."customer_profile_ico_assertions" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."customer_profile_ico_assertions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_profile_ico_assertions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_profile_ico_authority_select" ON "commerce_customer_context"."customer_profile_ico_authority" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."customer_profile_ico_authority"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_profile_ico_authority_insert" ON "commerce_customer_context"."customer_profile_ico_authority" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."customer_profile_ico_authority"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_profile_ico_authority_update" ON "commerce_customer_context"."customer_profile_ico_authority" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."customer_profile_ico_authority"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_profile_ico_authority"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_profile_ico_authority_delete" ON "commerce_customer_context"."customer_profile_ico_authority" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."customer_profile_ico_authority"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_profile_ico_authority_owner_routine" ON "commerce_customer_context"."customer_profile_ico_authority" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."customer_profile_ico_authority"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_profile_ico_authority"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);