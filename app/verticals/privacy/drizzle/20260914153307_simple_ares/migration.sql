CREATE TABLE "privacy"."applicability_decisions" (
	"decision_id" text PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"processing_scope_ref" text NOT NULL,
	"operation" text NOT NULL,
	"outcome" text NOT NULL,
	"decision_record" jsonb NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_applicability_decisions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","decision_id"),
	CONSTRAINT "privacy_applicability_decisions_invocation_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id"),
	CONSTRAINT "privacy_applicability_decisions_outcome_ck" CHECK ("outcome" in ('APPLICABLE', 'UNRESOLVED', 'CONFLICT')),
	CONSTRAINT "privacy_applicability_decisions_operation_ck" CHECK (char_length(btrim("operation")) between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "privacy"."applicability_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy"."dsr_delivery_access" (
	"access_id" text PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"delivery_output_ref" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"access_record" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"action_invocation_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_dsr_delivery_access_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","access_id"),
	CONSTRAINT "privacy_dsr_delivery_access_idempotency_uk" UNIQUE("tenant_id","legal_entity_id","idempotency_key"),
	CONSTRAINT "privacy_dsr_delivery_access_invocation_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id"),
	CONSTRAINT "privacy_dsr_delivery_access_expiry_ck" CHECK ("expires_at" > "recorded_at")
);
--> statement-breakpoint
ALTER TABLE "privacy"."dsr_delivery_access" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy"."eligibility_evidence" (
	"evidence_id" text PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"processing_scope_ref" text NOT NULL,
	"outcome" text NOT NULL,
	"evidence_record" jsonb NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_eligibility_evidence_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","evidence_id"),
	CONSTRAINT "privacy_eligibility_evidence_invocation_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id"),
	CONSTRAINT "privacy_eligibility_evidence_outcome_ck" CHECK ("outcome" in ('ALLOWED', 'NOT_ALLOWED', 'INDETERMINATE'))
);
--> statement-breakpoint
ALTER TABLE "privacy"."eligibility_evidence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy"."external_obligations" (
	"obligation_id" text PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"measure_id" text NOT NULL,
	"revision" integer NOT NULL,
	"status" text NOT NULL,
	"obligation_record" jsonb NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_external_obligations_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","obligation_id"),
	CONSTRAINT "privacy_external_obligations_invocation_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id"),
	CONSTRAINT "privacy_external_obligations_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "privacy_external_obligations_status_ck" CHECK ("status" in ('PENDING', 'ACHIEVED', 'PARTIAL', 'BUSINESS_REJECTED', 'NOT_APPLICABLE', 'FAILED', 'BLOCKED', 'INDETERMINATE'))
);
--> statement-breakpoint
ALTER TABLE "privacy"."external_obligations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy"."legal_basis_assignments" (
	"assignment_ref" text PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"processing_scope_ref" text NOT NULL,
	"decision" text NOT NULL,
	"assignment_record" jsonb NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"action_invocation_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_legal_basis_assignments_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","assignment_ref"),
	CONSTRAINT "privacy_legal_basis_assignments_invocation_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id"),
	CONSTRAINT "privacy_legal_basis_assignments_decision_ck" CHECK ("decision" in ('APPROVED', 'REJECTED')),
	CONSTRAINT "privacy_legal_basis_assignments_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from")
);
--> statement-breakpoint
ALTER TABLE "privacy"."legal_basis_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy"."legal_holds" (
	"hold_event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"hold_ref" text NOT NULL,
	"hold_record" jsonb NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"action_invocation_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_legal_holds_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","hold_event_id"),
	CONSTRAINT "privacy_legal_holds_invocation_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id"),
	CONSTRAINT "privacy_legal_holds_period_ck" CHECK ("effective_to" > "effective_from")
);
--> statement-breakpoint
ALTER TABLE "privacy"."legal_holds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy"."responsibility_assignments" (
	"assignment_ref" text PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"scope_ref" text NOT NULL,
	"role" text NOT NULL,
	"assignment_record" jsonb NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"action_invocation_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_responsibility_assignments_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","assignment_ref"),
	CONSTRAINT "privacy_responsibility_assignments_invocation_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id"),
	CONSTRAINT "privacy_responsibility_assignments_role_ck" CHECK ("role" in ('CONTROLLER', 'PROCESSOR', 'RECIPIENT')),
	CONSTRAINT "privacy_responsibility_assignments_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from")
);
--> statement-breakpoint
ALTER TABLE "privacy"."responsibility_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy"."retention_exceptions" (
	"exception_event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"exception_ref" text NOT NULL,
	"exception_record" jsonb NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"action_invocation_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_retention_exceptions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","exception_event_id"),
	CONSTRAINT "privacy_retention_exceptions_invocation_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id"),
	CONSTRAINT "privacy_retention_exceptions_period_ck" CHECK ("effective_to" > "effective_from")
);
--> statement-breakpoint
ALTER TABLE "privacy"."retention_exceptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy"."retention_rules" (
	"retention_rule_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"rule_ref" text NOT NULL,
	"rule_version" integer NOT NULL,
	"content_scope_ref" text NOT NULL,
	"rule_record" jsonb NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"action_invocation_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_retention_rules_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","retention_rule_id"),
	CONSTRAINT "privacy_retention_rules_version_uk" UNIQUE("tenant_id","legal_entity_id","rule_ref","rule_version"),
	CONSTRAINT "privacy_retention_rules_invocation_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id"),
	CONSTRAINT "privacy_retention_rules_version_ck" CHECK ("rule_version" > 0),
	CONSTRAINT "privacy_retention_rules_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from")
);
--> statement-breakpoint
ALTER TABLE "privacy"."retention_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "privacy"."disposition_decisions" ADD COLUMN "rule_ref" text NOT NULL;--> statement-breakpoint
ALTER TABLE "privacy"."disposition_decisions" ADD COLUMN "rule_version" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "privacy"."retention_evaluation_work" ADD COLUMN "rule_ref" text NOT NULL;--> statement-breakpoint
ALTER TABLE "privacy"."retention_evaluation_work" ADD COLUMN "rule_version" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "privacy"."anti_resurrection_protections" DROP COLUMN "active";--> statement-breakpoint
CREATE INDEX "privacy_anti_resurrection_subject_idx" ON "privacy"."anti_resurrection_protections" ("tenant_id","legal_entity_id","subject_ref","measure","protected_at");--> statement-breakpoint
CREATE INDEX "privacy_applicability_decisions_scope_idx" ON "privacy"."applicability_decisions" ("tenant_id","legal_entity_id","processing_scope_ref","operation","evaluated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "privacy_dsr_delivery_access_current_uk" ON "privacy"."dsr_delivery_access" ("tenant_id","legal_entity_id","delivery_output_ref") WHERE "revoked_at" is null;--> statement-breakpoint
CREATE INDEX "privacy_dsr_delivery_access_expiry_idx" ON "privacy"."dsr_delivery_access" ("tenant_id","legal_entity_id","expires_at","revoked_at");--> statement-breakpoint
CREATE INDEX "privacy_eligibility_evidence_decision_idx" ON "privacy"."eligibility_evidence" ("tenant_id","legal_entity_id","processing_scope_ref","evaluated_at");--> statement-breakpoint
CREATE INDEX "privacy_external_obligations_status_idx" ON "privacy"."external_obligations" ("tenant_id","legal_entity_id","measure_id","status");--> statement-breakpoint
CREATE INDEX "privacy_legal_basis_assignments_current_idx" ON "privacy"."legal_basis_assignments" ("tenant_id","legal_entity_id","processing_scope_ref","effective_from","effective_to");--> statement-breakpoint
CREATE INDEX "privacy_legal_holds_history_idx" ON "privacy"."legal_holds" ("tenant_id","legal_entity_id","hold_ref","recorded_at");--> statement-breakpoint
CREATE INDEX "privacy_responsibility_assignments_current_idx" ON "privacy"."responsibility_assignments" ("tenant_id","legal_entity_id","scope_ref","role","effective_from","effective_to");--> statement-breakpoint
CREATE INDEX "privacy_retention_exceptions_history_idx" ON "privacy"."retention_exceptions" ("tenant_id","legal_entity_id","exception_ref","recorded_at");--> statement-breakpoint
CREATE INDEX "privacy_retention_rules_scope_idx" ON "privacy"."retention_rules" ("tenant_id","legal_entity_id","content_scope_ref","effective_from","effective_to");--> statement-breakpoint
ALTER TABLE "privacy"."disposition_decisions" ADD CONSTRAINT "privacy_disposition_rule_fk" FOREIGN KEY ("tenant_id","legal_entity_id","rule_ref","rule_version") REFERENCES "privacy"."retention_rules"("tenant_id","legal_entity_id","rule_ref","rule_version");--> statement-breakpoint
ALTER TABLE "privacy"."external_obligations" ADD CONSTRAINT "privacy_external_obligations_measure_fk" FOREIGN KEY ("tenant_id","legal_entity_id","measure_id") REFERENCES "privacy"."privacy_measure_dispatches"("tenant_id","legal_entity_id","measure_id");--> statement-breakpoint
ALTER TABLE "privacy"."retention_evaluation_work" ADD CONSTRAINT "privacy_retention_work_rule_fk" FOREIGN KEY ("tenant_id","legal_entity_id","rule_ref","rule_version") REFERENCES "privacy"."retention_rules"("tenant_id","legal_entity_id","rule_ref","rule_version");--> statement-breakpoint
ALTER TABLE "privacy"."anti_resurrection_protections" ADD CONSTRAINT "privacy_anti_resurrection_measure_ck" CHECK ("measure" in ('DELETE', 'ANONYMIZE'));--> statement-breakpoint
ALTER TABLE "privacy"."disposition_decisions" ADD CONSTRAINT "privacy_disposition_decisions_rule_version_ck" CHECK ("rule_version" > 0);--> statement-breakpoint
ALTER TABLE "privacy"."disposition_decisions" ADD CONSTRAINT "privacy_disposition_decisions_outcome_ck" CHECK ("outcome" in ('RETAIN', 'RESTRICT', 'ANONYMIZE', 'DELETE', 'INDETERMINATE'));--> statement-breakpoint
ALTER TABLE "privacy"."retention_evaluation_work" ADD CONSTRAINT "privacy_retention_work_rule_version_ck" CHECK ("rule_version" > 0);--> statement-breakpoint
ALTER TABLE "privacy"."retention_evaluation_work" ADD CONSTRAINT "privacy_retention_work_status_ck" CHECK ("status" in ('PENDING', 'READY', 'BLOCKED', 'INDETERMINATE', 'COMPLETED'));--> statement-breakpoint
CREATE POLICY "privacy_applicability_decisions_scope_select" ON "privacy"."applicability_decisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."applicability_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."applicability_decisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_applicability_decisions_scope_insert" ON "privacy"."applicability_decisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."applicability_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."applicability_decisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_applicability_decisions_scope_update" ON "privacy"."applicability_decisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."applicability_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."applicability_decisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."applicability_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."applicability_decisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_applicability_decisions_scope_delete" ON "privacy"."applicability_decisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."applicability_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."applicability_decisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_delivery_access_scope_select" ON "privacy"."dsr_delivery_access" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."dsr_delivery_access"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_delivery_access"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_delivery_access_scope_insert" ON "privacy"."dsr_delivery_access" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."dsr_delivery_access"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_delivery_access"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_delivery_access_scope_update" ON "privacy"."dsr_delivery_access" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."dsr_delivery_access"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_delivery_access"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."dsr_delivery_access"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_delivery_access"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_delivery_access_scope_delete" ON "privacy"."dsr_delivery_access" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."dsr_delivery_access"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_delivery_access"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_eligibility_evidence_scope_select" ON "privacy"."eligibility_evidence" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."eligibility_evidence"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."eligibility_evidence"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_eligibility_evidence_scope_insert" ON "privacy"."eligibility_evidence" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."eligibility_evidence"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."eligibility_evidence"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_eligibility_evidence_scope_update" ON "privacy"."eligibility_evidence" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."eligibility_evidence"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."eligibility_evidence"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."eligibility_evidence"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."eligibility_evidence"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_eligibility_evidence_scope_delete" ON "privacy"."eligibility_evidence" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."eligibility_evidence"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."eligibility_evidence"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_external_obligations_scope_select" ON "privacy"."external_obligations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."external_obligations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."external_obligations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_external_obligations_scope_insert" ON "privacy"."external_obligations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."external_obligations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."external_obligations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_external_obligations_scope_update" ON "privacy"."external_obligations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."external_obligations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."external_obligations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."external_obligations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."external_obligations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_external_obligations_scope_delete" ON "privacy"."external_obligations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."external_obligations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."external_obligations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_legal_basis_assignments_scope_select" ON "privacy"."legal_basis_assignments" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."legal_basis_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."legal_basis_assignments"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_legal_basis_assignments_scope_insert" ON "privacy"."legal_basis_assignments" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."legal_basis_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."legal_basis_assignments"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_legal_basis_assignments_scope_update" ON "privacy"."legal_basis_assignments" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."legal_basis_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."legal_basis_assignments"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."legal_basis_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."legal_basis_assignments"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_legal_basis_assignments_scope_delete" ON "privacy"."legal_basis_assignments" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."legal_basis_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."legal_basis_assignments"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_legal_holds_scope_select" ON "privacy"."legal_holds" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."legal_holds"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."legal_holds"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_legal_holds_scope_insert" ON "privacy"."legal_holds" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."legal_holds"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."legal_holds"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_legal_holds_scope_update" ON "privacy"."legal_holds" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."legal_holds"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."legal_holds"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."legal_holds"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."legal_holds"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_legal_holds_scope_delete" ON "privacy"."legal_holds" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."legal_holds"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."legal_holds"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_responsibility_assignments_scope_select" ON "privacy"."responsibility_assignments" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."responsibility_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."responsibility_assignments"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_responsibility_assignments_scope_insert" ON "privacy"."responsibility_assignments" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."responsibility_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."responsibility_assignments"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_responsibility_assignments_scope_update" ON "privacy"."responsibility_assignments" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."responsibility_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."responsibility_assignments"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."responsibility_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."responsibility_assignments"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_responsibility_assignments_scope_delete" ON "privacy"."responsibility_assignments" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."responsibility_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."responsibility_assignments"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_retention_exceptions_scope_select" ON "privacy"."retention_exceptions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."retention_exceptions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."retention_exceptions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_retention_exceptions_scope_insert" ON "privacy"."retention_exceptions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."retention_exceptions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."retention_exceptions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_retention_exceptions_scope_update" ON "privacy"."retention_exceptions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."retention_exceptions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."retention_exceptions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."retention_exceptions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."retention_exceptions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_retention_exceptions_scope_delete" ON "privacy"."retention_exceptions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."retention_exceptions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."retention_exceptions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_retention_rules_scope_select" ON "privacy"."retention_rules" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."retention_rules"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."retention_rules"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_retention_rules_scope_insert" ON "privacy"."retention_rules" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."retention_rules"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."retention_rules"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_retention_rules_scope_update" ON "privacy"."retention_rules" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."retention_rules"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."retention_rules"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."retention_rules"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."retention_rules"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_retention_rules_scope_delete" ON "privacy"."retention_rules" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."retention_rules"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."retention_rules"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "privacy"."applicability_decisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "privacy"."dsr_delivery_access" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "privacy"."eligibility_evidence" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "privacy"."external_obligations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "privacy"."legal_basis_assignments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "privacy"."legal_holds" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "privacy"."responsibility_assignments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "privacy"."retention_exceptions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "privacy"."retention_rules" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "privacy_anti_resurrection_immutable"
BEFORE UPDATE OR DELETE ON "privacy"."anti_resurrection_protections"
FOR EACH ROW EXECUTE FUNCTION "privacy"."reject_immutable_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "privacy_applicability_decisions_immutable"
BEFORE UPDATE OR DELETE ON "privacy"."applicability_decisions"
FOR EACH ROW EXECUTE FUNCTION "privacy"."reject_immutable_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "privacy_eligibility_evidence_immutable"
BEFORE UPDATE OR DELETE ON "privacy"."eligibility_evidence"
FOR EACH ROW EXECUTE FUNCTION "privacy"."reject_immutable_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "privacy_legal_basis_assignments_immutable"
BEFORE UPDATE OR DELETE ON "privacy"."legal_basis_assignments"
FOR EACH ROW EXECUTE FUNCTION "privacy"."reject_immutable_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "privacy_legal_holds_immutable"
BEFORE UPDATE OR DELETE ON "privacy"."legal_holds"
FOR EACH ROW EXECUTE FUNCTION "privacy"."reject_immutable_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "privacy_responsibility_assignments_immutable"
BEFORE UPDATE OR DELETE ON "privacy"."responsibility_assignments"
FOR EACH ROW EXECUTE FUNCTION "privacy"."reject_immutable_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "privacy_retention_exceptions_immutable"
BEFORE UPDATE OR DELETE ON "privacy"."retention_exceptions"
FOR EACH ROW EXECUTE FUNCTION "privacy"."reject_immutable_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "privacy_retention_rules_immutable"
BEFORE UPDATE OR DELETE ON "privacy"."retention_rules"
FOR EACH ROW EXECUTE FUNCTION "privacy"."reject_immutable_ledger_mutation"();
--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE
  "privacy"."anti_resurrection_protections",
  "privacy"."applicability_decisions",
  "privacy"."eligibility_evidence",
  "privacy"."legal_basis_assignments",
  "privacy"."legal_holds",
  "privacy"."responsibility_assignments",
  "privacy"."retention_exceptions",
  "privacy"."retention_rules"
FROM "ontos_runtime";
