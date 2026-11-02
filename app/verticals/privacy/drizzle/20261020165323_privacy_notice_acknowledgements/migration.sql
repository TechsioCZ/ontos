CREATE TABLE "privacy"."notice_acknowledgements" (
	"acknowledgement_id" uuid PRIMARY KEY,
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"acknowledged_at" timestamp with time zone NOT NULL,
	"acknowledgement_record" jsonb NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"auth_binding_id" uuid NOT NULL,
	"notice_version_id" uuid NOT NULL,
	"presentation_id" uuid NOT NULL,
	"privacy_subject_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retail_profile_id" text NOT NULL,
	"served_at" timestamp with time zone NOT NULL,
	"session_context_digest" text NOT NULL,
	CONSTRAINT "privacy_notice_ack_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","acknowledgement_id"),
	CONSTRAINT "privacy_notice_ack_presentation_uk" UNIQUE("tenant_id","legal_entity_id","presentation_id"),
	CONSTRAINT "privacy_notice_ack_invocation_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id"),
	CONSTRAINT "privacy_notice_ack_period_ck" CHECK ("acknowledged_at" >= "served_at" and "recorded_at" >= "acknowledged_at"),
	CONSTRAINT "privacy_notice_ack_session_digest_ck" CHECK ("session_context_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "privacy_notice_ack_record_binding_ck" CHECK (
      ("acknowledgement_record" ->> 'acknowledgementId') is not distinct from "acknowledgement_id"::text and
      ("acknowledgement_record" ->> 'tenantId') is not distinct from "tenant_id"::text and
      ("acknowledgement_record" ->> 'legalEntityId') is not distinct from "legal_entity_id"::text and
      ("acknowledgement_record" ->> 'actionInvocationId') is not distinct from "action_invocation_id"::text and
      ("acknowledgement_record" ->> 'actorPrincipalId') is not distinct from "actor_principal_id"::text and
      ("acknowledgement_record" ->> 'authBindingId') is not distinct from "auth_binding_id"::text and
      ("acknowledgement_record" ->> 'noticeVersionId') is not distinct from "notice_version_id"::text and
      ("acknowledgement_record" ->> 'presentationId') is not distinct from "presentation_id"::text and
      ("acknowledgement_record" -> 'privacySubjectRef' ->> 'resourceId') is not distinct from "privacy_subject_id"::text and
      ("acknowledgement_record" -> 'privacySubjectRef' ->> 'tenantId') is not distinct from "tenant_id"::text and
      ("acknowledgement_record" ->> 'retailProfileId') is not distinct from "retail_profile_id"::text and
      ("acknowledgement_record" ->> 'sessionContextDigest') is not distinct from "session_context_digest" and
      ("acknowledgement_record" ->> 'acknowledgedAt')::timestamptz is not distinct from "acknowledged_at" and
      ("acknowledgement_record" ->> 'recordedAt')::timestamptz is not distinct from "recorded_at" and
      ("acknowledgement_record" ->> 'servedAt')::timestamptz is not distinct from "served_at"
    )
);
--> statement-breakpoint
ALTER TABLE "privacy"."notice_acknowledgements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "privacy"."notice_acknowledgements" ADD CONSTRAINT "privacy_notice_ack_notice_fk" FOREIGN KEY ("tenant_id","legal_entity_id","notice_version_id") REFERENCES "privacy"."notice_versions"("tenant_id","legal_entity_id","notice_version_id");--> statement-breakpoint
ALTER TABLE "privacy"."notice_acknowledgements" ADD CONSTRAINT "privacy_notice_ack_subject_fk" FOREIGN KEY ("tenant_id","legal_entity_id","privacy_subject_id") REFERENCES "privacy"."privacy_subjects"("tenant_id","legal_entity_id","privacy_subject_id");--> statement-breakpoint
CREATE POLICY "privacy_notice_ack_scope_select" ON "privacy"."notice_acknowledgements" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."notice_acknowledgements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."notice_acknowledgements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_notice_ack_scope_insert" ON "privacy"."notice_acknowledgements" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."notice_acknowledgements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."notice_acknowledgements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_notice_ack_scope_update" ON "privacy"."notice_acknowledgements" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."notice_acknowledgements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."notice_acknowledgements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."notice_acknowledgements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."notice_acknowledgements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_notice_ack_scope_delete" ON "privacy"."notice_acknowledgements" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."notice_acknowledgements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."notice_acknowledgements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "privacy"."notice_acknowledgements" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "privacy"."notice_acknowledgements" TO "ontos_runtime";
--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE "privacy"."notice_acknowledgements" FROM "ontos_runtime";
--> statement-breakpoint
CREATE TRIGGER "privacy_notice_acknowledgements_immutable"
BEFORE UPDATE OR DELETE ON "privacy"."notice_acknowledgements"
FOR EACH ROW EXECUTE FUNCTION "privacy"."reject_immutable_ledger_mutation"();
