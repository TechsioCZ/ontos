CREATE TABLE "symmy_integration"."job_effects" (
	"claim_token" uuid,
	"effect" jsonb NOT NULL,
	"effect_id" uuid PRIMARY KEY,
	"effect_key" text NOT NULL,
	"item_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"lease_until" timestamp with time zone,
	"outcome" jsonb,
	"state" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "symmy_job_effects_tenant_effect_uq" UNIQUE("tenant_id","effect_id"),
	CONSTRAINT "symmy_job_effects_item_key_uq" UNIQUE("tenant_id","job_id","item_id","effect_key"),
	CONSTRAINT "symmy_job_effects_version_ck" CHECK ("version" >= 0),
	CONSTRAINT "symmy_job_effects_state_ck" CHECK ("state" in ('planned', 'attempting', 'indeterminate', 'settled')),
	CONSTRAINT "symmy_job_effects_ref_ck" CHECK ("effect"->>'itemId' = "item_id"::text and "effect"->>'effectKey' = "effect_key" and "effect" #>> '{ref,effectId}' = "effect_id"::text),
	CONSTRAINT "symmy_job_effects_lease_ck" CHECK (("state" = 'attempting') = ("claim_token" is not null and "lease_until" is not null)),
	CONSTRAINT "symmy_job_effects_outcome_ck" CHECK (("state" = 'settled') = ("outcome" is not null))
);
--> statement-breakpoint
ALTER TABLE "symmy_integration"."job_effects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "symmy_integration"."import_jobs" ADD COLUMN "execution_plan" jsonb;--> statement-breakpoint
ALTER TABLE "symmy_integration"."job_routes" ADD COLUMN "fixture_plan" jsonb;--> statement-breakpoint
ALTER TABLE "symmy_integration"."import_jobs" ADD CONSTRAINT "symmy_import_jobs_tenant_job_uq" UNIQUE("tenant_id","job_id");--> statement-breakpoint
ALTER TABLE "symmy_integration"."job_effects" ADD CONSTRAINT "symmy_job_effects_job_fk" FOREIGN KEY ("tenant_id","job_id") REFERENCES "symmy_integration"."import_jobs"("tenant_id","job_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "symmy_job_effects_tenant_select" ON "symmy_integration"."job_effects" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("symmy_integration"."job_effects"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_job_effects_tenant_insert" ON "symmy_integration"."job_effects" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("symmy_integration"."job_effects"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_job_effects_tenant_update" ON "symmy_integration"."job_effects" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("symmy_integration"."job_effects"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("symmy_integration"."job_effects"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_job_effects_tenant_delete" ON "symmy_integration"."job_effects" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("symmy_integration"."job_effects"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);