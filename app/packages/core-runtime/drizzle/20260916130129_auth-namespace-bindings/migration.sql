ALTER TABLE "core"."principal_auth_bindings" ADD COLUMN "authentication_namespace_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."principal_auth_bindings" ADD COLUMN "binding_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."principal_auth_bindings" ADD COLUMN "created_by_invocation_id" uuid;--> statement-breakpoint
ALTER TABLE "core"."principal_auth_bindings" ADD COLUMN "last_transition_ref" uuid;--> statement-breakpoint
ALTER TABLE "core"."principal_auth_bindings" DROP CONSTRAINT "core_auth_bindings_provider_ck";--> statement-breakpoint
ALTER TABLE "core"."principal_auth_bindings" ADD CONSTRAINT "core_auth_bindings_provider_ck" CHECK (length("provider") between 1 and 500);--> statement-breakpoint
ALTER TABLE "core"."principal_auth_bindings" ADD CONSTRAINT "core_auth_bindings_namespace_ck" CHECK (length(btrim("authentication_namespace_id")) between 1 and 200 AND "authentication_namespace_id" = btrim("authentication_namespace_id"));--> statement-breakpoint
ALTER TABLE "core"."principal_auth_bindings" ADD CONSTRAINT "core_auth_bindings_subject_id_ck" CHECK (length("provider_subject_id") between 1 and 500);--> statement-breakpoint
ALTER TABLE "core"."principal_auth_bindings" ADD CONSTRAINT "core_auth_bindings_revision_ck" CHECK ("binding_revision" >= 1);--> statement-breakpoint
ALTER TABLE "core"."principal_auth_bindings" DROP CONSTRAINT "core_auth_bindings_status_ck";--> statement-breakpoint
ALTER TABLE "core"."principal_auth_bindings" ADD CONSTRAINT "core_auth_bindings_status_ck" CHECK ("status" in ('pending', 'active', 'revoked', 'disabled'));--> statement-breakpoint
ALTER TABLE "core"."principal_auth_bindings" DROP CONSTRAINT "core_auth_bindings_lifecycle_ck";--> statement-breakpoint
ALTER TABLE "core"."principal_auth_bindings" ADD CONSTRAINT "core_auth_bindings_lifecycle_ck" CHECK (("status" = 'revoked' and "revoked_at" is not null) or ("status" in ('pending', 'active', 'disabled') and "revoked_at" is null));--> statement-breakpoint
CREATE UNIQUE INDEX "core_auth_bindings_namespace_subject_uk" ON "core"."principal_auth_bindings" ("tenant_id", "authentication_namespace_id", "subject_type", "provider_subject_id");--> statement-breakpoint
DROP INDEX IF EXISTS "core"."core_auth_bindings_subject_uk";
