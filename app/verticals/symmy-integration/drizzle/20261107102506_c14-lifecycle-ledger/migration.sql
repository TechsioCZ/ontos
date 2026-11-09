CREATE TABLE "symmy_integration"."job_notifications" (
	"attempt" integer DEFAULT 0 NOT NULL,
	"claim_token" uuid,
	"destination_digest" text NOT NULL,
	"initial_backoff_ms" integer NOT NULL,
	"job_id" uuid,
	"lease_until" timestamp with time zone,
	"max_attempts" integer NOT NULL,
	"max_backoff_ms" integer NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload_digest" text NOT NULL,
	"policy_id" text NOT NULL,
	"policy_revision" text NOT NULL,
	"recipient_id" text NOT NULL,
	"state" text NOT NULL,
	"tenant_id" uuid,
	"timeout_ms" integer NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "symmy_job_notifications_pk" PRIMARY KEY("tenant_id","job_id"),
	CONSTRAINT "symmy_job_notifications_attempt_ck" CHECK ("attempt" between 0 and "max_attempts" and "max_attempts" between 1 and 20),
	CONSTRAINT "symmy_job_notifications_state_ck" CHECK ("state" in ('pending','attempting','delivered','exhausted')),
	CONSTRAINT "symmy_job_notifications_lease_ck" CHECK (("state" = 'attempting') = ("claim_token" is not null and "lease_until" is not null)),
	CONSTRAINT "symmy_job_notifications_versions_ck" CHECK ("version" >= 0 and char_length("policy_id") between 1 and 120 and char_length("policy_revision") between 1 and 120),
	CONSTRAINT "symmy_job_notifications_digest_ck" CHECK ("destination_digest" ~ '^[0-9a-f]{64}$' and "payload_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "symmy_job_notifications_retry_ck" CHECK ("initial_backoff_ms" between 1 and 3600000 and "max_backoff_ms" between "initial_backoff_ms" and 86400000 and "timeout_ms" between 1 and 60000)
);
--> statement-breakpoint
ALTER TABLE "symmy_integration"."job_notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "symmy_integration"."job_retention_tombstones" (
	"authority_receipt_ref" text NOT NULL,
	"authority_revision" text NOT NULL,
	"job_id" uuid,
	"policy_id" text NOT NULL,
	"policy_revision" text NOT NULL,
	"purged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retained_effect_ids" jsonb NOT NULL,
	"tenant_id" uuid,
	CONSTRAINT "symmy_job_retention_tombstones_pk" PRIMARY KEY("tenant_id","job_id"),
	CONSTRAINT "symmy_job_retention_tombstones_effects_ck" CHECK (jsonb_typeof("retained_effect_ids") = 'array')
);
--> statement-breakpoint
ALTER TABLE "symmy_integration"."job_retention_tombstones" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "symmy_integration"."job_notifications" ADD CONSTRAINT "symmy_job_notifications_job_fk" FOREIGN KEY ("tenant_id","job_id") REFERENCES "symmy_integration"."import_jobs"("tenant_id","job_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "symmy_integration"."job_retention_tombstones" ADD CONSTRAINT "symmy_job_retention_tombstones_job_fk" FOREIGN KEY ("tenant_id","job_id") REFERENCES "symmy_integration"."import_jobs"("tenant_id","job_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "symmy_job_notifications_tenant_select" ON "symmy_integration"."job_notifications" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("symmy_integration"."job_notifications"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_job_notifications_tenant_insert" ON "symmy_integration"."job_notifications" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("symmy_integration"."job_notifications"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_job_notifications_tenant_update" ON "symmy_integration"."job_notifications" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("symmy_integration"."job_notifications"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("symmy_integration"."job_notifications"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_job_notifications_tenant_delete" ON "symmy_integration"."job_notifications" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("symmy_integration"."job_notifications"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_job_retention_tombstones_tenant_select" ON "symmy_integration"."job_retention_tombstones" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("symmy_integration"."job_retention_tombstones"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_job_retention_tombstones_tenant_insert" ON "symmy_integration"."job_retention_tombstones" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("symmy_integration"."job_retention_tombstones"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_job_retention_tombstones_tenant_update" ON "symmy_integration"."job_retention_tombstones" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("symmy_integration"."job_retention_tombstones"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("symmy_integration"."job_retention_tombstones"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "symmy_job_retention_tombstones_tenant_delete" ON "symmy_integration"."job_retention_tombstones" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("symmy_integration"."job_retention_tombstones"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);