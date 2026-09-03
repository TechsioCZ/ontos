CREATE SCHEMA "projects";
--> statement-breakpoint
CREATE TABLE "projects"."projects" (
	"project_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"prefix" text NOT NULL,
	"name" text NOT NULL,
	"short_text" text,
	"owner_principal_id" uuid NOT NULL,
	"parent_project_id" uuid,
	"lifecycle_state" text DEFAULT 'active' NOT NULL,
	"created_by_principal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_projects_tenant_id_uk" UNIQUE("tenant_id","project_id"),
	CONSTRAINT "projects_projects_prefix_ck" CHECK ("projects"."projects"."prefix" ~ '^[A-Z]{2,5}$'),
	CONSTRAINT "projects_projects_name_ck" CHECK (length(btrim("projects"."projects"."name")) > 0),
	CONSTRAINT "projects_projects_short_text_ck" CHECK ("projects"."projects"."short_text" is null or char_length("projects"."projects"."short_text") <= 255),
	CONSTRAINT "projects_projects_not_own_parent_ck" CHECK ("projects"."projects"."parent_project_id" is null or "projects"."projects"."parent_project_id" <> "projects"."projects"."project_id"),
	CONSTRAINT "projects_projects_lifecycle_state_ck" CHECK ("projects"."projects"."lifecycle_state" in ('active', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "projects"."projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Drizzle models RLS enablement and policies but cannot express PostgreSQL FORCE ROW LEVEL SECURITY.
ALTER TABLE "projects"."projects" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "projects"."projects" ADD CONSTRAINT "projects_projects_tenant_parent_fk" FOREIGN KEY ("tenant_id","parent_project_id") REFERENCES "projects"."projects"("tenant_id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_projects_tenant_prefix_uk" ON "projects"."projects" USING btree ("tenant_id","prefix");--> statement-breakpoint
CREATE INDEX "projects_projects_tenant_parent_idx" ON "projects"."projects" USING btree ("tenant_id","parent_project_id");--> statement-breakpoint
CREATE POLICY "projects_projects_tenant_select" ON "projects"."projects" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("projects"."projects"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "projects_projects_tenant_insert" ON "projects"."projects" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("projects"."projects"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "projects_projects_tenant_update" ON "projects"."projects" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("projects"."projects"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("projects"."projects"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "projects_projects_tenant_delete" ON "projects"."projects" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("projects"."projects"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
