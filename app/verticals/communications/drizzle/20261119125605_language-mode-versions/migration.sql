CREATE TABLE "communications"."tenant_language_mode_versions" (
	"action_invocation_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"policy_version_id" uuid PRIMARY KEY,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"set_by_principal_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	CONSTRAINT "communications_language_mode_versions_number_uk" UNIQUE("tenant_id","version_number"),
	CONSTRAINT "communications_language_mode_versions_mode_ck" CHECK ("mode" in ('A', 'B')),
	CONSTRAINT "communications_language_mode_versions_number_ck" CHECK ("version_number" > 0)
);
--> statement-breakpoint
ALTER TABLE "communications"."tenant_language_mode_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "communications_language_mode_versions_select" ON "communications"."tenant_language_mode_versions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("communications"."tenant_language_mode_versions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "communications_language_mode_versions_insert" ON "communications"."tenant_language_mode_versions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("communications"."tenant_language_mode_versions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "communications_language_mode_versions_update" ON "communications"."tenant_language_mode_versions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("communications"."tenant_language_mode_versions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("communications"."tenant_language_mode_versions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "communications_language_mode_versions_delete" ON "communications"."tenant_language_mode_versions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("communications"."tenant_language_mode_versions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);