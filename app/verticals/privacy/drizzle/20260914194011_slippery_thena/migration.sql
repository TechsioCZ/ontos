CREATE TABLE "privacy"."applicability_policies" (
	"applicability_policy_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"policy_key" text NOT NULL,
	"policy_version" text NOT NULL,
	"scope_key" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"policy_record" jsonb NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_applicability_policies_version_uk" UNIQUE("tenant_id","legal_entity_id","policy_key","policy_version"),
	CONSTRAINT "privacy_applicability_policies_invocation_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id"),
	CONSTRAINT "privacy_applicability_policies_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from")
);
--> statement-breakpoint
ALTER TABLE "privacy"."applicability_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy"."dsr_deadlines" (
	"deadline_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"case_ref" text NOT NULL,
	"controller_ref" text NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"deadline_record" jsonb NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_dsr_deadlines_invocation_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id")
);
--> statement-breakpoint
ALTER TABLE "privacy"."dsr_deadlines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy"."dsr_delivery_evidence" (
	"evidence_id" text PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"access_id" text NOT NULL,
	"delivery_output_ref" text NOT NULL,
	"outcome" text NOT NULL,
	"evidence_record" jsonb NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_dsr_delivery_evidence_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","evidence_id"),
	CONSTRAINT "privacy_dsr_delivery_evidence_invocation_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id"),
	CONSTRAINT "privacy_dsr_delivery_evidence_outcome_ck" CHECK ("outcome" in ('SUCCESSFUL_DELIVERY', 'KNOWN_FAILURE', 'UNAUTHORIZED_ACCESS', 'INDETERMINATE_HANDOFF'))
);
--> statement-breakpoint
ALTER TABLE "privacy"."dsr_delivery_evidence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy"."dsr_resolver_assignments" (
	"assignment_ref" text PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"case_ref" text NOT NULL,
	"controller_ref" text NOT NULL,
	"assigned_at" timestamp with time zone NOT NULL,
	"assignment_record" jsonb NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_dsr_resolver_assignments_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","assignment_ref"),
	CONSTRAINT "privacy_dsr_resolver_assignments_invocation_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id")
);
--> statement-breakpoint
ALTER TABLE "privacy"."dsr_resolver_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy"."dsr_responses" (
	"response_ref" text PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"case_ref" text NOT NULL,
	"final" boolean NOT NULL,
	"response_record" jsonb NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_dsr_responses_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","response_ref"),
	CONSTRAINT "privacy_dsr_responses_invocation_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id")
);
--> statement-breakpoint
ALTER TABLE "privacy"."dsr_responses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy"."dsr_substantive_decisions" (
	"decision_ref" text PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"case_ref" text NOT NULL,
	"controller_ref" text NOT NULL,
	"right" text NOT NULL,
	"outcome" text NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"decision_record" jsonb NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_dsr_substantive_decisions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","decision_ref"),
	CONSTRAINT "privacy_dsr_substantive_decisions_invocation_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id"),
	CONSTRAINT "privacy_dsr_substantive_decisions_outcome_ck" CHECK ("outcome" in ('GRANTED', 'PARTIALLY_GRANTED', 'DENIED', 'UNRESOLVED'))
);
--> statement-breakpoint
ALTER TABLE "privacy"."dsr_substantive_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy"."dsr_verifications" (
	"verification_ref" text PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"case_ref" text NOT NULL,
	"subject_ref" text NOT NULL,
	"verification_scope" text NOT NULL,
	"outcome" text NOT NULL,
	"verification_record" jsonb NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_dsr_verifications_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","verification_ref"),
	CONSTRAINT "privacy_dsr_verifications_invocation_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id"),
	CONSTRAINT "privacy_dsr_verifications_scope_ck" CHECK ("verification_scope" in ('INTAKE', 'SENSITIVE_LOOKUP', 'EXPORT', 'MUTATION')),
	CONSTRAINT "privacy_dsr_verifications_outcome_ck" CHECK ("outcome" in ('PENDING', 'VERIFIED', 'FAILED', 'EXPIRED'))
);
--> statement-breakpoint
ALTER TABLE "privacy"."dsr_verifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy"."owner_contributions" (
	"contribution_id" text PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"controller_obligation_ref" text NOT NULL,
	"owner_module_id" text NOT NULL,
	"subject_ref" text NOT NULL,
	"right" text NOT NULL,
	"revision" integer NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"contribution_record" jsonb NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_owner_contributions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","contribution_id"),
	CONSTRAINT "privacy_owner_contributions_invocation_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id"),
	CONSTRAINT "privacy_owner_contributions_revision_uk" UNIQUE("tenant_id","legal_entity_id","controller_obligation_ref","owner_module_id","subject_ref","right","revision"),
	CONSTRAINT "privacy_owner_contributions_revision_ck" CHECK ("revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "privacy"."owner_contributions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy"."privacy_representations" (
	"representation_id" text PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"subject_ref" text NOT NULL,
	"representative_principal_id" uuid NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"representation_record" jsonb NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_representations_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","representation_id"),
	CONSTRAINT "privacy_representations_invocation_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id"),
	CONSTRAINT "privacy_representations_period_ck" CHECK ("valid_to" is null or "valid_to" > "valid_from")
);
--> statement-breakpoint
ALTER TABLE "privacy"."privacy_representations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy"."processing_interventions" (
	"intervention_ref" text PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"intervention_kind" text NOT NULL,
	"processing_scope_ref" text NOT NULL,
	"status" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"intervention_record" jsonb NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_processing_interventions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","intervention_ref"),
	CONSTRAINT "privacy_processing_interventions_invocation_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id"),
	CONSTRAINT "privacy_processing_interventions_kind_ck" CHECK ("intervention_kind" in ('OBJECTION', 'RESTRICTION')),
	CONSTRAINT "privacy_processing_interventions_status_ck" CHECK ("status" in ('ACTIVE', 'RESOLVED', 'ABSENT'))
);
--> statement-breakpoint
ALTER TABLE "privacy"."processing_interventions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy"."temporary_dsr_exports" (
	"export_ref" text PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"delivery_output_ref" text NOT NULL,
	"delivery_output_revision" integer NOT NULL,
	"retain_until" timestamp with time zone NOT NULL,
	"disposed_at" timestamp with time zone,
	"export_record" jsonb NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_temporary_dsr_exports_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","export_ref"),
	CONSTRAINT "privacy_temporary_dsr_exports_invocation_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id"),
	CONSTRAINT "privacy_temporary_dsr_exports_revision_ck" CHECK ("delivery_output_revision" > 0),
	CONSTRAINT "privacy_temporary_dsr_exports_retention_ck" CHECK ("retain_until" > "created_at")
);
--> statement-breakpoint
ALTER TABLE "privacy"."temporary_dsr_exports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "privacy"."dsr_owner_tasks" ADD COLUMN "action_invocation_id" uuid;--> statement-breakpoint
UPDATE "privacy"."dsr_owner_tasks" SET "action_invocation_id" = gen_random_uuid() WHERE "action_invocation_id" IS NULL;--> statement-breakpoint
ALTER TABLE "privacy"."dsr_owner_tasks" ALTER COLUMN "action_invocation_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "privacy"."dsr_owner_tasks" ADD CONSTRAINT "privacy_dsr_owner_tasks_invocation_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id");--> statement-breakpoint
CREATE INDEX "privacy_applicability_policies_scope_idx" ON "privacy"."applicability_policies" ("tenant_id","legal_entity_id","scope_key","effective_from","effective_to");--> statement-breakpoint
CREATE INDEX "privacy_dsr_deadlines_case_idx" ON "privacy"."dsr_deadlines" ("tenant_id","legal_entity_id","case_ref","controller_ref","deadline_at");--> statement-breakpoint
CREATE INDEX "privacy_dsr_delivery_evidence_output_idx" ON "privacy"."dsr_delivery_evidence" ("tenant_id","legal_entity_id","delivery_output_ref","occurred_at");--> statement-breakpoint
CREATE INDEX "privacy_dsr_resolver_assignments_current_idx" ON "privacy"."dsr_resolver_assignments" ("tenant_id","legal_entity_id","case_ref","controller_ref","assigned_at");--> statement-breakpoint
CREATE INDEX "privacy_dsr_responses_case_idx" ON "privacy"."dsr_responses" ("tenant_id","legal_entity_id","case_ref","created_at");--> statement-breakpoint
CREATE INDEX "privacy_dsr_substantive_decisions_case_idx" ON "privacy"."dsr_substantive_decisions" ("tenant_id","legal_entity_id","case_ref","controller_ref","right","decided_at");--> statement-breakpoint
CREATE INDEX "privacy_dsr_verifications_case_idx" ON "privacy"."dsr_verifications" ("tenant_id","legal_entity_id","case_ref","subject_ref");--> statement-breakpoint
CREATE INDEX "privacy_owner_contributions_obligation_idx" ON "privacy"."owner_contributions" ("tenant_id","legal_entity_id","controller_obligation_ref","observed_at");--> statement-breakpoint
CREATE INDEX "privacy_representations_subject_idx" ON "privacy"."privacy_representations" ("tenant_id","legal_entity_id","subject_ref","valid_from","valid_to");--> statement-breakpoint
CREATE INDEX "privacy_processing_interventions_current_idx" ON "privacy"."processing_interventions" ("tenant_id","legal_entity_id","processing_scope_ref","intervention_kind","observed_at");--> statement-breakpoint
CREATE INDEX "privacy_temporary_dsr_exports_retention_idx" ON "privacy"."temporary_dsr_exports" ("tenant_id","legal_entity_id","retain_until","disposed_at");--> statement-breakpoint
ALTER TABLE "privacy"."dsr_deadlines" ADD CONSTRAINT "privacy_dsr_deadlines_case_fk" FOREIGN KEY ("tenant_id","legal_entity_id","case_ref") REFERENCES "privacy"."dsr_cases"("tenant_id","legal_entity_id","case_ref");--> statement-breakpoint
ALTER TABLE "privacy"."dsr_delivery_evidence" ADD CONSTRAINT "privacy_dsr_delivery_evidence_access_fk" FOREIGN KEY ("tenant_id","legal_entity_id","access_id") REFERENCES "privacy"."dsr_delivery_access"("tenant_id","legal_entity_id","access_id");--> statement-breakpoint
ALTER TABLE "privacy"."dsr_resolver_assignments" ADD CONSTRAINT "privacy_dsr_resolver_assignments_case_fk" FOREIGN KEY ("tenant_id","legal_entity_id","case_ref") REFERENCES "privacy"."dsr_cases"("tenant_id","legal_entity_id","case_ref");--> statement-breakpoint
ALTER TABLE "privacy"."dsr_responses" ADD CONSTRAINT "privacy_dsr_responses_case_fk" FOREIGN KEY ("tenant_id","legal_entity_id","case_ref") REFERENCES "privacy"."dsr_cases"("tenant_id","legal_entity_id","case_ref");--> statement-breakpoint
ALTER TABLE "privacy"."dsr_substantive_decisions" ADD CONSTRAINT "privacy_dsr_substantive_decisions_case_fk" FOREIGN KEY ("tenant_id","legal_entity_id","case_ref") REFERENCES "privacy"."dsr_cases"("tenant_id","legal_entity_id","case_ref");--> statement-breakpoint
ALTER TABLE "privacy"."dsr_verifications" ADD CONSTRAINT "privacy_dsr_verifications_case_fk" FOREIGN KEY ("tenant_id","legal_entity_id","case_ref") REFERENCES "privacy"."dsr_cases"("tenant_id","legal_entity_id","case_ref");--> statement-breakpoint
CREATE POLICY "privacy_applicability_policies_scope_select" ON "privacy"."applicability_policies" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."applicability_policies"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."applicability_policies"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_applicability_policies_scope_insert" ON "privacy"."applicability_policies" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."applicability_policies"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."applicability_policies"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_applicability_policies_scope_update" ON "privacy"."applicability_policies" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."applicability_policies"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."applicability_policies"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."applicability_policies"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."applicability_policies"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_applicability_policies_scope_delete" ON "privacy"."applicability_policies" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."applicability_policies"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."applicability_policies"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_deadlines_scope_select" ON "privacy"."dsr_deadlines" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."dsr_deadlines"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_deadlines"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_deadlines_scope_insert" ON "privacy"."dsr_deadlines" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."dsr_deadlines"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_deadlines"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_deadlines_scope_update" ON "privacy"."dsr_deadlines" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."dsr_deadlines"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_deadlines"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."dsr_deadlines"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_deadlines"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_deadlines_scope_delete" ON "privacy"."dsr_deadlines" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."dsr_deadlines"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_deadlines"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_delivery_evidence_scope_select" ON "privacy"."dsr_delivery_evidence" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."dsr_delivery_evidence"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_delivery_evidence"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_delivery_evidence_scope_insert" ON "privacy"."dsr_delivery_evidence" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."dsr_delivery_evidence"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_delivery_evidence"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_delivery_evidence_scope_update" ON "privacy"."dsr_delivery_evidence" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."dsr_delivery_evidence"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_delivery_evidence"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."dsr_delivery_evidence"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_delivery_evidence"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_delivery_evidence_scope_delete" ON "privacy"."dsr_delivery_evidence" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."dsr_delivery_evidence"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_delivery_evidence"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_resolver_assignments_scope_select" ON "privacy"."dsr_resolver_assignments" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."dsr_resolver_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_resolver_assignments"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_resolver_assignments_scope_insert" ON "privacy"."dsr_resolver_assignments" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."dsr_resolver_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_resolver_assignments"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_resolver_assignments_scope_update" ON "privacy"."dsr_resolver_assignments" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."dsr_resolver_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_resolver_assignments"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."dsr_resolver_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_resolver_assignments"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_resolver_assignments_scope_delete" ON "privacy"."dsr_resolver_assignments" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."dsr_resolver_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_resolver_assignments"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_responses_scope_select" ON "privacy"."dsr_responses" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."dsr_responses"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_responses"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_responses_scope_insert" ON "privacy"."dsr_responses" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."dsr_responses"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_responses"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_responses_scope_update" ON "privacy"."dsr_responses" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."dsr_responses"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_responses"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."dsr_responses"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_responses"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_responses_scope_delete" ON "privacy"."dsr_responses" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."dsr_responses"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_responses"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_substantive_decisions_scope_select" ON "privacy"."dsr_substantive_decisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."dsr_substantive_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_substantive_decisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_substantive_decisions_scope_insert" ON "privacy"."dsr_substantive_decisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."dsr_substantive_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_substantive_decisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_substantive_decisions_scope_update" ON "privacy"."dsr_substantive_decisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."dsr_substantive_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_substantive_decisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."dsr_substantive_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_substantive_decisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_substantive_decisions_scope_delete" ON "privacy"."dsr_substantive_decisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."dsr_substantive_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_substantive_decisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_verifications_scope_select" ON "privacy"."dsr_verifications" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."dsr_verifications"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_verifications"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_verifications_scope_insert" ON "privacy"."dsr_verifications" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."dsr_verifications"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_verifications"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_verifications_scope_update" ON "privacy"."dsr_verifications" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."dsr_verifications"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_verifications"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."dsr_verifications"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_verifications"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_dsr_verifications_scope_delete" ON "privacy"."dsr_verifications" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."dsr_verifications"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."dsr_verifications"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_owner_contributions_scope_select" ON "privacy"."owner_contributions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."owner_contributions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."owner_contributions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_owner_contributions_scope_insert" ON "privacy"."owner_contributions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."owner_contributions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."owner_contributions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_owner_contributions_scope_update" ON "privacy"."owner_contributions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."owner_contributions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."owner_contributions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."owner_contributions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."owner_contributions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_owner_contributions_scope_delete" ON "privacy"."owner_contributions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."owner_contributions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."owner_contributions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_representations_scope_select" ON "privacy"."privacy_representations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."privacy_representations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."privacy_representations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_representations_scope_insert" ON "privacy"."privacy_representations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."privacy_representations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."privacy_representations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_representations_scope_update" ON "privacy"."privacy_representations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."privacy_representations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."privacy_representations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."privacy_representations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."privacy_representations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_representations_scope_delete" ON "privacy"."privacy_representations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."privacy_representations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."privacy_representations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_processing_interventions_scope_select" ON "privacy"."processing_interventions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."processing_interventions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."processing_interventions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_processing_interventions_scope_insert" ON "privacy"."processing_interventions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."processing_interventions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."processing_interventions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_processing_interventions_scope_update" ON "privacy"."processing_interventions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."processing_interventions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."processing_interventions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."processing_interventions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."processing_interventions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_processing_interventions_scope_delete" ON "privacy"."processing_interventions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."processing_interventions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."processing_interventions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_temporary_dsr_exports_scope_select" ON "privacy"."temporary_dsr_exports" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("privacy"."temporary_dsr_exports"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."temporary_dsr_exports"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_temporary_dsr_exports_scope_insert" ON "privacy"."temporary_dsr_exports" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("privacy"."temporary_dsr_exports"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."temporary_dsr_exports"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_temporary_dsr_exports_scope_update" ON "privacy"."temporary_dsr_exports" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("privacy"."temporary_dsr_exports"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."temporary_dsr_exports"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("privacy"."temporary_dsr_exports"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."temporary_dsr_exports"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "privacy_temporary_dsr_exports_scope_delete" ON "privacy"."temporary_dsr_exports" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("privacy"."temporary_dsr_exports"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "privacy"."temporary_dsr_exports"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "privacy"."applicability_policies" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "privacy"."dsr_deadlines" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "privacy"."dsr_delivery_evidence" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "privacy"."dsr_resolver_assignments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "privacy"."dsr_responses" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "privacy"."dsr_substantive_decisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "privacy"."dsr_verifications" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "privacy"."owner_contributions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "privacy"."privacy_representations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "privacy"."processing_interventions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "privacy"."temporary_dsr_exports" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "privacy_applicability_policies_immutable"
BEFORE UPDATE OR DELETE ON "privacy"."applicability_policies"
FOR EACH ROW EXECUTE FUNCTION "privacy"."reject_immutable_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "privacy_dsr_deadlines_immutable"
BEFORE UPDATE OR DELETE ON "privacy"."dsr_deadlines"
FOR EACH ROW EXECUTE FUNCTION "privacy"."reject_immutable_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "privacy_dsr_delivery_evidence_immutable"
BEFORE UPDATE OR DELETE ON "privacy"."dsr_delivery_evidence"
FOR EACH ROW EXECUTE FUNCTION "privacy"."reject_immutable_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "privacy_dsr_resolver_assignments_immutable"
BEFORE UPDATE OR DELETE ON "privacy"."dsr_resolver_assignments"
FOR EACH ROW EXECUTE FUNCTION "privacy"."reject_immutable_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "privacy_dsr_responses_immutable"
BEFORE UPDATE OR DELETE ON "privacy"."dsr_responses"
FOR EACH ROW EXECUTE FUNCTION "privacy"."reject_immutable_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "privacy_dsr_substantive_decisions_immutable"
BEFORE UPDATE OR DELETE ON "privacy"."dsr_substantive_decisions"
FOR EACH ROW EXECUTE FUNCTION "privacy"."reject_immutable_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "privacy_dsr_verifications_immutable"
BEFORE UPDATE OR DELETE ON "privacy"."dsr_verifications"
FOR EACH ROW EXECUTE FUNCTION "privacy"."reject_immutable_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "privacy_owner_contributions_immutable"
BEFORE UPDATE OR DELETE ON "privacy"."owner_contributions"
FOR EACH ROW EXECUTE FUNCTION "privacy"."reject_immutable_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "privacy_representations_immutable"
BEFORE UPDATE OR DELETE ON "privacy"."privacy_representations"
FOR EACH ROW EXECUTE FUNCTION "privacy"."reject_immutable_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "privacy_processing_interventions_immutable"
BEFORE UPDATE OR DELETE ON "privacy"."processing_interventions"
FOR EACH ROW EXECUTE FUNCTION "privacy"."reject_immutable_ledger_mutation"();
--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE
  "privacy"."applicability_policies",
  "privacy"."dsr_deadlines",
  "privacy"."dsr_delivery_evidence",
  "privacy"."dsr_resolver_assignments",
  "privacy"."dsr_responses",
  "privacy"."dsr_substantive_decisions",
  "privacy"."dsr_verifications",
  "privacy"."owner_contributions",
  "privacy"."privacy_representations",
  "privacy"."processing_interventions"
FROM "ontos_runtime";
