CREATE TABLE "privacy"."source_processing_admissions" (
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"authorization_id" uuid NOT NULL,
	"first_admitted_at" timestamp with time zone NOT NULL,
	"last_action_invocation_id" uuid NOT NULL,
	"last_admitted_at" timestamp with time zone NOT NULL,
	"privacy_subject_id" uuid NOT NULL,
	"role" text NOT NULL,
	"source_identity_key" text NOT NULL,
	"source_record" jsonb NOT NULL,
	CONSTRAINT "privacy_source_admissions_source_uk" UNIQUE("tenant_id","legal_entity_id","source_identity_key"),
	CONSTRAINT "privacy_source_admissions_role_ck" CHECK ("role" in ('SUBJECT', 'CHILD')),
	CONSTRAINT "privacy_source_admissions_period_ck" CHECK ("last_admitted_at" >= "first_admitted_at")
);
--> statement-breakpoint
ALTER TABLE "privacy"."source_processing_admissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy"."source_processing_authorizations" (
	"authorization_id" uuid PRIMARY KEY,
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"authorization_record" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by_action_invocation_id" uuid NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by_action_invocation_id" uuid,
	"lifecycle" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" integer NOT NULL,
	"source_issuer" text NOT NULL,
	"source_namespace" text NOT NULL,
	"source_route_ref" text NOT NULL,
	CONSTRAINT "privacy_source_authorizations_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","authorization_id"),
	CONSTRAINT "privacy_source_authorizations_invocation_uk" UNIQUE("tenant_id","legal_entity_id","created_by_action_invocation_id"),
	CONSTRAINT "privacy_source_authorizations_lifecycle_ck" CHECK ("lifecycle" in ('ACTIVE', 'ENDED')),
	CONSTRAINT "privacy_source_authorizations_end_ck" CHECK (("lifecycle" = 'ENDED') = ("ended_at" is not null) and ("ended_at" is null) = ("ended_by_action_invocation_id" is null) and ("ended_at" is null or "ended_at" >= "created_at")),
	CONSTRAINT "privacy_source_authorizations_revision_ck" CHECK ("revision" >= 1),
	CONSTRAINT "privacy_source_authorizations_record_binding_ck" CHECK (
      ("authorization_record" -> 'authorizationRef' ->> 'resourceId') is not distinct from "authorization_id"::text and
      ("authorization_record" -> 'authorizationRef' ->> 'tenantId') is not distinct from "tenant_id"::text and
      ("authorization_record" ->> 'legalEntityId') is not distinct from "legal_entity_id"::text and
      ("authorization_record" ->> 'lifecycle') is not distinct from "lifecycle" and
      ("authorization_record" ->> 'revision')::integer is not distinct from "revision" and
      ("authorization_record" -> 'source' ->> 'issuer') is not distinct from "source_issuer" and
      ("authorization_record" -> 'source' ->> 'namespace') is not distinct from "source_namespace" and
      ("authorization_record" -> 'source' ->> 'routeRef') is not distinct from "source_route_ref"
    )
);
--> statement-breakpoint
ALTER TABLE "privacy"."source_processing_authorizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "privacy_subjects_reconciled_source_idx" ON "privacy"."privacy_subjects" ("tenant_id","legal_entity_id",("subject_record"->'subject'->'sourceAdmission'->'sourceSubjectRef'->>'resourceId')) WHERE "subject_kind" = 'DATA_SUBJECT';--> statement-breakpoint
CREATE INDEX "privacy_source_admissions_subject_idx" ON "privacy"."source_processing_admissions" ("tenant_id","legal_entity_id","authorization_id","privacy_subject_id");--> statement-breakpoint
CREATE INDEX "privacy_source_authorizations_route_idx" ON "privacy"."source_processing_authorizations" ("tenant_id","legal_entity_id","source_issuer","source_namespace","source_route_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "privacy_source_authorizations_active_route_uk" ON "privacy"."source_processing_authorizations" ("tenant_id","legal_entity_id","source_issuer","source_namespace","source_route_ref") WHERE "lifecycle" = 'ACTIVE';--> statement-breakpoint
ALTER TABLE "privacy"."source_processing_admissions" ADD CONSTRAINT "privacy_source_admissions_authorization_fk" FOREIGN KEY ("tenant_id","legal_entity_id","authorization_id") REFERENCES "privacy"."source_processing_authorizations"("tenant_id","legal_entity_id","authorization_id");--> statement-breakpoint
ALTER TABLE "privacy"."source_processing_admissions" ADD CONSTRAINT "privacy_source_admissions_subject_fk" FOREIGN KEY ("tenant_id","legal_entity_id","privacy_subject_id") REFERENCES "privacy"."privacy_subjects"("tenant_id","legal_entity_id","privacy_subject_id");--> statement-breakpoint
CREATE POLICY "privacy_source_admissions_scope_select" ON "privacy"."source_processing_admissions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."source_processing_admissions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."source_processing_admissions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_source_admissions_scope_insert" ON "privacy"."source_processing_admissions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."source_processing_admissions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."source_processing_admissions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_source_admissions_scope_update" ON "privacy"."source_processing_admissions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."source_processing_admissions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."source_processing_admissions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."source_processing_admissions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."source_processing_admissions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_source_admissions_scope_delete" ON "privacy"."source_processing_admissions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."source_processing_admissions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."source_processing_admissions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_source_authorizations_scope_select" ON "privacy"."source_processing_authorizations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."source_processing_authorizations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."source_processing_authorizations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_source_authorizations_scope_insert" ON "privacy"."source_processing_authorizations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."source_processing_authorizations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."source_processing_authorizations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_source_authorizations_scope_update" ON "privacy"."source_processing_authorizations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."source_processing_authorizations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."source_processing_authorizations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."source_processing_authorizations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."source_processing_authorizations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_source_authorizations_scope_delete" ON "privacy"."source_processing_authorizations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."source_processing_authorizations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."source_processing_authorizations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "privacy"."source_processing_authorizations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "privacy"."source_processing_admissions" FORCE ROW LEVEL SECURITY;
