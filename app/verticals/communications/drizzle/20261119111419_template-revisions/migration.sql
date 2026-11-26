CREATE TABLE "communications"."template_activations" (
	"activated_at" timestamp with time zone NOT NULL,
	"activated_by_principal_id" uuid NOT NULL,
	"activation_id" uuid PRIMARY KEY,
	"activation_invocation_id" uuid NOT NULL,
	"activation_reason" text NOT NULL,
	"end_invocation_id" uuid,
	"end_reason" text,
	"ended_at" timestamp with time zone,
	"ended_by_principal_id" uuid,
	"ended_kind" text,
	"legal_entity_id" uuid,
	"revision_id" uuid NOT NULL,
	"scope_key" text NOT NULL,
	"template_type_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "communications_template_activations_end_ck" CHECK (("ended_at" is null and "ended_kind" is null and "ended_by_principal_id" is null and "end_reason" is null and "end_invocation_id" is null) or ("ended_at" is not null and "ended_at" >= "activated_at" and "ended_kind" in ('replaced', 'deactivated', 'invalidated-unsafe') and "ended_by_principal_id" is not null and "end_reason" is not null and "end_invocation_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "communications"."template_activations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "communications"."template_revision_invalidations" (
	"action_invocation_id" uuid NOT NULL,
	"invalidated_at" timestamp with time zone NOT NULL,
	"invalidated_by_principal_id" uuid NOT NULL,
	"invalidation_id" uuid PRIMARY KEY,
	"reason" text NOT NULL,
	"revision_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "communications_template_revision_invalidations_revision_uk" UNIQUE("tenant_id","revision_id")
);
--> statement-breakpoint
ALTER TABLE "communications"."template_revision_invalidations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "communications"."template_revisions" (
	"action_invocation_id" uuid NOT NULL,
	"body" text NOT NULL,
	"content_digest" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by_principal_id" uuid NOT NULL,
	"placeholders_used" jsonb NOT NULL,
	"reason" text NOT NULL,
	"revision_id" uuid PRIMARY KEY,
	"revision_number" integer NOT NULL,
	"subject" text NOT NULL,
	"template_type_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "communications_template_revisions_tenant_identity_uk" UNIQUE("tenant_id","revision_id"),
	CONSTRAINT "communications_template_revisions_number_uk" UNIQUE("tenant_id","template_type_id","revision_number"),
	CONSTRAINT "communications_template_revisions_number_ck" CHECK ("revision_number" > 0)
);
--> statement-breakpoint
ALTER TABLE "communications"."template_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "communications"."template_types" (
	"action_invocation_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by_principal_id" uuid NOT NULL,
	"language" text NOT NULL,
	"legal_entity_id" uuid,
	"message_type" text NOT NULL,
	"optional_placeholders" jsonb NOT NULL,
	"required_placeholders" jsonb NOT NULL,
	"scope_key" text NOT NULL,
	"scope_kind" text NOT NULL,
	"template_type_id" uuid PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "communications_template_types_tenant_identity_uk" UNIQUE("tenant_id","template_type_id"),
	CONSTRAINT "communications_template_types_identity_uk" UNIQUE("tenant_id","message_type","channel","language","scope_key"),
	CONSTRAINT "communications_template_types_channel_ck" CHECK ("channel" in ('email')),
	CONSTRAINT "communications_template_types_language_ck" CHECK ("language" in ('cs', 'en')),
	CONSTRAINT "communications_template_types_scope_ck" CHECK (("scope_kind" = 'tenant' and "legal_entity_id" is null and "scope_key" = 'tenant') or ("scope_kind" = 'legal-entity' and "legal_entity_id" is not null and "scope_key" = 'legal-entity:' || "legal_entity_id"::text))
);
--> statement-breakpoint
ALTER TABLE "communications"."template_types" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "communications_template_activations_open_uk" ON "communications"."template_activations" ("tenant_id","template_type_id") WHERE "ended_at" is null;--> statement-breakpoint
CREATE INDEX "communications_template_activations_revision_idx" ON "communications"."template_activations" ("tenant_id","revision_id");--> statement-breakpoint
ALTER TABLE "communications"."template_activations" ADD CONSTRAINT "communications_template_activations_revision_fk" FOREIGN KEY ("tenant_id","revision_id") REFERENCES "communications"."template_revisions"("tenant_id","revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "communications"."template_activations" ADD CONSTRAINT "communications_template_activations_type_fk" FOREIGN KEY ("tenant_id","template_type_id") REFERENCES "communications"."template_types"("tenant_id","template_type_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "communications"."template_revision_invalidations" ADD CONSTRAINT "communications_template_revision_invalidations_revision_fk" FOREIGN KEY ("tenant_id","revision_id") REFERENCES "communications"."template_revisions"("tenant_id","revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "communications"."template_revisions" ADD CONSTRAINT "communications_template_revisions_type_fk" FOREIGN KEY ("tenant_id","template_type_id") REFERENCES "communications"."template_types"("tenant_id","template_type_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "communications_template_activations_select" ON "communications"."template_activations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("communications"."template_activations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "communications_template_activations_insert" ON "communications"."template_activations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("communications"."template_activations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "communications_template_activations_update" ON "communications"."template_activations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("communications"."template_activations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("communications"."template_activations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "communications_template_activations_delete" ON "communications"."template_activations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("communications"."template_activations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "communications_template_revision_invalidations_select" ON "communications"."template_revision_invalidations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("communications"."template_revision_invalidations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "communications_template_revision_invalidations_insert" ON "communications"."template_revision_invalidations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("communications"."template_revision_invalidations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "communications_template_revision_invalidations_update" ON "communications"."template_revision_invalidations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("communications"."template_revision_invalidations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("communications"."template_revision_invalidations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "communications_template_revision_invalidations_delete" ON "communications"."template_revision_invalidations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("communications"."template_revision_invalidations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "communications_template_revisions_select" ON "communications"."template_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("communications"."template_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "communications_template_revisions_insert" ON "communications"."template_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("communications"."template_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "communications_template_revisions_update" ON "communications"."template_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("communications"."template_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("communications"."template_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "communications_template_revisions_delete" ON "communications"."template_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("communications"."template_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "communications_template_types_select" ON "communications"."template_types" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("communications"."template_types"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "communications_template_types_insert" ON "communications"."template_types" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("communications"."template_types"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "communications_template_types_update" ON "communications"."template_types" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("communications"."template_types"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("communications"."template_types"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "communications_template_types_delete" ON "communications"."template_types" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("communications"."template_types"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);