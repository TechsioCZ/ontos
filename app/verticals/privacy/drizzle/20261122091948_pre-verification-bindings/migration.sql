CREATE TABLE "privacy"."pre_verification_bindings" (
	"binding_id" uuid PRIMARY KEY,
	"binding_record" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"legal_entity_id" uuid,
	"revision" integer NOT NULL,
	"source_subject_key" text NOT NULL,
	"status" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_pre_verification_bindings_scope_id_uk" UNIQUE("tenant_id","binding_id"),
	CONSTRAINT "privacy_pre_verification_bindings_source_uk" UNIQUE("tenant_id","source_subject_key"),
	CONSTRAINT "privacy_pre_verification_bindings_status_ck" CHECK ("status" in ('ACTIVE', 'WITHDRAWN')),
	CONSTRAINT "privacy_pre_verification_bindings_revision_ck" CHECK ("revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "privacy"."pre_verification_bindings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "privacy_pre_verification_bindings_scope_select" ON "privacy"."pre_verification_bindings" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."pre_verification_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."pre_verification_bindings"."legal_entity_id" is not distinct from nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_pre_verification_bindings_scope_insert" ON "privacy"."pre_verification_bindings" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."pre_verification_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."pre_verification_bindings"."legal_entity_id" is not distinct from nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_pre_verification_bindings_scope_update" ON "privacy"."pre_verification_bindings" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."pre_verification_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."pre_verification_bindings"."legal_entity_id" is not distinct from nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."pre_verification_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."pre_verification_bindings"."legal_entity_id" is not distinct from nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_pre_verification_bindings_scope_delete" ON "privacy"."pre_verification_bindings" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."pre_verification_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."pre_verification_bindings"."legal_entity_id" is not distinct from nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "privacy"."pre_verification_bindings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "privacy"."pre_verification_bindings" TO "ontos_runtime";
