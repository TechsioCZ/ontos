CREATE TABLE "promotion"."policy_changes" (
	"tenant_id" uuid,
	"kind" text NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"before_version" integer NOT NULL,
	"after_version" integer NOT NULL,
	"action_invocation_id" uuid,
	"actor_principal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "policy_changes_pkey" PRIMARY KEY("tenant_id","action_invocation_id")
);
--> statement-breakpoint
ALTER TABLE "promotion"."policy_changes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "promotion_policy_change_select" ON "promotion"."policy_changes" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("promotion"."policy_changes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_policy_change_insert" ON "promotion"."policy_changes" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("promotion"."policy_changes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_policy_change_update" ON "promotion"."policy_changes" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("promotion"."policy_changes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("promotion"."policy_changes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_policy_change_delete" ON "promotion"."policy_changes" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("promotion"."policy_changes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
-- Owner infrastructure hardening for this new append-only policy ledger.
ALTER TABLE "promotion"."policy_changes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "promotion"."policy_changes" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "promotion"."policy_changes" TO "ontos_runtime";
