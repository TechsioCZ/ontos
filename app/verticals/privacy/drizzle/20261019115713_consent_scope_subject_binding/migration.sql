CREATE TABLE "privacy"."consent_scope_bindings" (
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scope_ref" text NOT NULL,
	"privacy_subject_id" uuid NOT NULL,
	CONSTRAINT "privacy_consent_scope_bindings_scope_uk" UNIQUE("tenant_id","legal_entity_id","scope_ref")
);
--> statement-breakpoint
ALTER TABLE "privacy"."consent_scope_bindings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "privacy"."consent_scope_bindings" ADD CONSTRAINT "privacy_consent_scope_bindings_subject_fk" FOREIGN KEY ("tenant_id","legal_entity_id","privacy_subject_id") REFERENCES "privacy"."privacy_subjects"("tenant_id","legal_entity_id","privacy_subject_id");--> statement-breakpoint
CREATE POLICY "privacy_consent_scope_bindings_scope_select" ON "privacy"."consent_scope_bindings" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."consent_scope_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."consent_scope_bindings"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_consent_scope_bindings_scope_insert" ON "privacy"."consent_scope_bindings" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."consent_scope_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."consent_scope_bindings"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_consent_scope_bindings_scope_update" ON "privacy"."consent_scope_bindings" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."consent_scope_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."consent_scope_bindings"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."consent_scope_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."consent_scope_bindings"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_consent_scope_bindings_scope_delete" ON "privacy"."consent_scope_bindings" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."consent_scope_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."consent_scope_bindings"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "privacy"."consent_scope_bindings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "privacy"."consent_scope_bindings" TO "ontos_runtime";
--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE "privacy"."consent_scope_bindings" FROM "ontos_runtime";
--> statement-breakpoint
CREATE TRIGGER "privacy_consent_scope_bindings_immutable"
BEFORE UPDATE OR DELETE ON "privacy"."consent_scope_bindings"
FOR EACH ROW EXECUTE FUNCTION "privacy"."reject_immutable_ledger_mutation"();
--> statement-breakpoint
CREATE FUNCTION "privacy"."require_consent_subject_binding"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  bound_subject jsonb;
BEGIN
  SELECT jsonb_build_object(
    'moduleId', 'privacy.core', 'resourceType', 'privacy.core.privacy-subject',
    'resourceId', binding.privacy_subject_id::text, 'tenantId', binding.tenant_id::text
  ) INTO bound_subject
  FROM "privacy"."consent_scope_bindings" AS binding
  WHERE binding.tenant_id = NEW.tenant_id
    AND binding.legal_entity_id = NEW.legal_entity_id
    AND binding.scope_ref = NEW.scope_ref;

  IF bound_subject IS NULL
    OR NEW.decision_record -> 'scope' -> 'privacySubjectRef' IS DISTINCT FROM bound_subject
    OR NEW.decision_record -> 'scope' ->> 'scopeRef' IS DISTINCT FROM NEW.scope_ref
    OR EXISTS (
      SELECT 1 FROM "privacy"."consent_decisions" AS retained
      WHERE retained.tenant_id = NEW.tenant_id
        AND retained.legal_entity_id = NEW.legal_entity_id
        AND retained.scope_ref = NEW.scope_ref
        AND retained.decision_record -> 'scope' -> 'privacySubjectRef' IS DISTINCT FROM bound_subject
    )
  THEN
    RAISE EXCEPTION 'Consent scope requires one exact retained Subject binding'
      USING ERRCODE = '23514', CONSTRAINT = 'privacy_consent_subject_binding_ck';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "privacy_consent_subject_binding_guard"
BEFORE INSERT ON "privacy"."consent_decisions"
FOR EACH ROW EXECUTE FUNCTION "privacy"."require_consent_subject_binding"();
